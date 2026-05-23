param()

$ErrorActionPreference = "Stop"

$runStartedAt = [DateTime]::UtcNow
$runId = "l59-clean-wave-" + $runStartedAt.ToString("yyyyMMdd-HHmmss")

$UserHome = "C:\Users\test_qa"
$DefaultHome = Join-Path $UserHome ".happier"
$AltHome = Join-Path $UserHome ".happier-l21-alt"
$QaRoot = Join-Path $UserHome "happier-qa"
$QaHelper = Join-Path $UserHome "windows_qa_helper.ps1"
$PinnedArchive = Join-Path $UserHome "happier-local-assets-preview\happier-v0.2.8-windows-x64.tar.gz"
$LegacyArchive = Join-Path $UserHome "happier-local-assets-preview\happier-v0.2.2-preview.1775586717.26498-windows-x64.tar.gz"
$LegacyPayloadRoot = "C:\hq\l18preview\payload\happier-v0.2.2-preview.1775586717.26498-windows-x64"
$LegacyVersion = "0.2.2-preview.1775586717.26498"
$CandidateVersion = "0.2.8"
$DefaultTask = "Happier\happier-daemon.default"
$CandidateExe = Join-Path $DefaultHome "cli-preview\versions\0.2.8\happier.exe"
$HprevExe = Join-Path $DefaultHome "bin\hprev.exe"
$LegacyExe = Join-Path $LegacyPayloadRoot "happier.exe"
$DefaultServiceOut = Join-Path $DefaultHome "logs\daemon-service.default.out.log"
$DefaultServiceErr = Join-Path $DefaultHome "logs\daemon-service.default.err.log"

$run = [ordered]@{
    runId = $runId
    startedAtUtc = $runStartedAt.ToString("o")
    host = $env:COMPUTERNAME
    user = $env:USERNAME
    cwd = (Get-Location).Path
    config = [ordered]@{
        userHome = $UserHome
        defaultHome = $DefaultHome
        altHome = $AltHome
        qaHelper = $QaHelper
        pinnedArchive = $PinnedArchive
        legacyArchive = $LegacyArchive
        legacyPayloadRoot = $LegacyPayloadRoot
        candidateVersion = $CandidateVersion
        legacyVersion = $LegacyVersion
    }
    stages = @()
    rowMatrix = @()
}

function Write-StageLine {
    param(
        [Parameter(Mandatory = $true)][string] $Text
    )
    $ts = (Get-Date).ToString("o")
    Write-Host ("[{0}] {1}" -f $ts, $Text)
}

function Get-CimProcessesSafe {
    param(
        [string] $Filter = "",
        [int] $TimeoutSeconds = 20
    )

    try {
        if ($Filter) {
            return @(Get-CimInstance Win32_Process -Filter $Filter -OperationTimeoutSec $TimeoutSeconds -ErrorAction Stop)
        }
        return @(Get-CimInstance Win32_Process -OperationTimeoutSec $TimeoutSeconds -ErrorAction Stop)
    } catch {
        Write-StageLine ("WMI process query failed or timed out: {0}" -f $_.Exception.Message)
        return @()
    }
}

function Normalize-PathNeedle {
    param(
        [string] $Value
    )

    if (-not $Value) {
        return ""
    }
    return ([string]$Value).Trim().Replace('\', '/').ToLowerInvariant()
}

function Read-PathTail {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [int] $Tail = 60
    )
    if (-not (Test-Path -LiteralPath $Path)) {
        return [ordered]@{ exists = $false; path = $Path; tail = @() }
    }
    return [ordered]@{
        exists = $true
        path = $Path
        tail = @(Get-Content -LiteralPath $Path -Tail $Tail -ErrorAction SilentlyContinue)
    }
}

function Get-InterestingProcesses {
    $raw = Get-CimProcessesSafe | Where-Object {
        $_.Name -in @("happier.exe", "hprev.exe", "hdev.exe", "powershell.exe", "cmd.exe", "node.exe") -or
        ($_.CommandLine -like "*happier*") -or
        ($_.CommandLine -like "*windows_qa_helper.ps1*") -or
        ($_.CommandLine -like "*__install-payload*")
    }
    return @($raw | ForEach-Object {
        [ordered]@{
            pid = $_.ProcessId
            name = $_.Name
            parentPid = $_.ParentProcessId
            commandLine = $_.CommandLine
            executablePath = $_.ExecutablePath
        }
    })
}

function Get-TaskSnapshot {
    $taskOutput = @()
    $taskRc = 0
    try {
        $taskOutput = &(schtasks.exe) /query /tn $DefaultTask /fo LIST /v 2>&1
    } catch {
        $taskRc = 1
        $taskOutput = @($_.Exception.Message)
    }
    return [ordered]@{
        taskName = $DefaultTask
        rc = $taskRc
        output = @($taskOutput)
    }
}

