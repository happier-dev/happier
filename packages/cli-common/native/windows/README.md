# Happier Windows service launcher

`service-launcher.cpp` is the native, windowless launcher used by Happier's
current-user Scheduled Tasks. It is a release-time artifact: installed clients
must never compile it at runtime.

On a Windows x64 host with the Visual Studio C++ workload available, build it
from the repository root with:

```powershell
node scripts/pipeline/release/build-windows-service-launcher.mjs
```

The build writes
`packages/cli-common/native/windows/bin/windows-x64/happier-service-launcher.exe`
and rejects artifacts that are not x64 PE32+ GUI executables. Run the isolated
process-lifecycle checks with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File packages/cli-common/native/windows/service-launcher.test.ps1 -LauncherPath packages/cli-common/native/windows/bin/windows-x64/happier-service-launcher.exe
```

The test uses only temporary files and exact PIDs. It does not register tasks,
change startup settings, or stop processes by name or port.
