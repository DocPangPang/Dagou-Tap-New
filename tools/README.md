# 开发与音高验证工具

此目录不参与网页运行，发布或打包时可以整体排除。

`analyze_pitch.py` 会：

1. 使用逐帧 YIN 检测 `audio/da.wav`、`gou.wav`、`jiao.wav`；
2. 从高能量、高置信度有声帧计算参考基频；
3. 为每个按键生成固定的 A 小调五声音阶目标；
4. 第三档使用最接近对应原声的五声音阶音，而非不变调原音；
5. 对所有档位实际重采样后重新检测音高；
6. 将报告和可选试听 WAV 写入 `tools/tmp/`。

运行：

```powershell
python tools/analyze_pitch.py --write-wavs
node tools/verify_runtime_mapping.mjs
```

第二条命令会直接提取并执行 `main.js` 中的实际映射函数，对照分析报告检查
全部固定按键，并确认第三列/第三行使用最接近原声的 A 小调五声音阶音。

依赖 Python 3 与 NumPy。所有报告、调试数据和临时音频必须放在
`tools/tmp/`，不要让生产页面依赖这里的任何文件。