function Get-HomeSnapshot {
    $versionsRoot = Join-Path $DefaultHome "cli-preview\versions"
    $bakDirs = @()
    if (Test-Path -LiteralPath $versionsRoot) {
        $bakDirs = @(Get-ChildItem -LiteralPath $versionsRoot -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like ".0.2.8.bak-*" } | Select-Object -ExpandProperty FullName)
    }
    return [ordered]@{
        defaultHomeExists = (Test-Path -LiteralPath $DefaultHome)
        altHomeExists = (Test-Path -LiteralPath $AltHome)
        versionsRoot = $versionsRoot
        bakDirectories = @($bakDirs)
        candidateExeExists = (Test-Path -LiteralPath $CandidateExe)
        hprevExeExists = (Test-Path -LiteralPath $HprevExe)
        legacyExeExists = (Test-Path -LiteralPath $LegacyExe)
    }
}

function Capture-Snapshot {
    param(
        [Parameter(Mandatory = $true)][string] $StageId,
        [Parameter(Mandatory = $true)][string] $When
    )
    return [ordered]@{
        stage = $StageId
        when = $When
        capturedAtUtc = [DateTime]::UtcNow.ToString("o")
        processSnapshot = Get-InterestingProcesses
        taskSnapshot = Get-TaskSnapshot
        homeSnapshot = Get-HomeSnapshot
        daemonServiceOut = Read-PathTail -Path $DefaultServiceOut -Tail 40
        daemonServiceErr = Read-PathTail -Path $DefaultServiceErr -Tail 40
        daemonLogs = @(
            Get-ChildItem -LiteralPath (Join-Path $DefaultHome "logs") -File -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime -Descending |
                Select-Object -First 8 |
                ForEach-Object {
                    [ordered]@{
                        name = $_.Name
                        fullName = $_.FullName
                        lastWriteTimeUtc = $_.LastWriteTimeUtc.ToString("o")
                        length = $_.Length
                    }
                }
        )
    }
}

function Invoke-External {
    param(
        [Parameter(Mandatory = $true)][string] $FilePath,
        [Parameter(Mandatory = $true)][string[]] $Arguments,
        [int] $TimeoutSeconds = 120
    )
    $resolved = $null
    $isPathLike = ($FilePath -like "*\*") -or ($FilePath -like "*/*") -or [System.IO.Path]::IsPathRooted($FilePath)
    if ($isPathLike) {
        if (-not (Test-Path -LiteralPath $FilePath)) {
            return [ordered]@{
                file = $FilePath
                args = @($Arguments)
                timeoutSeconds = $TimeoutSeconds
                startedAtUtc = [DateTime]::UtcNow.ToString("o")
                endedAtUtc = [DateTime]::UtcNow.ToString("o")
                durationSeconds = 0
                timedOut = $false
                rc = 127
                stdout = @()
                stderr = @("FILE_NOT_FOUND: $FilePath")
            }
        }
    } else {
        $resolved = Get-Command $FilePath -ErrorAction SilentlyContinue
        if ($null -eq $resolved) {
            return [ordered]@{
                file = $FilePath
                args = @($Arguments)
                timeoutSeconds = $TimeoutSeconds
                startedAtUtc = [DateTime]::UtcNow.ToString("o")
                endedAtUtc = [DateTime]::UtcNow.ToString("o")
                durationSeconds = 0
                timedOut = $false
                rc = 127
                stdout = @()
                stderr = @("COMMAND_NOT_FOUND: $FilePath")
            }
        }
    }

    $stdoutFile = [System.IO.Path]::GetTempFileName()
    $stderrFile = [System.IO.Path]::GetTempFileName()
    $startedAt = [DateTime]::UtcNow
    $timedOut = $false
    $exitCode = 0
    $stdout = @()
    $stderr = @()
    function Stop-ProcessTree {
        param([int] $RootPid)
        try {
            $children = @(Get-CimProcessesSafe | Where-Object { $_.ParentProcessId -eq $RootPid })
            foreach ($child in $children) {
                Stop-ProcessTree -RootPid $child.ProcessId
            }
        } catch {}
        try {
            Stop-Process -Id $RootPid -Force -ErrorAction SilentlyContinue
        } catch {}
    }

    try {
        $proc = Start-Process -FilePath $FilePath -ArgumentList $Arguments -NoNewWindow -PassThru -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile
        if (-not $proc.WaitForExit($TimeoutSeconds * 1000)) {
            $timedOut = $true
            Stop-ProcessTree -RootPid $proc.Id
            $exitCode = 142
        } else {
            $exitCode = $proc.ExitCode
        }
        $stdout = @(Get-Content -LiteralPath $stdoutFile -ErrorAction SilentlyContinue)
        $stderr = @(Get-Content -LiteralPath $stderrFile -ErrorAction SilentlyContinue)
    } finally {
        Remove-Item -LiteralPath $stdoutFile -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $stderrFile -ErrorAction SilentlyContinue
    }
    $endedAt = [DateTime]::UtcNow
    return [ordered]@{
        file = $FilePath
        args = @($Arguments)
        timeoutSeconds = $TimeoutSeconds
        startedAtUtc = $startedAt.ToString("o")
        endedAtUtc = $endedAt.ToString("o")
        durationSeconds = [Math]::Round(($endedAt - $startedAt).TotalSeconds, 3)
        timedOut = $timedOut
        rc = $exitCode
        stdout = @($stdout)
        stderr = @($stderr)
    }
}

