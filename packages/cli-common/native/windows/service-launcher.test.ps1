param(
  [string]$LauncherPath = (Join-Path $PSScriptRoot 'bin\windows-x64\happier-service-launcher.exe')
)

$ErrorActionPreference = 'Stop'

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function Wait-ForFile([string]$Path, [int]$TimeoutMs = 10000) {
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-Path -LiteralPath $Path) { return }
    Start-Sleep -Milliseconds 50
  }
  throw "Timed out waiting for fixture file: $Path"
}

function Wait-ForExit([int]$ProcessId, [int]$TimeoutMs = 10000) {
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
  while ([DateTime]::UtcNow -lt $deadline) {
    if ($null -eq (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return }
    Start-Sleep -Milliseconds 50
  }
  throw "Timed out waiting for process $ProcessId to exit"
}

function Start-Launcher([string]$WrapperPath, [string]$LogPath) {
  Start-Process -FilePath $LauncherPath -ArgumentList @(
    '--wrapper',
    ('"{0}"' -f $WrapperPath.Replace('"', '\"')),
    '--diagnostic-log',
    ('"{0}"' -f $LogPath.Replace('"', '\"'))
  ) -PassThru -WindowStyle Hidden
}

if (-not (Test-Path -LiteralPath $LauncherPath -PathType Leaf)) {
  throw "Compiled Windows service launcher is missing: $LauncherPath"
}

$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('happier launcher & '' $ ` fixture {0} ü' -f [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
$ownedProcessIds = [Collections.Generic.HashSet[int]]::new()

try {
  $missingRun = Start-Launcher (Join-Path $fixtureRoot 'missing wrapper.ps1') (Join-Path $fixtureRoot 'missing.launcher.log')
  $missingRun.WaitForExit(10000) | Out-Null
  Assert-True ($missingRun.ExitCode -eq 11) "Expected missing-wrapper exit 11, got $($missingRun.ExitCode)"
  $missingDiagnostics = Get-Content -LiteralPath (Join-Path $fixtureRoot 'missing.launcher.log') -Raw
  Assert-True ($missingDiagnostics -match 'stage=validate_wrapper message=failed') 'Missing-wrapper diagnostics omitted the failure stage'

  $deniedWrapper = Join-Path $fixtureRoot 'denied log wrapper.ps1'
  Set-Content -LiteralPath $deniedWrapper -Encoding UTF8 -Value 'exit 0'
  $deniedRun = Start-Launcher $deniedWrapper $fixtureRoot
  $deniedRun.WaitForExit(10000) | Out-Null
  Assert-True ($deniedRun.ExitCode -eq 12) "Expected denied-log exit 12, got $($deniedRun.ExitCode)"

  $exitWrapper = Join-Path $fixtureRoot 'exit code 37.ps1'
  $exitLog = Join-Path $fixtureRoot 'exit code.launcher.log'
  Set-Content -LiteralPath $exitWrapper -Encoding UTF8 -Value @'
[Console]::Error.WriteLine('synthetic warning')
1..10000 | ForEach-Object { [Console]::Out.WriteLine('discarded output ' + $_) }
exit 37
'@
  $exitRun = Start-Launcher $exitWrapper $exitLog
  $exitRun.WaitForExit(10000) | Out-Null
  Assert-True $exitRun.HasExited 'Launcher did not exit with its wrapper'
  Assert-True ($exitRun.ExitCode -eq 37) "Expected wrapper exit 37, got $($exitRun.ExitCode)"
  $exitDiagnostics = Get-Content -LiteralPath $exitLog -Raw
  Assert-True ($exitDiagnostics -match 'wrapper_pid=\d+') 'Launcher diagnostics omitted wrapper PID'
  Assert-True ($exitDiagnostics -match 'wrapper_creation_filetime=\d+') 'Launcher diagnostics omitted wrapper creation time'
  Assert-True ($exitDiagnostics -match 'child_exit=37') 'Launcher diagnostics omitted exact wrapper exit'

  # HAPPIER_HOME_DIR may name a network home. Use the runner's existing local
  # administrative share so the same real fixture executes through a UNC path.
  $uncWrapper = '\\localhost\' + $exitWrapper.Substring(0, 1) + '$' + $exitWrapper.Substring(2)
  $uncLog = '\\localhost\' + $fixtureRoot.Substring(0, 1) + '$' + $fixtureRoot.Substring(2) + '\unc.launcher.log'
  Assert-True (Test-Path -LiteralPath $uncWrapper -PathType Leaf) 'UNC fixture requires the local administrative drive share'
  $uncRun = Start-Launcher $uncWrapper $uncLog
  $ownedProcessIds.Add($uncRun.Id) | Out-Null
  $uncRun.WaitForExit(10000) | Out-Null
  Assert-True ($uncRun.HasExited -and $uncRun.ExitCode -eq 37) "Expected UNC wrapper exit 37, got $($uncRun.ExitCode)"
  $ownedProcessIds.Remove($uncRun.Id) | Out-Null
  $uncDiagnostics = Get-Content -LiteralPath (Join-Path $fixtureRoot 'unc.launcher.log') -Raw
  Assert-True ($uncDiagnostics -match 'child_exit=37') 'UNC service home did not retain wrapper exit diagnostics'

  foreach ($extendedWrapper in @(('\\?\' + $exitWrapper), ('\\?\UNC\' + $uncWrapper.Substring(2)))) {
    $extendedLog = Join-Path $fixtureRoot ('extended-' + [Guid]::NewGuid().ToString('N') + '.launcher.log')
    $extendedRun = Start-Launcher $extendedWrapper ('\\?\' + $extendedLog)
    $ownedProcessIds.Add($extendedRun.Id) | Out-Null
    $extendedRun.WaitForExit(10000) | Out-Null
    Assert-True ($extendedRun.HasExited -and $extendedRun.ExitCode -eq 37) "Expected extended-path wrapper exit 37, got $($extendedRun.ExitCode)"
    $ownedProcessIds.Remove($extendedRun.Id) | Out-Null
    Assert-True ((Get-Content -LiteralPath $extendedLog -Raw) -match 'child_exit=37') 'Extended-path service home omitted wrapper exit diagnostics'
  }

  foreach ($invalidWrapper in @('relative.ps1', 'C:relative.ps1', '\root-relative.ps1', '\\.\NUL', '\\?\GLOBALROOT\Device\NUL')) {
    $invalidRun = Start-Launcher $invalidWrapper (Join-Path $fixtureRoot 'invalid.launcher.log')
    $invalidRun.WaitForExit(10000) | Out-Null
    Assert-True ($invalidRun.HasExited -and $invalidRun.ExitCode -eq 10) "Expected invalid file path exit 10, got $($invalidRun.ExitCode)"
  }

  # A console-subsystem wrapper and its console descendant must run without a
  # console window. This is synthetic evidence only, not desktop flash/taskbar proof.
  $consoleProbePath = Join-Path $fixtureRoot 'console-window.txt'
  $consoleProbeScript = Join-Path $fixtureRoot 'console probe.ps1'
  $consoleWrapper = Join-Path $fixtureRoot 'console window probe.ps1'
  $consoleLog = Join-Path $fixtureRoot 'console.launcher.log'
  Set-Content -LiteralPath $consoleProbeScript -Encoding UTF8 -Value @'
param([string]$Out)
Add-Type -Namespace HappierLauncherTest -Name ConsoleProbe -MemberDefinition '[DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow();'
Add-Content -LiteralPath $Out -Value ([int64][HappierLauncherTest.ConsoleProbe]::GetConsoleWindow())
'@
  $quotedProbeScript = "'{0}'" -f $consoleProbeScript.Replace("'", "''")
  $quotedProbePath = "'{0}'" -f $consoleProbePath.Replace("'", "''")
  Set-Content -LiteralPath $consoleWrapper -Encoding UTF8 -Value @"
& $quotedProbeScript -Out $quotedProbePath
& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $quotedProbeScript -Out $quotedProbePath
exit `$LASTEXITCODE
"@
  $consoleRun = Start-Launcher $consoleWrapper $consoleLog
  $consoleRun.WaitForExit(30000) | Out-Null
  Assert-True ($consoleRun.HasExited -and $consoleRun.ExitCode -eq 0) "Console probe launcher failed with exit $($consoleRun.ExitCode)"
  $consoleWindows = @(Get-Content -LiteralPath $consoleProbePath)
  Assert-True ($consoleWindows.Count -eq 2) "Expected wrapper and descendant console probes, got $($consoleWindows.Count)"
  Assert-True (@($consoleWindows | Where-Object { $_ -ne '0' }).Count -eq 0) "Wrapper chain received a console window: $($consoleWindows -join ',')"

  # Task Scheduler may already contain the launcher in a job; the launcher's
  # private job must nest inside it rather than failing assignment.
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class HappierLauncherJobFixture {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr handle);
}
'@
  $nestedGoPath = Join-Path $fixtureRoot 'nested.go'
  $nestedExitPath = Join-Path $fixtureRoot 'nested.exit'
  $nestedLog = Join-Path $fixtureRoot 'nested.launcher.log'
  $nestedParentScript = Join-Path $fixtureRoot 'nested parent.ps1'
  Set-Content -LiteralPath $nestedParentScript -Encoding UTF8 -Value @'
param([string]$Launcher, [string]$Wrapper, [string]$Log, [string]$Go, [string]$ExitPath)
while (-not (Test-Path -LiteralPath $Go)) { Start-Sleep -Milliseconds 50 }
$run = Start-Process -FilePath $Launcher -ArgumentList @('--wrapper', ('"{0}"' -f $Wrapper), '--diagnostic-log', ('"{0}"' -f $Log)) -PassThru -Wait
Set-Content -LiteralPath $ExitPath -Value $run.ExitCode
'@
  $outerJob = [HappierLauncherJobFixture]::CreateJobObject([IntPtr]::Zero, $null)
  Assert-True ($outerJob -ne [IntPtr]::Zero) 'Could not create the outer fixture job'
  try {
    $nestedParent = Start-Process -FilePath powershell.exe -ArgumentList @(
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $nestedParentScript),
      '-Launcher', ('"{0}"' -f $LauncherPath), '-Wrapper', ('"{0}"' -f $exitWrapper),
      '-Log', ('"{0}"' -f $nestedLog), '-Go', ('"{0}"' -f $nestedGoPath), '-ExitPath', ('"{0}"' -f $nestedExitPath)
    ) -PassThru -WindowStyle Hidden
    $ownedProcessIds.Add($nestedParent.Id) | Out-Null
    Assert-True ([HappierLauncherJobFixture]::AssignProcessToJobObject($outerJob, $nestedParent.Handle)) 'Could not assign the fixture parent to the outer job'
    Set-Content -LiteralPath $nestedGoPath -Value 'go'
    Wait-ForFile $nestedExitPath 30000
    Wait-ForExit $nestedParent.Id
    $ownedProcessIds.Remove($nestedParent.Id) | Out-Null
  } finally {
    [HappierLauncherJobFixture]::CloseHandle($outerJob) | Out-Null
  }
  $nestedExit = (Get-Content -LiteralPath $nestedExitPath -Raw).Trim()
  Assert-True ($nestedExit -eq '37') "Expected nested-job wrapper exit 37, got $nestedExit"
  Assert-True (-not ((Get-Content -LiteralPath $nestedLog -Raw) -match 'stage=assign_job')) 'Launcher failed to assign its job inside an outer job'

  # The wrapper may inherit only the launcher's NUL standard handles. A test-owned
  # parent holds an inheritable pipe write end (the marker) and starts the process
  # under test with bInheritHandles=TRUE; the wrapper writes "LEAK" to that exact
  # handle value if it received it. A direct PowerShell child is the control.
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class HappierLauncherHandleMarker {
  [StructLayout(LayoutKind.Sequential)]
  struct SecurityAttributes { public int nLength; public IntPtr lpSecurityDescriptor; public int bInheritHandle; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct StartupInfo {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct ProcessInformation { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SecurityAttributes sa, int size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetHandleInformation(IntPtr handle, int mask, int flags);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit,
    int flags, IntPtr env, string cwd, ref StartupInfo si, out ProcessInformation pi);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern int WaitForSingleObject(IntPtr handle, int ms);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetExitCodeProcess(IntPtr handle, out int code);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool PeekNamedPipe(IntPtr pipe, IntPtr buf, int size, IntPtr read, out int avail, IntPtr left);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool ReadFile(IntPtr handle, byte[] buf, int size, out int read, IntPtr overlapped);

  // Returns "exit=<code> pipeClosed=<bool> data=<bytes the process tree wrote to the marker>".
  public static string Run(string app, string commandLine, int timeoutMs) {
    var sa = new SecurityAttributes();
    sa.nLength = Marshal.SizeOf(sa);
    sa.bInheritHandle = 1;
    IntPtr read, write;
    if (!CreatePipe(out read, out write, ref sa, 0)) throw new Exception("CreatePipe failed " + Marshal.GetLastWin32Error());
    SetHandleInformation(read, 1, 0);
    Environment.SetEnvironmentVariable("HAPPIER_MARKER_HANDLE", write.ToInt64().ToString());
    var si = new StartupInfo();
    si.cb = Marshal.SizeOf(si);
    ProcessInformation pi;
    if (!CreateProcessW(app, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true,
        0x08000000, IntPtr.Zero, null, ref si, out pi)) {
      int error = Marshal.GetLastWin32Error();
      CloseHandle(read); CloseHandle(write);
      throw new Exception("CreateProcess failed " + error);
    }
    CloseHandle(write);
    CloseHandle(pi.hThread);
    if (WaitForSingleObject(pi.hProcess, timeoutMs) != 0) { CloseHandle(pi.hProcess); CloseHandle(read); throw new Exception("process under test timed out"); }
    int exitCode; GetExitCodeProcess(pi.hProcess, out exitCode); CloseHandle(pi.hProcess);
    var data = new StringBuilder();
    bool closed = false;
    var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
    var buffer = new byte[256];
    while (DateTime.UtcNow < deadline) {
      int avail;
      if (!PeekNamedPipe(read, IntPtr.Zero, 0, IntPtr.Zero, out avail, IntPtr.Zero)) {
        closed = Marshal.GetLastWin32Error() == 109;
        break;
      }
      if (avail > 0) { int n; ReadFile(read, buffer, buffer.Length, out n, IntPtr.Zero); data.Append(Encoding.ASCII.GetString(buffer, 0, n)); }
      else Thread.Sleep(50);
    }
    CloseHandle(read);
    return "exit=" + exitCode + " pipeClosed=" + closed + " data=" + data;
  }
}
'@
  $markerWrapper = Join-Path $fixtureRoot 'handle marker probe.ps1'
  Set-Content -LiteralPath $markerWrapper -Encoding UTF8 -Value @'
try {
  $safe = New-Object Microsoft.Win32.SafeHandles.SafeFileHandle([IntPtr][Int64]$env:HAPPIER_MARKER_HANDLE, $false)
  $stream = New-Object System.IO.FileStream($safe, [System.IO.FileAccess]::Write)
  $bytes = [Text.Encoding]::ASCII.GetBytes('LEAK')
  $stream.Write($bytes, 0, $bytes.Length)
  $stream.Flush()
} catch {
}
exit 0
'@
  $windowsPowerShell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $markerControl = [HappierLauncherHandleMarker]::Run($windowsPowerShell,
    ('"{0}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{1}"' -f $windowsPowerShell, $markerWrapper), 30000)
  Assert-True ($markerControl -match '^exit=0 pipeClosed=True data=LEAK$') "Handle marker control did not observe an inherited marker: $markerControl"
  $markerLauncher = [HappierLauncherHandleMarker]::Run($LauncherPath,
    ('"{0}" --wrapper "{1}" --diagnostic-log "{2}"' -f $LauncherPath, $markerWrapper, (Join-Path $fixtureRoot 'marker.launcher.log')), 30000)
  Assert-True ($markerLauncher -match '^exit=0 pipeClosed=True data=$') "Launcher passed an inheritable non-standard handle to the wrapper: $markerLauncher"

  $rapidRuns = 1..4 | ForEach-Object {
    Start-Launcher $deniedWrapper (Join-Path $fixtureRoot ("rapid-$_.launcher.log"))
  }
  foreach ($rapidRun in $rapidRuns) {
    $rapidRun.WaitForExit(10000) | Out-Null
    Assert-True ($rapidRun.HasExited -and $rapidRun.ExitCode -eq 0) 'A rapid launcher start did not exit cleanly'
  }

  $normalChildPidPath = Join-Path $fixtureRoot 'normal-child.pid'
  $normalWrapper = Join-Path $fixtureRoot 'normal descendant.ps1'
  $normalLog = Join-Path $fixtureRoot 'normal.launcher.log'
  Set-Content -LiteralPath $normalWrapper -Encoding UTF8 -Value @"
`$child = Start-Process -FilePath powershell.exe -ArgumentList @('-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 30') -PassThru -WindowStyle Hidden
Set-Content -LiteralPath '$($normalChildPidPath.Replace("'", "''"))' -Value `$child.Id
exit 0
"@
  $normalRun = Start-Launcher $normalWrapper $normalLog
  $normalRun.WaitForExit(10000) | Out-Null
  Assert-True $normalRun.HasExited 'Launcher did not observe a normal wrapper exit'
  Wait-ForFile $normalChildPidPath
  $normalChildPid = [int](Get-Content -LiteralPath $normalChildPidPath -Raw)
  $ownedProcessIds.Add($normalChildPid) | Out-Null
  Assert-True ($null -ne (Get-Process -Id $normalChildPid -ErrorAction SilentlyContinue)) 'Normal wrapper exit killed a retained descendant'
  Stop-Process -Id $normalChildPid -Force
  Wait-ForExit $normalChildPid
  $ownedProcessIds.Remove($normalChildPid) | Out-Null

  $forcedWrapperPidPath = Join-Path $fixtureRoot 'forced-wrapper.pid'
  $forcedChildPidPath = Join-Path $fixtureRoot 'forced-child.pid'
  $forcedWrapper = Join-Path $fixtureRoot 'forced termination.ps1'
  $forcedLog = Join-Path $fixtureRoot 'forced.launcher.log'
  $unrelated = Start-Process -FilePath powershell.exe -ArgumentList @('-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 30') -PassThru -WindowStyle Hidden
  $ownedProcessIds.Add($unrelated.Id) | Out-Null
  Set-Content -LiteralPath $forcedWrapper -Encoding UTF8 -Value @"
Set-Content -LiteralPath '$($forcedWrapperPidPath.Replace("'", "''"))' -Value `$PID
`$child = Start-Process -FilePath powershell.exe -ArgumentList @('-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 30') -PassThru -WindowStyle Hidden
Set-Content -LiteralPath '$($forcedChildPidPath.Replace("'", "''"))' -Value `$child.Id
Start-Sleep -Seconds 30
"@
  $forcedRun = Start-Launcher $forcedWrapper $forcedLog
  $ownedProcessIds.Add($forcedRun.Id) | Out-Null
  Wait-ForFile $forcedWrapperPidPath
  Wait-ForFile $forcedChildPidPath
  $forcedWrapperPid = [int](Get-Content -LiteralPath $forcedWrapperPidPath -Raw)
  $forcedChildPid = [int](Get-Content -LiteralPath $forcedChildPidPath -Raw)
  $ownedProcessIds.Add($forcedWrapperPid) | Out-Null
  $ownedProcessIds.Add($forcedChildPid) | Out-Null
  Stop-Process -Id $forcedRun.Id -Force
  Wait-ForExit $forcedRun.Id
  Wait-ForExit $forcedWrapperPid
  Wait-ForExit $forcedChildPid
  Assert-True ($null -ne (Get-Process -Id $unrelated.Id -ErrorAction SilentlyContinue)) 'Forced launcher stop killed an unrelated process'
  Stop-Process -Id $unrelated.Id -Force
  Wait-ForExit $unrelated.Id
  $ownedProcessIds.Remove($forcedRun.Id) | Out-Null
  $ownedProcessIds.Remove($forcedWrapperPid) | Out-Null
  $ownedProcessIds.Remove($forcedChildPid) | Out-Null
  $ownedProcessIds.Remove($unrelated.Id) | Out-Null

  Write-Output 'Windows service launcher synthetic lifecycle tests passed.'
} finally {
  foreach ($ownedProcessId in @($ownedProcessIds)) {
    Stop-Process -Id $ownedProcessId -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction SilentlyContinue
}