function Invoke-RowCommand {
    param(
        [Parameter(Mandatory = $true)][string] $RowId,
        [Parameter(Mandatory = $true)][string] $Label,
        [Parameter(Mandatory = $true)][string] $FilePath,
        [Parameter(Mandatory = $true)][string[]] $Arguments,
        [int] $TimeoutSeconds = 120
    )
    Write-StageLine ("[{0}] {1}" -f $RowId, $Label)
    $result = Invoke-External -FilePath $FilePath -Arguments $Arguments -TimeoutSeconds $TimeoutSeconds
    Write-Host ("[RC] {0}" -f $result.rc)
    if ($result.timedOut) {
        Write-Host ("TIMEOUT_AFTER_SECONDS={0}" -f $TimeoutSeconds)
    }
    foreach ($line in $result.stdout) { Write-Host $line }
    foreach ($line in $result.stderr) { Write-Host $line }
    return [ordered]@{
        rowId = $RowId
        label = $Label
        rc = $result.rc
        timedOut = $result.timedOut
        result = $result
    }
}

function Resolve-InstallerRowTimeoutSeconds {
    param(
        [Parameter(Mandatory = $true)][int] $DefaultSeconds
    )

    $raw = [string]$env:HAPPIER_WINDOWS_CLEAN_WAVE_INSTALL_TIMEOUT_SECONDS
    if (-not $raw) {
        return $DefaultSeconds
    }

    $parsed = 0
    if (-not [int]::TryParse($raw.Trim(), [ref]$parsed)) {
        return $DefaultSeconds
    }
    if ($parsed -lt 120) {
        return 120
    }
    if ($parsed -gt 1800) {
        return 1800
    }
    return $parsed
}

function Invoke-InstallerHolderPreflightCleanup {
    param(
        [Parameter(Mandatory = $true)][string] $RowId,
        [Parameter(Mandatory = $true)][string] $Label
    )

    $needles = @(
        (Normalize-PathNeedle -Value $DefaultHome),
        "/happier-installers-smoke-",
        "/happier-install-",
        "windows_qa_helper.ps1",
        "__install-payload"
    )

    $killed = New-Object System.Collections.Generic.List[string]
    $stale = @(Get-CimProcessesSafe -Filter "Name='happier.exe' OR Name='hprev.exe' OR Name='hdev.exe' OR Name='powershell.exe'")
    foreach ($proc in $stale) {
        $searchText = ("{0} {1}" -f (Normalize-PathNeedle -Value ([string]$proc.CommandLine)), (Normalize-PathNeedle -Value ([string]$proc.ExecutablePath)))
        $isMatch = $false
        foreach ($needle in $needles) {
            if ($needle -and $searchText.Contains($needle)) {
                $isMatch = $true
                break
            }
        }
        if (-not $isMatch) {
            continue
        }

        try {
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
            $killed.Add("{0}:{1}" -f $proc.ProcessId, $proc.Name)
        } catch {
            Write-Host ("[{0}] preflight-stop-failed pid={1} reason={2}" -f $RowId, $proc.ProcessId, $_.Exception.Message)
        }
    }

    $versionsRoot = Join-Path $DefaultHome "cli-preview\versions"
    $removedBak = New-Object System.Collections.Generic.List[string]
    if (Test-Path -LiteralPath $versionsRoot) {
        $bakDirs = @(Get-ChildItem -LiteralPath $versionsRoot -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like ".0.2.8.bak-*" })
        foreach ($dir in $bakDirs) {
            $removeResult = Remove-DirectoryTreeBestEffort -Path $dir.FullName
            if ($removeResult.removed) {
                $removedBak.Add($dir.Name)
            } else {
                Write-Host ("[{0}] preflight-bak-remove-failed path={1} reason={2}" -f $RowId, $dir.FullName, $removeResult.error)
            }
        }
    }

    Write-Host ("[{0}] PRE-INSTALL-HYGIENE label='{1}' killed={2} bakRemoved={3}" -f $RowId, $Label, $killed.Count, $removedBak.Count)
    if ($killed.Count -gt 0) {
        Write-Host ("[{0}] PRE-INSTALL-HYGIENE-KILLED {1}" -f $RowId, ($killed -join ","))
    }
    if ($removedBak.Count -gt 0) {
        Write-Host ("[{0}] PRE-INSTALL-HYGIENE-BAK {1}" -f $RowId, ($removedBak -join ","))
    }
}

function Get-InstallerTimeoutDiagnostics {
    param(
        [Parameter(Mandatory = $true)][string] $RowId
    )

    $diagnostics = [ordered]@{
        rowId = $RowId
        capturedAtUtc = [DateTime]::UtcNow.ToString("o")
        holders = @()
        bakDirs = @()
        tasklist = @()
    }

    $diagnostics.holders = @(
        Get-CimProcessesSafe -Filter "Name='happier.exe' OR Name='hprev.exe' OR Name='hdev.exe' OR Name='powershell.exe'" |
            Where-Object {
                $_.CommandLine -like "*__install-payload*" -or
                $_.CommandLine -like "*windows_qa_helper.ps1*" -or
                $_.ExecutablePath -like "*happier-installers-smoke-*"
            } |
            ForEach-Object {
                [ordered]@{
                    pid = $_.ProcessId
                    parentPid = $_.ParentProcessId
                    name = $_.Name
                    executablePath = $_.ExecutablePath
                    commandLine = $_.CommandLine
                }
            }
    )

    $versionsRoot = Join-Path $DefaultHome "cli-preview\versions"
    if (Test-Path -LiteralPath $versionsRoot) {
        $diagnostics.bakDirs = @(
            Get-ChildItem -LiteralPath $versionsRoot -Directory -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -like ".0.2.8.bak-*" } |
                Select-Object -ExpandProperty FullName
        )
    }

    $tasklistResult = Invoke-External -FilePath "cmd.exe" -Arguments @("/d", "/s", "/c", "tasklist /v /fi ""IMAGENAME eq happier.exe""") -TimeoutSeconds 20
    $diagnostics.tasklist = @($tasklistResult.stdout) + @($tasklistResult.stderr)
    if ($tasklistResult.timedOut) {
        $diagnostics.tasklist += "TASKLIST_TIMEOUT=20"
    }
    return $diagnostics
}

function Invoke-InstallerCommandWithPreflight {
    param(
        [Parameter(Mandatory = $true)][string] $RowId,
        [Parameter(Mandatory = $true)][string] $Label,
        [Parameter(Mandatory = $true)][string[]] $Arguments,
        [Parameter(Mandatory = $true)][int] $DefaultSeconds
    )

    Invoke-InstallerHolderPreflightCleanup -RowId $RowId -Label $Label
    $timeoutSeconds = Resolve-InstallerRowTimeoutSeconds -DefaultSeconds $DefaultSeconds
    $result = Invoke-RowCommand -RowId $RowId -Label $Label -FilePath "powershell.exe" -Arguments $Arguments -TimeoutSeconds $timeoutSeconds
    if ($result.timedOut) {
        $timeoutDiagnostics = Get-InstallerTimeoutDiagnostics -RowId $RowId
        $result.timeoutDiagnostics = $timeoutDiagnostics
        Write-Host ("[{0}] TIMEOUT_DIAGNOSTICS holders={1} bakDirs={2}" -f $RowId, @($timeoutDiagnostics.holders).Count, @($timeoutDiagnostics.bakDirs).Count)
        foreach ($line in @($timeoutDiagnostics.tasklist)) {
            Write-Host $line
        }
    }
    return $result
}

function Invoke-RowCommandLine {
    param(
        [Parameter(Mandatory = $true)][string] $RowId,
        [Parameter(Mandatory = $true)][string] $Label,
        [Parameter(Mandatory = $true)][string] $CommandLine,
        [int] $TimeoutSeconds = 120
    )
    return Invoke-RowCommand -RowId $RowId -Label $Label -FilePath "cmd.exe" -Arguments @("/d", "/s", "/c", $CommandLine) -TimeoutSeconds $TimeoutSeconds
}

function Build-Row {
    param(
        [Parameter(Mandatory = $true)][string] $RowId,
        [Parameter(Mandatory = $true)][string] $Description,
        [Parameter(Mandatory = $true)][object[]] $Commands
    )
    $failedCommands = @($Commands | Where-Object { $_.rc -ne 0 })
    return [ordered]@{
        rowId = $RowId
        description = $Description
        status = if ($failedCommands.Count -eq 0) { "PASS" } else { "FAIL" }
        failedCommandCount = $failedCommands.Count
        commands = @($Commands)
    }
}

function Add-Stage {
    param(
        [Parameter(Mandatory = $true)][string] $StageId,
        [Parameter(Mandatory = $true)][string] $Description,
        [Parameter(Mandatory = $true)][scriptblock] $Body
    )
    Write-StageLine ("===== STAGE {0}: {1} =====" -f $StageId, $Description)
    $before = Capture-Snapshot -StageId $StageId -When "before"
    $bodyResult = & $Body
    $after = Capture-Snapshot -StageId $StageId -When "after"
    $stageRecord = [ordered]@{
        stageId = $StageId
        description = $Description
        startedAtUtc = $before.capturedAtUtc
        completedAtUtc = $after.capturedAtUtc
        before = $before
        rows = @($bodyResult.rows)
        notes = @($bodyResult.notes)
        after = $after
    }
    $run.stages += $stageRecord
    if ($bodyResult.rows) {
        $run.rowMatrix += $bodyResult.rows
    }
}

function New-HelperCommand {
    param(
        [Parameter(Mandatory = $true)][string] $Action,
        [string] $ArchivePath = "",
        [string] $PayloadRoot = "",
        [string] $Version = "",
        [string] $Channel = "preview"
    )
    $args = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $QaHelper, "-Action", $Action)
    if ($ArchivePath) { $args += @("-ArchivePath", $ArchivePath) }
    if ($PayloadRoot) { $args += @("-PayloadRoot", $PayloadRoot) }
    if ($Version) { $args += @("-Version", $Version) }
    if ($Channel) { $args += @("-Channel", $Channel) }
    return $args
}

function Convert-CommandRecordToJsonSafe {
    param(
        [Parameter(Mandatory = $true)]$Command
    )

    $stdout = @($Command.result.stdout)
    $stderr = @($Command.result.stderr)
    return [ordered]@{
        rowId = $Command.rowId
        label = $Command.label
        rc = $Command.rc
        timedOut = $Command.timedOut
        timeoutDiagnostics = if ($Command.timeoutDiagnostics) { $Command.timeoutDiagnostics } else { $null }
        startedAtUtc = $Command.result.startedAtUtc
        endedAtUtc = $Command.result.endedAtUtc
        durationSeconds = $Command.result.durationSeconds
        timeoutSeconds = $Command.result.timeoutSeconds
        command = [ordered]@{
            file = $Command.result.file
            args = @($Command.result.args)
        }
        stdoutTail = if ($stdout.Count -gt 30) { @($stdout | Select-Object -Last 30) } else { $stdout }
        stderrTail = if ($stderr.Count -gt 30) { @($stderr | Select-Object -Last 30) } else { $stderr }
    }
}

function Remove-DirectoryTreeBestEffort {
    param(
        [Parameter(Mandatory = $true)][string] $Path
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return [ordered]@{ removed = $true; strategy = "already-missing"; error = $null }
    }

    $errors = New-Object System.Collections.Generic.List[string]
    $rdResult = Invoke-External -FilePath "cmd.exe" -Arguments @("/d", "/s", "/c", "rd /s /q ""$Path""") -TimeoutSeconds 20
    if (($rdResult.rc -eq 0) -and (-not (Test-Path -LiteralPath $Path))) {
        return [ordered]@{ removed = $true; strategy = "cmd-rd"; error = $null }
    }
    if ($rdResult.timedOut) {
        $errors.Add("cmd-rd timeout after 20s")
    } elseif ($rdResult.rc -ne 0) {
        $errors.Add(("cmd-rd rc={0}" -f $rdResult.rc))
    }

    return [ordered]@{
        removed = $false
        strategy = "failed"
        error = ($errors -join " | ")
    }
}

function Invoke-QaExtractRootPreflightCleanup {
    param(
        [string] $RowId = "PREFLIGHT"
    )

    $extractRoot = Join-Path $QaRoot "extract"
    if (-not (Test-Path -LiteralPath $extractRoot)) {
        return [ordered]@{
            extractRoot = $extractRoot
            scanned = 0
            removed = 0
            failed = @()
        }
    }

    $result = Remove-DirectoryTreeBestEffort -Path $extractRoot
    $scanned = 1
    $removed = 0
    $failed = @()
    if ($result.removed) {
        $removed = 1
        New-Item -ItemType Directory -Path $extractRoot -Force | Out-Null
    } else {
        $failed += [ordered]@{
            path = $extractRoot
            error = $result.error
        }
        Write-Host ("[{0}] extract-preflight-remove-failed path={1} reason={2}" -f $RowId, $extractRoot, $result.error)
    }

    return [ordered]@{
        extractRoot = $extractRoot
        scanned = $scanned
        removed = $removed
        failed = @($failed)
    }
}

function Convert-RowRecordToJsonSafe {
    param(
        [Parameter(Mandatory = $true)]$Row
    )

    return [ordered]@{
        rowId = $Row.rowId
        description = $Row.description
        status = $Row.status
        failedCommandCount = $Row.failedCommandCount
        commands = @($Row.commands | ForEach-Object { Convert-CommandRecordToJsonSafe -Command $_ })
    }
}

function Convert-StageRecordToJsonSafe {
    param(
        [Parameter(Mandatory = $true)]$Stage
    )

    return [ordered]@{
        stageId = $Stage.stageId
        description = $Stage.description
        startedAtUtc = $Stage.startedAtUtc
        completedAtUtc = $Stage.completedAtUtc
        notes = @($Stage.notes)
        before = [ordered]@{
            capturedAtUtc = $Stage.before.capturedAtUtc
            processCount = @($Stage.before.processSnapshot).Count
            bakDirCount = @($Stage.before.homeSnapshot.bakDirectories).Count
        }
        after = [ordered]@{
            capturedAtUtc = $Stage.after.capturedAtUtc
            processCount = @($Stage.after.processSnapshot).Count
            bakDirCount = @($Stage.after.homeSnapshot.bakDirectories).Count
        }
        rows = @($Stage.rows | ForEach-Object { Convert-RowRecordToJsonSafe -Row $_ })
    }
}

function Convert-RunRecordToJsonSafe {
    param(
        [Parameter(Mandatory = $true)]$Run
    )

    return [ordered]@{
        runId = $Run.runId
        startedAtUtc = $Run.startedAtUtc
        completedAtUtc = $Run.completedAtUtc
        durationSeconds = $Run.durationSeconds
        host = $Run.host
        user = $Run.user
        config = $Run.config
        matrixSummary = $Run.matrixSummary
        stages = @($Run.stages | ForEach-Object { Convert-StageRecordToJsonSafe -Stage $_ })
        rowMatrix = @($Run.rowMatrix | ForEach-Object { Convert-RowRecordToJsonSafe -Row $_ })
    }
}

function Build-RunFinalSummary {
    param(
        [Parameter(Mandatory = $true)]$Run
    )

    return [ordered]@{
        runId = $Run.runId
        startedAtUtc = $Run.startedAtUtc
        completedAtUtc = $Run.completedAtUtc
        durationSeconds = $Run.durationSeconds
        host = $Run.host
        user = $Run.user
        matrixSummary = $Run.matrixSummary
        rowStatus = @(
            $Run.rowMatrix | ForEach-Object {
                [ordered]@{
                    rowId = $_.rowId
                    status = $_.status
                    failedCommandCount = $_.failedCommandCount
                }
            }
        )
    }
}

Write-StageLine "Harness start"
Write-StageLine ("Pinned archive exists={0}" -f (Test-Path -LiteralPath $PinnedArchive))
Write-StageLine ("Legacy payload root exists={0}" -f (Test-Path -LiteralPath $LegacyPayloadRoot))

Add-Stage -StageId "S00-PREFLIGHT" -Description "Preflight cleanup stale holders + canonical home env setup" -Body {
    $notes = @()
    $rows = @()

    $env:HAPPIER_HOME_DIR = $DefaultHome
    $env:USERPROFILE = $UserHome
    if ($env:PATH -notlike "*$DefaultHome\bin*") {
        $env:PATH = "$DefaultHome\bin;$($env:PATH)"
        $notes += "Prepended default home bin to PATH"
    }

    $stale = Get-CimProcessesSafe | Where-Object {
        $_.CommandLine -like "*happier-installers-smoke-*" -or
        $_.CommandLine -like "*windows_qa_helper.ps1*" -or
        $_.CommandLine -like "*__install-payload*"
    }
    $killed = @()
    foreach ($proc in $stale) {
        try {
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
            $killed += [ordered]@{ pid = $proc.ProcessId; name = $proc.Name; cmd = $proc.CommandLine }
        } catch {
            $notes += ("Failed to stop PID {0}: {1}" -f $proc.ProcessId, $_.Exception.Message)
        }
    }

    $versionsRoot = Join-Path $DefaultHome "cli-preview\versions"
    $bakRemoved = @()
    if (Test-Path -LiteralPath $versionsRoot) {
        $bakDirs = @(Get-ChildItem -LiteralPath $versionsRoot -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like ".0.2.8.bak-*" })
        foreach ($dir in $bakDirs) {
            $removeResult = Remove-DirectoryTreeBestEffort -Path $dir.FullName
            if ($removeResult.removed) {
                $bakRemoved += $dir.FullName
            } else {
                $notes += ("Failed to remove bak dir {0}: {1}" -f $dir.FullName, $removeResult.error)
            }
        }
    }

    $extractCleanup = Invoke-QaExtractRootPreflightCleanup -RowId "PREFLIGHT"
    $notes += ("Extract preflight cleanup scanned={0} removed={1}" -f $extractCleanup.scanned, $extractCleanup.removed)
    if (@($extractCleanup.failed).Count -gt 0) {
        $notes += ("Extract preflight cleanup failures={0}" -f @($extractCleanup.failed).Count)
    }

    Write-StageLine ("Preflight killed stale holders: {0}" -f $killed.Count)
    Write-StageLine ("Preflight removed bak dirs: {0}" -f $bakRemoved.Count)
    Write-StageLine ("Preflight extract cleanup removed dirs: {0}/{1}" -f $extractCleanup.removed, $extractCleanup.scanned)
    if ($killed.Count -gt 0) {
        Write-Host ($killed | ConvertTo-Json -Compress)
    }
    if ($bakRemoved.Count -gt 0) {
        Write-Host ("BAK_REMOVED=" + (($bakRemoved -join ";")))
    } else {
        Write-Host "BAK_REMOVED=NONE"
    }

    return [ordered]@{
        rows = $rows
        notes = @($notes)
    }
}

Add-Stage -StageId "S01-INSTALLER-L15" -Description "Installer rows QA-01/02/09/12 + L15 smoke" -Body {
    $rows = @()
    $notes = @()

    $qa01 = @()
    $qa01 += Invoke-RowCommand -RowId "QA-01" -Label "reset install roots" -FilePath "powershell.exe" -Arguments (New-HelperCommand -Action "reset") -TimeoutSeconds 60
    $qa01 += Invoke-InstallerCommandWithPreflight -RowId "QA-01" -Label "install-modern-cli pinned 0.2.8 (420s)" -Arguments (New-HelperCommand -Action "install-modern-cli" -ArchivePath $PinnedArchive -Version $CandidateVersion -Channel "preview") -DefaultSeconds 420
    $qa01 += Invoke-RowCommand -RowId "QA-01" -Label "hprev --version" -FilePath $HprevExe -Arguments @("--version") -TimeoutSeconds 30
    $qa01 += Invoke-RowCommand -RowId "QA-01" -Label "candidate --version" -FilePath $CandidateExe -Arguments @("--version") -TimeoutSeconds 30
    $rows += Build-Row -RowId "QA-01" -Description "Fresh preview install baseline" -Commands $qa01

    $qa02 = @()
    $qa02 += Invoke-RowCommand -RowId "QA-02" -Label "reset install roots" -FilePath "powershell.exe" -Arguments (New-HelperCommand -Action "reset") -TimeoutSeconds 60
    $qa02 += Invoke-InstallerCommandWithPreflight -RowId "QA-02" -Label "install legacy preview from payload root" -Arguments (New-HelperCommand -Action "install-modern-cli-from-payload-root" -PayloadRoot $LegacyPayloadRoot -Version $LegacyVersion -Channel "preview") -DefaultSeconds 420
    $qa02 += Invoke-InstallerCommandWithPreflight -RowId "QA-02" -Label "upgrade to pinned 0.2.8 (480s)" -Arguments (New-HelperCommand -Action "install-modern-cli" -ArchivePath $PinnedArchive -Version $CandidateVersion -Channel "preview") -DefaultSeconds 480
    $qa02 += Invoke-RowCommand -RowId "QA-02" -Label "candidate --version" -FilePath $CandidateExe -Arguments @("--version") -TimeoutSeconds 30
    $rows += Build-Row -RowId "QA-02" -Description "Preview daemon login then upgrade to candidate" -Commands $qa02

    $qa09 = @()
    $qa09 += Invoke-RowCommand -RowId "QA-09" -Label "reset install roots" -FilePath "powershell.exe" -Arguments (New-HelperCommand -Action "reset") -TimeoutSeconds 60
    if (Test-Path -LiteralPath $LegacyArchive) {
        $qa09 += Invoke-InstallerCommandWithPreflight -RowId "QA-09" -Label "install legacy preview from archive" -Arguments (New-HelperCommand -Action "install-modern-cli" -ArchivePath $LegacyArchive -Version $LegacyVersion -Channel "preview") -DefaultSeconds 420
    } else {
        $notes += "Legacy archive missing; using payload-root install for QA-09 seed"
        $qa09 += Invoke-InstallerCommandWithPreflight -RowId "QA-09" -Label "install legacy preview from payload root" -Arguments (New-HelperCommand -Action "install-modern-cli-from-payload-root" -PayloadRoot $LegacyPayloadRoot -Version $LegacyVersion -Channel "preview") -DefaultSeconds 420
    }
    $qa09 += Invoke-InstallerCommandWithPreflight -RowId "QA-09" -Label "candidate install rollback probe (420s)" -Arguments (New-HelperCommand -Action "install-modern-cli" -ArchivePath $PinnedArchive -Version $CandidateVersion -Channel "preview") -DefaultSeconds 420
    $qa09 += Invoke-RowCommand -RowId "QA-09" -Label "candidate service status --json" -FilePath $CandidateExe -Arguments @("service", "status", "--json") -TimeoutSeconds 60
    $rows += Build-Row -RowId "QA-09" -Description "Installer/update rollback behavior" -Commands $qa09

    $qa12 = @()
    $qa12 += Invoke-RowCommand -RowId "QA-12" -Label "reset install roots" -FilePath "powershell.exe" -Arguments (New-HelperCommand -Action "reset") -TimeoutSeconds 60
    $qa12 += Invoke-InstallerCommandWithPreflight -RowId "QA-12" -Label "install-modern-cli pinned lock probe (420s)" -Arguments (New-HelperCommand -Action "install-modern-cli" -ArchivePath $PinnedArchive -Version $CandidateVersion -Channel "preview") -DefaultSeconds 420
    $qa12 += Invoke-RowCommandLine -RowId "QA-12" -Label "lock probe tasklist happier.exe" -CommandLine "tasklist /v /fi ""IMAGENAME eq happier.exe""" -TimeoutSeconds 30
    $qa12 += Invoke-RowCommandLine -RowId "QA-12" -Label "lock probe bak dirs" -CommandLine "dir /ad /b C:\Users\test_qa\.happier\cli-preview\versions\.0.2.8.bak-* 2>nul & if errorlevel 1 echo BAK_ABSENT" -TimeoutSeconds 30
    $rows += Build-Row -RowId "QA-12" -Description "Preview install lock probe" -Commands $qa12

    $l15 = @()
    $l15 += Invoke-RowCommand -RowId "L15-SMOKE" -Label "reset install roots" -FilePath "powershell.exe" -Arguments (New-HelperCommand -Action "reset") -TimeoutSeconds 60
    $l15 += Invoke-InstallerCommandWithPreflight -RowId "L15-SMOKE" -Label "install-modern-cli pinned smoke (480s)" -Arguments (New-HelperCommand -Action "install-modern-cli" -ArchivePath $PinnedArchive -Version $CandidateVersion -Channel "preview") -DefaultSeconds 480
    $l15 += Invoke-RowCommand -RowId "L15-SMOKE" -Label "candidate --version" -FilePath $CandidateExe -Arguments @("--version") -TimeoutSeconds 30
    $rows += Build-Row -RowId "L15-SMOKE" -Description "Native win32 installer smoke on pinned candidate" -Commands $l15

    return [ordered]@{
        rows = $rows
        notes = @($notes)
    }
}

Add-Stage -StageId "S02-LIFECYCLE-L18-L21" -Description "Lifecycle rows QA-03/05/08 and default-home service diagnostics" -Body {
    $rows = @()

    $qa03 = @()
    $qa03 += Invoke-RowCommand -RowId "QA-03" -Label "candidate service list --json" -FilePath $CandidateExe -Arguments @("service", "list", "--json") -TimeoutSeconds 60
    $qa03 += Invoke-RowCommand -RowId "QA-03" -Label "candidate service status --json" -FilePath $CandidateExe -Arguments @("service", "status", "--json") -TimeoutSeconds 60
    $qa03 += Invoke-RowCommand -RowId "QA-03" -Label "candidate daemon restart --takeover --json" -FilePath $CandidateExe -Arguments @("daemon", "restart", "--takeover", "--json") -TimeoutSeconds 60
    $rows += Build-Row -RowId "QA-03" -Description "Service conflict and lifecycle restart row" -Commands $qa03

    $qa05 = @()
    $qa05 += Invoke-RowCommand -RowId "QA-05" -Label "candidate daemon status --json (before continuity)" -FilePath $CandidateExe -Arguments @("daemon", "status", "--json") -TimeoutSeconds 60
    $qa05 += Invoke-RowCommand -RowId "QA-05" -Label "candidate session create codex --json" -FilePath $CandidateExe -Arguments @("session", "create", "--provider", "codex", "--json") -TimeoutSeconds 90
    $qa05 += Invoke-RowCommand -RowId "QA-05" -Label "candidate daemon status --json (after continuity)" -FilePath $CandidateExe -Arguments @("daemon", "status", "--json") -TimeoutSeconds 60
    $rows += Build-Row -RowId "QA-05" -Description "Session continuity across lifecycle operations" -Commands $qa05

    $qa08 = @()
    $qa08 += Invoke-RowCommand -RowId "QA-08" -Label "candidate session create codex --json (direct/attach proxy)" -FilePath $CandidateExe -Arguments @("session", "create", "--provider", "codex", "--json") -TimeoutSeconds 90
    $qa08 += Invoke-RowCommand -RowId "QA-08" -Label "candidate daemon status --json (post direct row)" -FilePath $CandidateExe -Arguments @("daemon", "status", "--json") -TimeoutSeconds 60
    $rows += Build-Row -RowId "QA-08" -Description "Direct/tail/attach/takeover proxy row" -Commands $qa08

    return [ordered]@{
        rows = $rows
        notes = @()
    }
}

Add-Stage -StageId "S03-COMPAT-QA11" -Description "Compatibility rows and QA-11 matrix" -Body {
    $rows = @()

    $qa11 = @()
    $qa11 += Invoke-RowCommand -RowId "QA-11" -Label "old --version" -FilePath $LegacyExe -Arguments @("--version") -TimeoutSeconds 30
    $qa11 += Invoke-RowCommand -RowId "QA-11" -Label "new --version" -FilePath $CandidateExe -Arguments @("--version") -TimeoutSeconds 30
    $qa11 += Invoke-RowCommand -RowId "QA-11" -Label "M1 old daemon stop --json" -FilePath $LegacyExe -Arguments @("daemon", "stop", "--json") -TimeoutSeconds 60
    $qa11 += Invoke-RowCommand -RowId "QA-11" -Label "M1 old daemon start --json" -FilePath $LegacyExe -Arguments @("daemon", "start", "--json") -TimeoutSeconds 60
    $qa11 += Invoke-RowCommand -RowId "QA-11" -Label "M1 old daemon status --json" -FilePath $LegacyExe -Arguments @("daemon", "status", "--json") -TimeoutSeconds 60
    $qa11 += Invoke-RowCommand -RowId "QA-11" -Label "M1 old session create --json" -FilePath $LegacyExe -Arguments @("session", "create", "--provider", "codex", "--json") -TimeoutSeconds 90
    $qa11 += Invoke-RowCommand -RowId "QA-11" -Label "M2 new daemon status --json" -FilePath $CandidateExe -Arguments @("daemon", "status", "--json") -TimeoutSeconds 60
    $qa11 += Invoke-RowCommand -RowId "QA-11" -Label "M2 new session create --json" -FilePath $CandidateExe -Arguments @("session", "create", "--provider", "codex", "--json") -TimeoutSeconds 90
    $qa11 += Invoke-RowCommand -RowId "QA-11" -Label "M3 new daemon restart --takeover --json" -FilePath $CandidateExe -Arguments @("daemon", "restart", "--takeover", "--json") -TimeoutSeconds 60
    $qa11 += Invoke-RowCommand -RowId "QA-11" -Label "M3 new daemon status --json" -FilePath $CandidateExe -Arguments @("daemon", "status", "--json") -TimeoutSeconds 60
    $qa11 += Invoke-RowCommand -RowId "QA-11" -Label "M3 old session create --json" -FilePath $LegacyExe -Arguments @("session", "create", "--provider", "codex", "--json") -TimeoutSeconds 90
    $rows += Build-Row -RowId "QA-11" -Description "Compatibility matrix old/new daemon/client lifecycle" -Commands $qa11

    return [ordered]@{
        rows = $rows
        notes = @()
    }
}

$run.completedAtUtc = [DateTime]::UtcNow.ToString("o")
$run.durationSeconds = [Math]::Round(([DateTime]::Parse($run.completedAtUtc) - $runStartedAt).TotalSeconds, 3)
$run.matrixSummary = [ordered]@{
    totalRows = $run.rowMatrix.Count
    passedRows = @($run.rowMatrix | Where-Object { $_.status -eq "PASS" }).Count
    failedRows = @($run.rowMatrix | Where-Object { $_.status -eq "FAIL" }).Count
}

Write-StageLine "Harness complete"
Write-Output "===WAVE_JSON_START==="
$runFinalSummary = Build-RunFinalSummary -Run $run
$runFinalSummary | ConvertTo-Json -Depth 6 -Compress
Write-Output "===WAVE_JSON_END==="
