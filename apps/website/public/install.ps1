# PositionalBinding=$false: without it the [string] parameters below bind
# positionally and silently swallow -Run arguments (e.g. `-Run setup-relay
# --flag` set $Channel to '--flag'), so $RunArgs never received them.
[CmdletBinding(PositionalBinding = $false)]
param(
  [string] $Channel = $(if ($env:HAPPIER_CHANNEL) { $env:HAPPIER_CHANNEL } else { "stable" }),
  [string] $Version = $(if ($env:HAPPIER_INSTALL_VERSION) { $env:HAPPIER_INSTALL_VERSION } else { "" }),
  [switch] $SetupRelay,
  [switch] $WithDaemon,
  [switch] $WithoutDaemon,
  [string] $Run = $(if ($env:HAPPIER_INSTALLER_RUN_ACTION) { $env:HAPPIER_INSTALLER_RUN_ACTION } else { "" }),
  # Declared as $Yes with -NonInteractive as an alias on purpose: PowerShell
  # variable names are case-insensitive, so a [switch] $NonInteractive would
  # collide with the $Noninteractive string below.
  [Alias('NonInteractive')]
  [switch] $Yes,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $RunArgs = @()
)

$ErrorActionPreference = "Stop"

if ($WithDaemon.IsPresent -and $WithoutDaemon.IsPresent) {
  throw "Specify either -WithDaemon or -WithoutDaemon, not both."
}

if ($env:HAPPIER_INSTALLER_SETUP_RELAY -and $env:HAPPIER_INSTALLER_SETUP_RELAY -ne "0") {
  $SetupRelay = $true
}

$InstallerAction = if ($env:HAPPIER_INSTALLER_ACTION) { ([string]$env:HAPPIER_INSTALLER_ACTION).Trim().ToLowerInvariant() } else { "install" }
if ($InstallerAction -eq "reinstall") {
  $InstallerAction = "install"
}
if ($InstallerAction -ne "install" -and $InstallerAction -ne "payload-reversion") {
  throw "Unsupported HAPPIER_INSTALLER_ACTION '$InstallerAction' for install.ps1. Expected install or payload-reversion."
}
if ($Version -and $Version -notmatch '^[A-Za-z0-9][A-Za-z0-9._+-]*$') {
  throw "Invalid install version '$Version'. Expected a release version such as 0.2.1."
}

function Normalize-Channel {
  param (
    [Parameter(Mandatory = $true)] [string] $Raw
  )
  $value = $Raw.Trim().ToLowerInvariant()
  if (-not $value) { return "stable" }
  switch ($value) {
    "stable" { return "stable" }
    "preview" { return "preview" }
    "dev" { return "publicdev" }
    "publicdev" { return "publicdev" }
    default { throw "Invalid HAPPIER_CHANNEL '$Raw'. Expected stable, preview, or dev." }
  }
}

$Channel = Normalize-Channel -Raw ([string]$Channel)

$Repo = if ($env:HAPPIER_GITHUB_REPO) { $env:HAPPIER_GITHUB_REPO } else { "happier-dev/happier" }
$Token = if ($env:HAPPIER_GITHUB_TOKEN) { $env:HAPPIER_GITHUB_TOKEN } elseif ($env:GITHUB_TOKEN) { $env:GITHUB_TOKEN } else { "" }
$ReleaseAssetsDir = if ($env:HAPPIER_RELEASE_ASSETS_DIR) { $env:HAPPIER_RELEASE_ASSETS_DIR } else { "" }
$GitHubHeaders = @{
  "X-GitHub-Api-Version" = "2022-11-28"
}
if ($Token) {
  $GitHubHeaders["Authorization"] = "Bearer $Token"
}
$InstallDir = if ($env:HAPPIER_INSTALL_DIR) { $env:HAPPIER_INSTALL_DIR } elseif ($env:HAPPIER_HOME_DIR) { $env:HAPPIER_HOME_DIR } else { Join-Path $env:USERPROFILE ".happier" }
$DaemonServiceStateHomeDir = if ($env:HAPPIER_HOME_DIR) { $env:HAPPIER_HOME_DIR } else { $InstallDir }
$LegacyBinDir = Join-Path $env:USERPROFILE ".local\bin"
$BinDir = Join-Path $InstallDir "bin"
if ($env:HAPPIER_BIN_DIR) {
  $requestedBinDir = $env:HAPPIER_BIN_DIR
  if ($requestedBinDir -ne $BinDir) {
    Write-Warning "Ignoring HAPPIER_BIN_DIR on Windows; the managed install bin directory is the canonical PATH target."
  }
}
$Noninteractive = if ($Yes.IsPresent) { "1" } elseif ($env:HAPPIER_NONINTERACTIVE) { $env:HAPPIER_NONINTERACTIVE } else { "0" }
if ($Yes.IsPresent) {
  # Mirror install.sh: the flag must reach every child `happier` invocation too.
  $env:HAPPIER_NONINTERACTIVE = "1"
}
$NoPathUpdate = if ($env:HAPPIER_NO_PATH_UPDATE) { $env:HAPPIER_NO_PATH_UPDATE } else { "0" }
$WithDaemonExplicit = $false
if ($WithDaemon.IsPresent) {
  $WithDaemonPreference = "1"
  $WithDaemonExplicit = $true
}
elseif ($WithoutDaemon.IsPresent) {
  $WithDaemonPreference = "0"
  $WithDaemonExplicit = $true
}
elseif ($env:HAPPIER_WITH_DAEMON) {
  $WithDaemonPreference = $env:HAPPIER_WITH_DAEMON
  $WithDaemonExplicit = $true
}
else {
  $WithDaemonPreference = "0"
}
$DefaultMinisignPubKey = @"
untrusted comment: minisign public key 91AE28177BF6E43C
RWQ85PZ7FyiukYbL3qv/bKnwgbT68wLVzotapeMFIb8n+c7pBQ7U8W2t
"@
$MinisignPubKey = if ($env:HAPPIER_MINISIGN_PUBKEY) { $env:HAPPIER_MINISIGN_PUBKEY } else { $DefaultMinisignPubKey.Trim() }
$MinisignPubKeyUrl = if ($env:HAPPIER_MINISIGN_PUBKEY_URL) { $env:HAPPIER_MINISIGN_PUBKEY_URL } else { "https://happier.dev/happier-release.pub" }

function Resolve-CliShimName {
  if ($Channel -eq "preview") { return "hprev" }
  if ($Channel -eq "publicdev") { return "hdev" }
  return "happier"
}

function Resolve-CliInstallRootName {
  if ($Channel -eq "preview") { return "cli-preview" }
  if ($Channel -eq "publicdev") { return "cli-dev" }
  return "cli"
}

function Resolve-InstalledCliInvoker {
  $shim = Resolve-CliShimName

  $candidates = @(
    (Join-Path $BinDir "$shim.exe"),
    (Join-Path $BinDir $shim),
    (Join-Path $InstallDir "bin\\$shim.exe"),
    (Join-Path $InstallDir "bin\\$shim")
  )

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) {
      return $candidate
    }
  }

  foreach ($name in @($shim, "$shim.exe")) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source -and (Test-Path $cmd.Source)) {
      return $cmd.Source
    }
  }

  return $null
}

function Read-InstallerMarkerFile {
  param (
    [Parameter(Mandatory = $true)] [string] $Path
  )
  if (-not (Test-Path $Path -PathType Leaf)) {
    return ""
  }
  $value = Get-Content -Path $Path -TotalCount 1 -ErrorAction SilentlyContinue
  return ([string]$value).Trim()
}

function Test-InstallerVersionId {
  param (
    [Parameter(Mandatory = $true)] [string] $Value
  )
  return (
    -not [string]::IsNullOrWhiteSpace($Value) -and
    $Value.Length -le 200 -and
    $Value -match '^[A-Za-z0-9][A-Za-z0-9._+-]*$'
  )
}

function Enter-InstallerPayloadMutationLock {
  param (
    [Parameter(Mandatory = $true)] [string] $InstallRoot
  )
  $lockPath = "$InstallRoot.mutation.lock"
  $deadline = [DateTime]::UtcNow.AddSeconds(150)

  while ($true) {
    try {
      New-Item -ItemType Directory -Path $lockPath -ErrorAction Stop | Out-Null
      return $lockPath
    }
    catch {
      $lockInfo = Get-Item -Path $lockPath -Force -ErrorAction SilentlyContinue
      if ($lockInfo -and [DateTime]::UtcNow.Subtract($lockInfo.LastWriteTimeUtc).TotalMinutes -gt 10) {
        Remove-Item -Path $lockPath -Force -ErrorAction SilentlyContinue
        continue
      }
      if ([DateTime]::UtcNow -ge $deadline) {
        throw "Timed out waiting for first-party payload mutation lock: $lockPath"
      }
      Start-Sleep -Milliseconds 250
    }
  }
}

function Exit-InstallerPayloadMutationLock {
  param (
    [Parameter(Mandatory = $true)] [string] $LockPath
  )
  Remove-Item -Path $LockPath -Force -ErrorAction SilentlyContinue
}

function Write-InstallerMarkerFileAtomic {
  param (
    [Parameter(Mandatory = $true)] [string] $Path,
    [Parameter(Mandatory = $true)] [string] $Value
  )
  $temporaryPath = "$Path.tmp-$PID-$([System.Guid]::NewGuid().ToString("N"))"
  $backupPath = "$Path.bak-$PID-$([System.Guid]::NewGuid().ToString("N"))"
  $hadExistingMarker = $false
  $published = $false
  try {
    $utf8WithoutBom = New-Object System.Text.UTF8Encoding -ArgumentList $false
    [System.IO.File]::WriteAllText($temporaryPath, "$Value`n", $utf8WithoutBom)
    if (Get-Item -Path $Path -Force -ErrorAction SilentlyContinue) {
      Move-Item -Path $Path -Destination $backupPath
      $hadExistingMarker = $true
    }
    Move-Item -Path $temporaryPath -Destination $Path
    $published = $true
  }
  finally {
    Remove-Item -Path $temporaryPath -Force -ErrorAction SilentlyContinue
    if ($published) {
      Remove-Item -Path $backupPath -Force -ErrorAction SilentlyContinue
    }
    elseif ($hadExistingMarker -and -not (Get-Item -Path $Path -Force -ErrorAction SilentlyContinue)) {
      Move-Item -Path $backupPath -Destination $Path -ErrorAction SilentlyContinue
    }
  }
}

function Test-InstallerPayloadDirectCopyFallbackSafe {
  $installRoot = Join-Path $InstallDir (Resolve-CliInstallRootName)
  $versionsDir = Join-Path $installRoot "versions"
  $currentVersionMarkerPath = Join-Path $installRoot "current.version"
  $currentPointerPath = Join-Path $installRoot "current"
  $managedShimPath = Join-Path $BinDir "$((Resolve-CliShimName)).exe"

  $partialVersionDirs = @()
  if (Test-Path $versionsDir -PathType Container) {
    $partialVersionDirs = @(
      Get-ChildItem -Path $versionsDir -Directory -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^\..*\.tmp-' }
    )
  }
  if ($partialVersionDirs.Count -gt 0) {
    return $false
  }

  $currentVersion = Read-InstallerMarkerFile -Path $currentVersionMarkerPath
  $currentPointerExists = Test-Path $currentPointerPath -PathType Container
  $managedShimExists = Test-Path $managedShimPath -PathType Leaf

  if (-not $currentVersion -and -not $currentPointerExists) {
    return $true
  }

  if (-not $managedShimExists -and -not $currentPointerExists) {
    return $true
  }

  return $false
}

function New-InstallerStagingDirectory {
  param (
    [Parameter(Mandatory = $true)] [string] $InstallHomeDir
  )

  $stagingParent = Join-Path $InstallHomeDir ".install-staging"
  New-Item -ItemType Directory -Path $stagingParent -Force | Out-Null
  return New-Item -ItemType Directory -Path (Join-Path $stagingParent ("happier-install-" + [System.Guid]::NewGuid().ToString("N")))
}

function Remove-InstallerStagingDirectory {
  param (
    [Parameter(Mandatory = $false)] $Directory
  )

  if (-not $Directory -or -not $Directory.FullName) {
    return
  }

  $stagingParent = Split-Path -Parent $Directory.FullName
  Remove-Item -Path $Directory.FullName -Recurse -Force -ErrorAction SilentlyContinue
  if ($stagingParent -and (Test-Path $stagingParent -PathType Container)) {
    $remaining = @(Get-ChildItem -Path $stagingParent -Force -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($remaining.Count -eq 0) {
      Remove-Item -Path $stagingParent -Force -ErrorAction SilentlyContinue
    }
  }
}

function Set-InstallerDirectoryPointer {
  param (
    [Parameter(Mandatory = $true)] [string] $Path,
    [Parameter(Mandatory = $true)] [string] $Target
  )
  Remove-Item -Path $Path -Recurse -Force -ErrorAction SilentlyContinue
  try {
    New-Item -ItemType Junction -Path $Path -Target $Target -Force | Out-Null
  }
  catch {
    Copy-Item -Path $Target -Destination $Path -Recurse -Force
  }
}

function Restore-InstallerCliPayloadReversionPublications {
  param (
    [Parameter(Mandatory = $true)] [string] $InstallRoot,
    [Parameter(Mandatory = $false)] [string] $CurrentVersion,
    [Parameter(Mandatory = $false)] [string] $PreviousVersion,
    [Parameter(Mandatory = $false)] [string] $LegacyCurrentBackupPath
  )
  $restorationErrors = New-Object System.Collections.Generic.List[string]
  $currentPointerPath = Join-Path $InstallRoot "current"
  $currentMarkerPath = Join-Path $InstallRoot "current.version"
  $previousPointerPath = Join-Path $InstallRoot "previous"
  $previousMarkerPath = Join-Path $InstallRoot "previous.version"

  try {
    if ($LegacyCurrentBackupPath -and (Test-Path $LegacyCurrentBackupPath -PathType Container)) {
      Remove-Item -Path $currentPointerPath -Recurse -Force -ErrorAction SilentlyContinue
      Move-Item -Path $LegacyCurrentBackupPath -Destination $currentPointerPath
      Remove-Item -Path $currentMarkerPath -Force -ErrorAction SilentlyContinue
    }
    elseif ($CurrentVersion) {
      $currentVersionPath = Join-Path (Join-Path $InstallRoot "versions") $CurrentVersion
      Set-InstallerDirectoryPointer -Path $currentPointerPath -Target $currentVersionPath
      Write-InstallerMarkerFileAtomic -Path $currentMarkerPath -Value $CurrentVersion
    }
    else {
      Remove-Item -Path $currentPointerPath -Recurse -Force -ErrorAction SilentlyContinue
      Remove-Item -Path $currentMarkerPath -Force -ErrorAction SilentlyContinue
    }
  }
  catch {
    $restorationErrors.Add("current: $($_.Exception.Message)")
  }

  try {
    if ($PreviousVersion) {
      $previousVersionPath = Join-Path (Join-Path $InstallRoot "versions") $PreviousVersion
      Set-InstallerDirectoryPointer -Path $previousPointerPath -Target $previousVersionPath
      Write-InstallerMarkerFileAtomic -Path $previousMarkerPath -Value $PreviousVersion
    }
    else {
      Remove-Item -Path $previousPointerPath -Recurse -Force -ErrorAction SilentlyContinue
      Remove-Item -Path $previousMarkerPath -Force -ErrorAction SilentlyContinue
    }
  }
  catch {
    $restorationErrors.Add("previous: $($_.Exception.Message)")
  }

  if ($restorationErrors.Count -gt 0) {
    throw "The prior first-party payload state could not be completely restored: $($restorationErrors -join '; ')"
  }
}

function Test-InstallerDefaultChannelMatchesSelectedChannel {
  $statePath = Join-Path $InstallDir "default-cli-release-channel.json"
  if (Test-Path $statePath -PathType Leaf) {
    $raw = Get-Content -Path $statePath -Raw -ErrorAction SilentlyContinue
    return $raw -match ('"releaseChannel"\s*:\s*"' + [Regex]::Escape($Channel) + '"')
  }
  return $Channel -eq "stable"
}

function Sync-InstallerCliPayloadReversionShim {
  param (
    [Parameter(Mandatory = $true)] [string] $ShimName,
    [Parameter(Mandatory = $true)] [string] $BinaryPath
  )
  New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
  $shimPath = Join-Path $BinDir "$ShimName.exe"
  Remove-Item -Path $shimPath -Force -ErrorAction SilentlyContinue
  try {
    New-Item -ItemType HardLink -Path $shimPath -Target $BinaryPath -Force | Out-Null
  }
  catch {
    Copy-Item -Path $BinaryPath -Destination $shimPath -Force
  }
}

function Invoke-InstallerCliPayloadReversion {
  $managedRoot = Resolve-CliInstallRootName
  $installRoot = Join-Path $InstallDir $managedRoot
  if (-not (Test-Path $installRoot -PathType Container)) {
    throw "No previous $(Resolve-CliShimName) payload is available for reversion."
  }
  $mutationLockPath = Enter-InstallerPayloadMutationLock -InstallRoot $installRoot
  try {
    $previousVersion = Read-InstallerMarkerFile -Path (Join-Path $installRoot "previous.version")
    if (-not $previousVersion) {
      throw "No previous $(Resolve-CliShimName) payload is available for reversion."
    }
    if (-not (Test-InstallerVersionId -Value $previousVersion)) {
      throw "FIRST_PARTY_VERSION_ID_INVALID: payload-reversion target marker contains an invalid version id '$previousVersion'."
    }

    $previousDir = Join-Path (Join-Path $installRoot "versions") $previousVersion
    $previousBinary = Join-Path $previousDir "happier.exe"
    if (-not (Test-Path $previousBinary -PathType Leaf)) {
      throw "Payload-reversion target is missing or incomplete: $previousDir"
    }

    $currentVersion = Read-InstallerMarkerFile -Path (Join-Path $installRoot "current.version")
    if ($currentVersion -and -not (Test-InstallerVersionId -Value $currentVersion)) {
      throw "FIRST_PARTY_VERSION_ID_INVALID: current marker contains an invalid version id '$currentVersion'."
    }
    $legacyCurrentBackupPath = ""
    $currentPointerPath = Join-Path $installRoot "current"
    if (-not $currentVersion -and (Test-Path $currentPointerPath -PathType Container)) {
      $legacyCurrentBackupPath = Join-Path $installRoot (".current.payload-reversion-$PID-" + [System.Guid]::NewGuid().ToString("N"))
    }
    $shimName = Resolve-CliShimName
    $syncDefaultShim = $shimName -ne "happier" -and (Test-InstallerDefaultChannelMatchesSelectedChannel)

    try {
      if ($legacyCurrentBackupPath) {
        Move-Item -Path $currentPointerPath -Destination $legacyCurrentBackupPath
      }
      Set-InstallerDirectoryPointer -Path $currentPointerPath -Target $previousDir
      Write-InstallerMarkerFileAtomic -Path (Join-Path $installRoot "current.version") -Value $previousVersion

      if ($currentVersion) {
        $currentDir = Join-Path (Join-Path $installRoot "versions") $currentVersion
        if (Test-Path $currentDir -PathType Container) {
          Set-InstallerDirectoryPointer -Path (Join-Path $installRoot "previous") -Target $currentDir
          Write-InstallerMarkerFileAtomic -Path (Join-Path $installRoot "previous.version") -Value $currentVersion
        }
        else {
          Remove-Item -Path (Join-Path $installRoot "previous") -Recurse -Force -ErrorAction SilentlyContinue
          Remove-Item -Path (Join-Path $installRoot "previous.version") -Force -ErrorAction SilentlyContinue
        }
      }
      else {
        Remove-Item -Path (Join-Path $installRoot "previous") -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -Path (Join-Path $installRoot "previous.version") -Force -ErrorAction SilentlyContinue
      }

      Sync-InstallerCliPayloadReversionShim -ShimName $shimName -BinaryPath $previousBinary
      if ($syncDefaultShim) {
        Sync-InstallerCliPayloadReversionShim -ShimName "happier" -BinaryPath $previousBinary
      }

      if ($legacyCurrentBackupPath) {
        Remove-Item -Path $legacyCurrentBackupPath -Recurse -Force -ErrorAction SilentlyContinue
      }
    }
    catch {
      $mutationError = $_
      $restorationErrors = New-Object System.Collections.Generic.List[string]
      try {
        Restore-InstallerCliPayloadReversionPublications `
          -InstallRoot $installRoot `
          -CurrentVersion $currentVersion `
          -PreviousVersion $previousVersion `
          -LegacyCurrentBackupPath $legacyCurrentBackupPath
      }
      catch {
        $restorationErrors.Add("payload: $($_.Exception.Message)")
      }

      try {
        $restoredBinaryPath = ""
        if ($currentVersion) {
          $restoredBinaryPath = Join-Path (Join-Path (Join-Path $installRoot "versions") $currentVersion) "happier.exe"
        }
        elseif ($legacyCurrentBackupPath) {
          $restoredBinaryPath = Join-Path (Join-Path $installRoot "current") "happier.exe"
        }
        if ($restoredBinaryPath -and (Test-Path $restoredBinaryPath -PathType Leaf)) {
          Sync-InstallerCliPayloadReversionShim -ShimName $shimName -BinaryPath $restoredBinaryPath
          if ($syncDefaultShim) {
            Sync-InstallerCliPayloadReversionShim -ShimName "happier" -BinaryPath $restoredBinaryPath
          }
        }
        else {
          Remove-Item -Path (Join-Path $BinDir "$shimName.exe") -Force -ErrorAction SilentlyContinue
          if ($syncDefaultShim) {
            Remove-Item -Path (Join-Path $BinDir "happier.exe") -Force -ErrorAction SilentlyContinue
          }
        }
      }
      catch {
        $restorationErrors.Add("shim: $($_.Exception.Message)")
      }

      if ($restorationErrors.Count -gt 0) {
        throw "Payload reversion failed ($($mutationError.Exception.Message)) and the prior state could not be completely restored ($($restorationErrors -join '; '))."
      }
      throw $mutationError
    }

    Write-Host "Selected previous $shimName payload $previousVersion for pre-activation release QA."
  }
  finally {
    Exit-InstallerPayloadMutationLock -LockPath $mutationLockPath
  }
}

function Resolve-TarExecutablePath {
  $cmd = Get-Command "tar.exe" -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source -and (Test-Path $cmd.Source)) {
    return $cmd.Source
  }

  $pathEntries = @()
  foreach ($rawPath in @(
      $env:Path,
      [Environment]::GetEnvironmentVariable("Path", [EnvironmentVariableTarget]::User),
      [Environment]::GetEnvironmentVariable("Path", [EnvironmentVariableTarget]::Machine)
    )) {
    if ($rawPath) {
      $pathEntries += $rawPath -split ';'
    }
  }
  if ($env:WINDIR) {
    $pathEntries += Join-Path $env:WINDIR "System32"
  }

  foreach ($entry in $pathEntries) {
    $trimmedEntry = ([string]$entry).Trim()
    if (-not $trimmedEntry) {
      continue
    }
    $candidate = Join-Path $trimmedEntry "tar.exe"
    if (Test-Path $candidate) {
      return $candidate
    }
  }

  throw "Failed to locate tar.exe. Ensure Windows System32 is available or install tar before retrying."
}

function Show-PathReloadGuidance {
  param (
    [Parameter(Mandatory = $true)] [string] $ShimName,
    [Parameter(Mandatory = $true)] [string] $BinDir
  )

  Write-Host ""
  Write-Host "Next steps"
  Write-Host "The current PowerShell session can use $ShimName immediately."
  Write-Host "Other already-open terminals keep their old PATH until you restart them."
  Write-Host "Managed bin directory: $BinDir"
}

function ConvertTo-InstallerBoolean {
  param (
    [Parameter(Mandatory = $true)] [string] $Raw
  )

  $value = $Raw.Trim().ToLowerInvariant()
  switch ($value) {
    "1" { return "1" }
    "true" { return "1" }
    "yes" { return "1" }
    "on" { return "1" }
    "0" { return "0" }
    "false" { return "0" }
    "no" { return "0" }
    "off" { return "0" }
    "" { return "0" }
    default { throw "Invalid HAPPIER_WITH_DAEMON value '$Raw'. Expected 0/1, true/false, yes/no, or on/off." }
  }
}

function Get-DefaultBackgroundServiceChoice {
  if ($Noninteractive -eq "1") {
    return "0"
  }
  if ($Channel -eq "stable") {
    return "1"
  }
  return "0"
}

function Test-InteractiveInstallerPromptAvailable {
  if ($Noninteractive -eq "1") {
    return $false
  }
  try {
    return [Environment]::UserInteractive -and -not [Console]::IsInputRedirected
  }
  catch {
    return $false
  }
}

function Get-InstallerDisplayChannelLabel {
  param (
    [Parameter(Mandatory = $true)] [string] $Value
  )

  if ($Value -eq "publicdev" -or $Value -eq "dev") {
    return "dev"
  }

  return $Value
}

function Write-InstallerBullet {
  param (
    [Parameter(Mandatory = $true)] [string] $Text,
    [ConsoleColor] $Color
  )

  if ($PSBoundParameters.ContainsKey('Color')) {
    Write-Host "  • $Text" -ForegroundColor $Color
    return
  }

  Write-Host "  • $Text"
}

function Write-InstallerDetailBullet {
  param (
    [Parameter(Mandatory = $true)] [string] $Label,
    [Parameter(Mandatory = $true)] [string] $Value
  )

  Write-Host "    • " -NoNewline -ForegroundColor DarkGray
  Write-Host ("{0}:" -f $Label) -NoNewline -ForegroundColor Gray
  Write-Host " $Value"
}

function Read-BackgroundServicePromptChoice {
  param (
    [Parameter(Mandatory = $true)] [string] $DefaultChoice,
    [Parameter(Mandatory = $true)] [bool] $HasExistingServices
  )

  if (-not (Test-InteractiveInstallerPromptAvailable)) {
    return $DefaultChoice
  }

  $channelLabel = Get-InstallerDisplayChannelLabel -Value $Channel
  $defaultHint = "y/N"
  $recommendedNote = "recommended: no"
  if ($DefaultChoice -eq "1") {
    $defaultHint = "Y/n"
    $recommendedNote = "recommended: yes"
  }

  $prompt = "Set up automatic startup for the $channelLabel CLI?"
  if ($HasExistingServices) {
    $prompt = "Update automatic startup for the $channelLabel CLI?"
  }

  while ($true) {
    $answer = Read-Host "$prompt [$defaultHint] ($recommendedNote)"
    $normalized = ([string]$answer).Trim().ToLowerInvariant()
    switch ($normalized) {
      "" { return $DefaultChoice }
      "y" { return "1" }
      "yes" { return "1" }
      "n" { return "0" }
      "no" { return "0" }
      default { Write-Warning "Please answer yes or no." }
    }
  }
}

function Read-InstallerYesNoChoice {
  param (
    [Parameter(Mandatory = $true)] [string] $Prompt,
    [Parameter(Mandatory = $true)] [string] $DefaultChoice
  )

  if (-not (Test-InteractiveInstallerPromptAvailable)) {
    return $DefaultChoice
  }

  $defaultHint = "y/N"
  $recommendedNote = "recommended: no"
  if ($DefaultChoice -eq "1") {
    $defaultHint = "Y/n"
    $recommendedNote = "recommended: yes"
  }

  while ($true) {
    $answer = Read-Host "$Prompt [$defaultHint] ($recommendedNote)"
    $normalized = ([string]$answer).Trim().ToLowerInvariant()
    switch ($normalized) {
      "" { return $DefaultChoice }
      "y" { return "1" }
      "yes" { return "1" }
      "n" { return "0" }
      "no" { return "0" }
      default { Write-Warning "Please answer yes or no." }
    }
  }
}

function Resolve-WithDaemonPreference {
  param (
    [Parameter(Mandatory = $false)] [object[]] $Entries = @(),
    [Parameter()] $DefaultFollowingMatchesSelectedReleaseChannel = $null
  )

  if ($WithDaemonExplicit) {
    return ConvertTo-InstallerBoolean -Raw ([string]$WithDaemonPreference)
  }

  $defaultChoice = Get-DefaultBackgroundServiceChoice
  $hasExistingServices = $Entries.Count -gt 0
  if ($Noninteractive -eq "1") {
    if ($hasExistingServices) {
      return "1"
    }
    return $defaultChoice
  }

  if ($hasExistingServices -and (Test-BackgroundServiceInventoryHasMatchingDefaultFollowing -Entries $Entries -DefaultFollowingMatchesSelectedReleaseChannel $DefaultFollowingMatchesSelectedReleaseChannel)) {
    return "0"
  }

  return Read-BackgroundServicePromptChoice -DefaultChoice $defaultChoice -HasExistingServices $hasExistingServices
}

function Invoke-InstallerCommandWithDaemonServiceContext {
  param (
    [Parameter(Mandatory = $true)] [string] $CliPath,
    [Parameter(Mandatory = $true)] [string[]] $CommandArgs,
    [Parameter(Mandatory = $true)] [string] $HomeDir
  )

  $previousHomeDir = $env:HAPPIER_HOME_DIR
  $previousNoninteractive = $env:HAPPIER_NONINTERACTIVE
  $previousPublicReleaseChannel = $env:HAPPIER_PUBLIC_RELEASE_CHANNEL
  $previousDaemonServiceChannel = $env:HAPPIER_DAEMON_SERVICE_CHANNEL
  $previousInstallerDaemonServiceStrategy = $env:HAPPIER_INSTALLER_DAEMON_SERVICE_STRATEGY
  try {
    $channelLabel = if ($Channel -eq "publicdev") { "dev" } else { $Channel }
    $env:HAPPIER_HOME_DIR = $HomeDir
    if ($null -eq $previousNoninteractive) {
      Remove-Item Env:HAPPIER_NONINTERACTIVE -ErrorAction SilentlyContinue
    }
    else {
      $env:HAPPIER_NONINTERACTIVE = $previousNoninteractive
    }
    $env:HAPPIER_PUBLIC_RELEASE_CHANNEL = $channelLabel
    $env:HAPPIER_DAEMON_SERVICE_CHANNEL = $channelLabel
    if ($env:HAPPIER_INSTALLER_DAEMON_SERVICE_STRATEGY) {
      $env:HAPPIER_INSTALLER_DAEMON_SERVICE_STRATEGY = $env:HAPPIER_INSTALLER_DAEMON_SERVICE_STRATEGY
    }
    & $CliPath @CommandArgs
    # Native non-zero exits do not throw under Windows PowerShell 5.1, even
    # with ErrorActionPreference=Stop. Capture the only authoritative signal
    # before the finally block runs so explicit -Run can propagate it and the
    # automatic handoff can distinguish incomplete setup from success.
    $script:LastInstallerCommandExitCode = if ($null -eq $LASTEXITCODE) { 0 } else { [int]$LASTEXITCODE }
  }
  finally {
    if ($null -eq $previousHomeDir) {
      Remove-Item Env:HAPPIER_HOME_DIR -ErrorAction SilentlyContinue
    }
    else {
      $env:HAPPIER_HOME_DIR = $previousHomeDir
    }
    if ($null -eq $previousNoninteractive) {
      Remove-Item Env:HAPPIER_NONINTERACTIVE -ErrorAction SilentlyContinue
    }
    else {
      $env:HAPPIER_NONINTERACTIVE = $previousNoninteractive
    }
    if ($null -eq $previousPublicReleaseChannel) {
      Remove-Item Env:HAPPIER_PUBLIC_RELEASE_CHANNEL -ErrorAction SilentlyContinue
    }
    else {
      $env:HAPPIER_PUBLIC_RELEASE_CHANNEL = $previousPublicReleaseChannel
    }
    if ($null -eq $previousDaemonServiceChannel) {
      Remove-Item Env:HAPPIER_DAEMON_SERVICE_CHANNEL -ErrorAction SilentlyContinue
    }
    else {
      $env:HAPPIER_DAEMON_SERVICE_CHANNEL = $previousDaemonServiceChannel
    }
    if ($null -eq $previousInstallerDaemonServiceStrategy) {
      Remove-Item Env:HAPPIER_INSTALLER_DAEMON_SERVICE_STRATEGY -ErrorAction SilentlyContinue
    }
    else {
      $env:HAPPIER_INSTALLER_DAEMON_SERVICE_STRATEGY = $previousInstallerDaemonServiceStrategy
    }
  }
}

function Resolve-InstallerPreInstallCommandTimeoutMs {
  $raw = [string]$env:HAPPIER_INSTALLER_PRE_INSTALL_COMMAND_TIMEOUT_MS
  if (-not $raw) {
    return 30000
  }

  $parsed = 0
  if (-not [int]::TryParse($raw.Trim(), [ref]$parsed)) {
    return 30000
  }
  if ($parsed -lt 5000) {
    return 5000
  }
  if ($parsed -gt 120000) {
    return 120000
  }
  return $parsed
}

function Stop-InstallerProcessTree {
  param (
    [Parameter(Mandatory = $true)] [System.Diagnostics.Process] $Process
  )

  if ($null -eq $Process) {
    return
  }

  $processId = [int]$Process.Id
  if ($processId -le 0) {
    return
  }

  try {
    if (-not $Process.HasExited) {
      $Process.Kill($true)
      return
    }
  }
  catch {
  }

  try {
    $taskkillCommand = Get-Command "taskkill.exe" -ErrorAction SilentlyContinue
    if ($taskkillCommand -and $taskkillCommand.Source) {
      & $taskkillCommand.Source "/T" "/F" "/PID" ([string]$processId) *> $null
      if ($LASTEXITCODE -eq 0) {
        return
      }
    }
  }
  catch {
  }

  try {
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
  }
  catch {
  }
}

function Invoke-InstallerCommandWithDaemonServiceContextCapturingOutputWithTimeout {
  param (
    [Parameter(Mandatory = $true)] [string] $CliPath,
    [Parameter(Mandatory = $true)] [string[]] $CommandArgs,
    [Parameter(Mandatory = $true)] [string] $HomeDir,
    [Parameter(Mandatory = $true)] [int] $timeoutMs
  )

  $previousHomeDir = $env:HAPPIER_HOME_DIR
  $previousNoninteractive = $env:HAPPIER_NONINTERACTIVE
  $previousPublicReleaseChannel = $env:HAPPIER_PUBLIC_RELEASE_CHANNEL
  $previousDaemonServiceChannel = $env:HAPPIER_DAEMON_SERVICE_CHANNEL
  $previousInstallerDaemonServiceStrategy = $env:HAPPIER_INSTALLER_DAEMON_SERVICE_STRATEGY
  $runToken = [System.Guid]::NewGuid().ToString("N")
  $stdoutPath = Join-Path $env:TEMP "happier-pre-install-$runToken.stdout.log"
  $stderrPath = Join-Path $env:TEMP "happier-pre-install-$runToken.stderr.log"

  try {
    $channelLabel = if ($Channel -eq "publicdev") { "dev" } else { $Channel }
    $env:HAPPIER_HOME_DIR = $HomeDir
    if ($null -eq $previousNoninteractive) {
      Remove-Item Env:HAPPIER_NONINTERACTIVE -ErrorAction SilentlyContinue
    }
    else {
      $env:HAPPIER_NONINTERACTIVE = $previousNoninteractive
    }
    $env:HAPPIER_PUBLIC_RELEASE_CHANNEL = $channelLabel
    $env:HAPPIER_DAEMON_SERVICE_CHANNEL = $channelLabel
    if ($env:HAPPIER_INSTALLER_DAEMON_SERVICE_STRATEGY) {
      $env:HAPPIER_INSTALLER_DAEMON_SERVICE_STRATEGY = $env:HAPPIER_INSTALLER_DAEMON_SERVICE_STRATEGY
    }

    $process = Start-Process -FilePath $CliPath -ArgumentList $CommandArgs -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -WindowStyle Hidden
    $completed = $process.WaitForExit($timeoutMs)
    if (-not $completed) {
      Stop-InstallerProcessTree -Process $process

      $stdout = if (Test-Path $stdoutPath -PathType Leaf) { Get-Content -Path $stdoutPath -Raw -ErrorAction SilentlyContinue } else { "" }
      $stderr = if (Test-Path $stderrPath -PathType Leaf) { Get-Content -Path $stderrPath -Raw -ErrorAction SilentlyContinue } else { "" }
      $output = @("Pre-install command timed out after $timeoutMs ms: $($CommandArgs -join ' ')", $stdout, $stderr) -join ""
      return @{
        ExitCode = 124
        Output = [string]$output
        TimedOut = $true
      }
    }

    $stdout = if (Test-Path $stdoutPath -PathType Leaf) { Get-Content -Path $stdoutPath -Raw -ErrorAction SilentlyContinue } else { "" }
    $stderr = if (Test-Path $stderrPath -PathType Leaf) { Get-Content -Path $stderrPath -Raw -ErrorAction SilentlyContinue } else { "" }
    $output = @($stdout, $stderr) -join ""

    return @{
      ExitCode = [int]$process.ExitCode
      Output = [string]$output
      TimedOut = $false
    }
  }
  finally {
    Remove-Item -Path $stdoutPath -Force -ErrorAction SilentlyContinue
    Remove-Item -Path $stderrPath -Force -ErrorAction SilentlyContinue

    if ($null -eq $previousHomeDir) {
      Remove-Item Env:HAPPIER_HOME_DIR -ErrorAction SilentlyContinue
    }
    else {
      $env:HAPPIER_HOME_DIR = $previousHomeDir
    }
    if ($null -eq $previousNoninteractive) {
      Remove-Item Env:HAPPIER_NONINTERACTIVE -ErrorAction SilentlyContinue
    }
    else {
      $env:HAPPIER_NONINTERACTIVE = $previousNoninteractive
    }
    if ($null -eq $previousPublicReleaseChannel) {
      Remove-Item Env:HAPPIER_PUBLIC_RELEASE_CHANNEL -ErrorAction SilentlyContinue
    }
    else {
      $env:HAPPIER_PUBLIC_RELEASE_CHANNEL = $previousPublicReleaseChannel
    }
    if ($null -eq $previousDaemonServiceChannel) {
      Remove-Item Env:HAPPIER_DAEMON_SERVICE_CHANNEL -ErrorAction SilentlyContinue
    }
    else {
      $env:HAPPIER_DAEMON_SERVICE_CHANNEL = $previousDaemonServiceChannel
    }
    if ($null -eq $previousInstallerDaemonServiceStrategy) {
      Remove-Item Env:HAPPIER_INSTALLER_DAEMON_SERVICE_STRATEGY -ErrorAction SilentlyContinue
    }
    else {
      $env:HAPPIER_INSTALLER_DAEMON_SERVICE_STRATEGY = $previousInstallerDaemonServiceStrategy
    }
  }
}

function Test-DoctorRepairPreflightLooksLikePlainDoctorReport {
  param (
    [Parameter()] [string] $Output = ""
  )

  # Mirror install.sh:823-862: an older CLI that doesn't understand
  # `doctor repair --json` may instead emit a plain-text "Happier CLI Doctor"
  # report. We must reject that — even if portions of it accidentally parse
  # as JSON — and fall through to the legacy `service list --json` probe.
  return $Output -match 'Happier CLI Doctor'
}

function Test-DoctorRepairPreflightJsonIsSupported {
  param (
    [Parameter()] [string] $Output = ""
  )

  # Mirror install.sh's `background_service_inventory_json_is_supported`:
  # the trimmed payload must be a single JSON object (starts with `{`, ends
  # with `}`) AND must contain at least one of the known inventory keys
  # (`entries`, `services`, `existingServices`).
  $trimmed = $Output.Trim()
  if (-not $trimmed.StartsWith('{') -or -not $trimmed.EndsWith('}')) {
    return $false
  }
  return $trimmed -match '"(entries|services|existingServices)"\s*:'
}

function Get-InstalledBackgroundServiceInventory {
  param (
    [Parameter(Mandatory = $true)] [string] $CliPath
  )

  try {
    $doctorPreflightResult = Invoke-NativeCommandCapturingOutput {
      Invoke-InstallerCommandWithDaemonServiceContext -CliPath $CliPath -CommandArgs @("doctor", "repair", "--json") -HomeDir $DaemonServiceStateHomeDir
    }
    $preflightOutput = if ($doctorPreflightResult.Output) { [string]$doctorPreflightResult.Output } else { "" }
    $preflightLooksLikePlainReport = Test-DoctorRepairPreflightLooksLikePlainDoctorReport -Output $preflightOutput
    $preflightJsonIsSupported = Test-DoctorRepairPreflightJsonIsSupported -Output $preflightOutput
    if ($doctorPreflightResult.ExitCode -eq 0 -and $preflightJsonIsSupported -and -not $preflightLooksLikePlainReport) {
      $payload = $preflightOutput | ConvertFrom-Json
      $propertyNames = @($payload.PSObject.Properties.Name)
      $entries = if ($propertyNames -contains 'entries') { @($payload.entries) } elseif ($propertyNames -contains 'existingServices') { @($payload.existingServices) } else { @() }
      $services = if ($propertyNames -contains 'services') { @($payload.services) } elseif ($propertyNames -contains 'existingServices') { @($payload.existingServices) } else { @() }
      if ($entries.Count -gt 0 -or $services.Count -gt 0 -or $propertyNames -contains 'existingServices' -or $propertyNames -contains 'entries' -or $propertyNames -contains 'services') {
        return @{
          Supported = $true
          RepairSupported = $true
          Entries = if ($entries.Count -gt 0) { $entries } elseif ($services.Count -gt 0) { $services } else { @() }
          Services = $services
          DaemonStatus = if ($propertyNames -contains 'daemonStatus') { $payload.daemonStatus } else { $null }
          DaemonRunning = if ($propertyNames -contains 'daemonRunning') { $payload.daemonRunning } else { $null }
          DefaultFollowingMatchesSelectedReleaseChannel = if ($propertyNames -contains 'defaultFollowingMatchesSelectedReleaseChannel') { $payload.defaultFollowingMatchesSelectedReleaseChannel } else { $null }
          Relays = if ($propertyNames -contains 'relays') { @($payload.relays) } else { @() }
          Payload = $payload
        }
      }
    }
    elseif (-not $preflightLooksLikePlainReport `
        -and -not $preflightJsonIsSupported `
        -and -not (Test-InstallerCommandLooksUnsupported -Output $preflightOutput)) {
      Write-Warning "Automatic startup inspection failed; continuing without blocking install. You can retry manually: `"$CliPath doctor repair`""
    }
  }
  catch {
    Write-Warning "Automatic startup inspection failed; continuing without blocking install. You can retry manually: `"$CliPath doctor repair`""
  }

  try {
    $serviceListResult = Invoke-NativeCommandCapturingOutput {
      Invoke-InstallerCommandWithDaemonServiceContext -CliPath $CliPath -CommandArgs @("service", "list", "--json") -HomeDir $DaemonServiceStateHomeDir
    }
    if ($serviceListResult.ExitCode -ne 0 -or -not $serviceListResult.Output) {
      return @{
        Supported = $false
        RepairSupported = $false
        Entries = @()
        Services = @()
        DaemonStatus = $null
        DaemonRunning = $null
        Relays = @()
        Payload = $null
      }
    }
    $payload = $serviceListResult.Output | ConvertFrom-Json
    $propertyNames = @($payload.PSObject.Properties.Name)
    $entries = if ($propertyNames -contains 'entries') { @($payload.entries) } else { @() }
    $services = if ($propertyNames -contains 'services') { @($payload.services) } else { @() }
    if ($entries.Count -gt 0 -or $services.Count -gt 0 -or $propertyNames -contains 'entries' -or $propertyNames -contains 'services') {
      return @{
        Supported = $true
        RepairSupported = $false
        Entries = if ($entries.Count -gt 0) { $entries } elseif ($services.Count -gt 0) { $services } else { @() }
        Services = $services
        DaemonStatus = $null
        DaemonRunning = $null
        DefaultFollowingMatchesSelectedReleaseChannel = $null
        Relays = @()
        Payload = $payload
      }
    }
  }
  catch {
    return @{
      Supported = $false
      RepairSupported = $false
      Entries = @()
      Services = @()
      DaemonStatus = $null
      DaemonRunning = $null
      DefaultFollowingMatchesSelectedReleaseChannel = $null
      Relays = @()
      Payload = $null
    }
  }

  return @{
    Supported = $false
    RepairSupported = $false
    Entries = @()
    Services = @()
    DaemonStatus = $null
    DaemonRunning = $null
    DefaultFollowingMatchesSelectedReleaseChannel = $null
    Relays = @()
    Payload = $null
  }
}

function Test-BackgroundServiceInventoryHasDefaultFollowing {
  param (
    [Parameter(Mandatory = $true)] [object[]] $Entries
  )

  return @($Entries | Where-Object { $_.targetMode -eq 'default-following' }).Count -gt 0
}

function Get-BackgroundServiceDefaultFollowingChannel {
  param (
    [Parameter(Mandatory = $true)] [object[]] $Entries
  )

  $entry = @($Entries | Where-Object { $_.targetMode -eq 'default-following' } | Select-Object -First 1)
  if ($entry.Count -eq 0 -or -not $entry[0].releaseChannel) {
    return ""
  }

  return Get-InstallerDisplayChannelLabel -Value ([string]$entry[0].releaseChannel)
}

function Test-BackgroundServiceInventoryHasMatchingDefaultFollowing {
  param (
    [Parameter(Mandatory = $true)] [object[]] $Entries,
    [Parameter()] $DefaultFollowingMatchesSelectedReleaseChannel = $null
  )

  # Mirror install.sh:1037-1056: prefer the CLI-emitted authoritative signal
  # `defaultFollowingMatchesSelectedReleaseChannel` when present. The CLI
  # knows about default-shim resolution that the installer can't easily
  # reconstruct from a label comparison alone (matters for multi-channel
  # installs where the default shim points to a non-current channel).
  if ($null -ne $DefaultFollowingMatchesSelectedReleaseChannel) {
    return [bool]$DefaultFollowingMatchesSelectedReleaseChannel
  }

  $defaultChannel = Get-BackgroundServiceDefaultFollowingChannel -Entries $Entries
  if (-not $defaultChannel) {
    return $false
  }

  return $defaultChannel -eq (Get-InstallerDisplayChannelLabel -Value $Channel)
}

function Test-InstallerCommandLooksUnsupported {
  param (
    [Parameter()] [string] $Output = ""
  )

  return $Output -match '(?i)unknown (option|command|subcommand)|invalid option|usage: happier <command>|does not support'
}

function Get-BackgroundServiceInstallManualCommand {
  param (
    [Parameter(Mandatory = $true)] [string] $CliPath
  )

  return "$CliPath service install"
}

function Invoke-BackgroundServiceInstallCompatibly {
  param (
    [Parameter(Mandatory = $true)] [string] $CliPath
  )

  $installResult = Invoke-NativeCommandCapturingOutput {
    Invoke-InstallerCommandWithDaemonServiceContext -CliPath $CliPath -CommandArgs @("service", "install", "--yes") -HomeDir $DaemonServiceStateHomeDir
  }
  if ($installResult.ExitCode -eq 0) {
    return @{
      Ok = $true
      Output = $installResult.Output
    }
  }

  if (Test-InstallerCommandLooksUnsupported -Output $installResult.Output) {
    $legacyInstallResult = Invoke-NativeCommandCapturingOutput {
      Invoke-InstallerCommandWithDaemonServiceContext -CliPath $CliPath -CommandArgs @("service", "install") -HomeDir $DaemonServiceStateHomeDir
    }
    if ($legacyInstallResult.ExitCode -eq 0) {
      return @{
        Ok = $true
        Output = $legacyInstallResult.Output
      }
    }
    return @{
      Ok = $false
      Output = $legacyInstallResult.Output
    }
  }

  return @{
    Ok = $false
    Output = $installResult.Output
  }
}

function Invoke-DoctorRepairIfSupported {
  param (
    [Parameter(Mandatory = $true)] [string] $CliPath
  )

  $repairResult = Invoke-NativeCommandCapturingOutput {
    Invoke-InstallerCommandWithDaemonServiceContext -CliPath $CliPath -CommandArgs @("doctor", "repair", "--yes") -HomeDir $DaemonServiceStateHomeDir
  }
  if ($repairResult.ExitCode -eq 0) {
    return @{
      Status = 'applied'
      Output = $repairResult.Output
    }
  }
  if (Test-InstallerCommandLooksUnsupported -Output $repairResult.Output) {
    return @{
      Status = 'unsupported'
      Output = $repairResult.Output
    }
  }
  return @{
    Status = 'failed'
    Output = $repairResult.Output
  }
}

function Resolve-ExistingBackgroundServiceInstallStrategy {
  param (
    [Parameter(Mandatory = $true)] [object[]] $Entries,
    [Parameter()] $DefaultFollowingMatchesSelectedReleaseChannel = $null
  )

  if ($Noninteractive -eq "1") {
    return ""
  }

  if ($Entries.Count -eq 0) {
    return ""
  }

  if (Test-BackgroundServiceInventoryHasMatchingDefaultFollowing -Entries $Entries -DefaultFollowingMatchesSelectedReleaseChannel $DefaultFollowingMatchesSelectedReleaseChannel) {
    return "skip"
  }

  $replacePrompt = "Use this installation for automatic startup?"
  if (Test-BackgroundServiceInventoryHasDefaultFollowing -Entries $Entries) {
    $replacePrompt = "Use this installation for automatic startup?"
  }

  $replaceChoice = Read-InstallerYesNoChoice -Prompt $replacePrompt -DefaultChoice "1"
  if ($replaceChoice -eq "1") {
    return "replace-all"
  }

  if (Test-BackgroundServiceInventoryHasDefaultFollowing -Entries $Entries) {
    return "skip"
  }

  $addChoice = Read-InstallerYesNoChoice -Prompt "Install an additional background service alongside the existing one(s)?" -DefaultChoice "0"
  if ($addChoice -eq "1") {
    return "add"
  }

  return "skip"
}

function Get-SupportedSetupRelayDefaultArgs {
  param (
    [Parameter(Mandatory = $true)] [string] $CliPath
  )

  $defaultArgs = @("--mode", "user", "--yes", "--channel", $(if ($Channel -eq "publicdev") { "dev" } else { $Channel }), "--preserve-active-server")
  $helpResult = Invoke-NativeCommandCapturingOutput {
    & $CliPath relay host install --help
  }
  $helpOutput = [string]$helpResult.Output
  if ([string]::IsNullOrWhiteSpace($helpOutput)) {
    return $defaultArgs
  }

  $filteredArgs = @()
  if ($helpOutput -match '(?m)--mode\b') {
    $filteredArgs += @("--mode", "user")
  }
  if ($helpOutput -match '(?m)--yes\b') {
    $filteredArgs += @("--yes")
  }
  if ($helpOutput -match '(?m)--channel\b') {
    $filteredArgs += @("--channel", $(if ($Channel -eq "publicdev") { "dev" } else { $Channel }))
  }
  if ($helpOutput -match '(?m)--preserve-active-server\b') {
    $filteredArgs += @("--preserve-active-server")
  }
  return $filteredArgs
}

# Root help is asked for once per surface check; a real CLI start-up is slow
# enough that repeating it on the first-run path is worth avoiding.
$script:InstalledCliRootHelpPath = ""
$script:InstalledCliRootHelp = ""

function Get-InstalledCliRootHelp {
  param (
    [Parameter(Mandatory = $true)] [string] $CliPath
  )

  if ($script:InstalledCliRootHelpPath -ne $CliPath) {
    $help = ""
    try {
      $help = (& $CliPath --help 2>$null | Out-String)
    }
    catch {
      $help = ""
    }
    $script:InstalledCliRootHelp = [string]$help
    $script:InstalledCliRootHelpPath = $CliPath
  }
  return $script:InstalledCliRootHelp
}

# Mirror install.sh's installed_cli_supports_command_surface: the single owner for
# "does the installed CLI actually expose this command surface?". Older CLI builds
# let an unknown subcommand fall through into the default "start a session" path,
# which can prompt for authentication, so every installer-initiated invocation
# checks the CLI's own help first.
function Test-InstalledCliSupportsCommandSurface {
  param (
    [Parameter(Mandatory = $true)] [string] $CliPath,
    # Deliberately lower-cased: installers_windows_run_actions pins the exact
    # `$pattern` literal below, including the variable name it interpolates.
    [Parameter(Mandatory = $true)] [string] $requiredSubcommand
  )

  $invokerName = (Split-Path -Leaf $CliPath)
  if ([string]::IsNullOrWhiteSpace($invokerName)) { $invokerName = "happier" }

  $helpOutput = ""
  if ($requiredSubcommand -eq "relay") {
    try {
      $helpOutput = (& $CliPath relay --help 2>$null | Out-String)
    }
    catch {
      $helpOutput = ""
    }
  }
  else {
    $helpOutput = Get-InstalledCliRootHelp -CliPath $CliPath
  }

  $pattern = "(?m)^\s*($([Regex]::Escape($invokerName))|happier)\s+$([Regex]::Escape($requiredSubcommand))\b"
  return [bool]($helpOutput -match $pattern)
}

# `happier setup` is the CLI's own guided first run. The installer hands off to
# it after the binary is ready; every question a first run needs to ask belongs
# to the CLI.
# Whether this computer already has an account on its active relay. Ask the CLI
# instead of re-deriving credential paths here: which credential file counts
# depends on the active relay profile, and that is the CLI's to own.
$script:PostInstallMachineIsConfigured = $false
# Whether guided setup has already been completed during this installer run.
$script:PostInstallSetupIsDone = $false

function Test-InstalledCliReportsConfiguredMachine {
  param (
    [Parameter(Mandatory = $true)] [string] $CliPath
  )

  if (-not (Test-InstalledCliSupportsCommandSurface -CliPath $CliPath -requiredSubcommand "auth")) {
    return $false
  }

  try {
    $statusResult = Invoke-InstallerCommandWithDaemonServiceContextCapturingOutputWithTimeout `
      -CliPath $CliPath `
      -CommandArgs @("auth", "status", "--json") `
      -HomeDir $DaemonServiceStateHomeDir `
      -TimeoutMs (Resolve-InstallerPreInstallCommandTimeoutMs)
  }
  catch {
    return $false
  }

  $statusJson = [string]$statusResult.Output
  return [bool](
    ($statusJson -match '"authenticated"\s*:\s*true') -and
    ($statusJson -match '"machineRegistered"\s*:\s*true')
  )
}

# Hand off only when a person is actually watching. -Yes / -NonInteractive,
# HAPPIER_NONINTERACTIVE=1 and redirected stdin all mean "decline optional
# setup", exactly like the background-service prompt. An already-configured
# machine is left alone: a re-install is not a first run.
function Test-ShouldHandOffToGuidedSetup {
  param (
    [Parameter(Mandatory = $true)] [string] $CliPath
  )

  if ($InstallerAction -ne "install") { return $false }
  if ($script:PostInstallMachineIsConfigured) { return $false }
  if (-not (Test-InteractiveInstallerPromptAvailable)) { return $false }
  return (Test-InstalledCliSupportsCommandSurface -CliPath $CliPath -requiredSubcommand "setup")
}

# The one-liner must never end on a version string. Name the commands that take
# the user forward from wherever this install actually left them -- and never
# point an already-configured machine back at setup.
function Write-PostInstallGetStarted {
  param (
    [Parameter(Mandatory = $true)] [string] $CliName
  )

  Write-Host ""
  Write-Host "Get started"
  if (-not $script:PostInstallSetupIsDone) {
    Write-Host ("  {0,-20} {1}" -f "$CliName setup", "Connect this computer and sign in")
  }
  Write-Host ("  {0,-20} {1}" -f $CliName, "Start a session")
  Write-Host ("  {0,-20} {1}" -f "$CliName status", "Check this computer's connection")
}

function Invoke-PostInstallAction {
  param (
    [Parameter(Mandatory = $true)] [string] $CliPath
  )

  $setupRelayDefaultArgs = @("--mode", "user", "--yes", "--channel", $(if ($Channel -eq "publicdev") { "dev" } else { $Channel }), "--preserve-active-server")
  if ($SetupRelay -and -not $Run) {
    $Run = "setup-relay"
  }
  if (-not $Run) {
    return
  }

  $runValue = $Run.Trim().ToLowerInvariant()
  if ($runValue -eq "setup-relay" -and $setupRelayDefaultArgs.Count -eq 0) {
    $setupRelayDefaultArgs = @("--mode", "user", "--yes", "--channel", $(if ($Channel -eq "publicdev") { "dev" } else { $Channel }), "--preserve-active-server")
  }
  if ($runValue -eq "setup-relay") {
    $setupRelayDefaultArgs = Get-SupportedSetupRelayDefaultArgs -CliPath $CliPath
  }
  $requiredSubcommand = $null
  $argsToPass = @()
  switch ($runValue) {
    "setup-relay" {
      $argsToPass = @("relay", "host", "install") + $setupRelayDefaultArgs + $RunArgs
      $requiredSubcommand = "relay"
    }
    "relay-host-install" {
      $argsToPass = @("relay", "host", "install") + $RunArgs
      $requiredSubcommand = "relay"
    }
    "setup" {
      $argsToPass = @("setup") + $RunArgs
      $requiredSubcommand = "setup"
    }
    "auth-login" {
      $argsToPass = @("auth", "login") + $RunArgs
      $requiredSubcommand = "auth"
    }
    "service-install" {
      $argsToPass = @("service", "install") + $RunArgs
      $requiredSubcommand = "service"
    }
    "daemon-install" {
      $argsToPass = @("service", "install") + $RunArgs
      $requiredSubcommand = "service"
    }
    "providers-setup" {
      $argsToPass = @("providers", "setup") + $RunArgs
      $requiredSubcommand = "providers"
    }
    default {
      throw "Unknown -Run action '$Run'. Expected one of: setup-relay, setup, auth-login, service-install, providers-setup."
    }
  }

  if ($requiredSubcommand) {
    if (-not (Test-InstalledCliSupportsCommandSurface -CliPath $CliPath -requiredSubcommand $requiredSubcommand)) {
      throw "Installed Happier CLI does not support the '$requiredSubcommand' command surface required for -Run $runValue. Update your Happier CLI (or switch installer channel) and try again."
    }
  }
  Invoke-InstallerCommandWithDaemonServiceContext -CliPath $CliPath -CommandArgs $argsToPass -HomeDir $DaemonServiceStateHomeDir
}

if ($InstallerAction -eq "payload-reversion") {
  Invoke-InstallerCliPayloadReversion
  exit 0
}

if ($Run -and -not $SetupRelay -and ($existing = Resolve-InstalledCliInvoker)) {
  $script:LastInstallerCommandExitCode = 0
  Invoke-PostInstallAction -CliPath $existing
  exit $script:LastInstallerCommandExitCode
}

function Get-ReleaseAssetVersionFromName {
  param (
    [Parameter(Mandatory = $true)] [string] $Name
  )

  if ($Name -match '^checksums-.+-v(.+)\.txt\.minisig$') {
    return $matches[1]
  }
  if ($Name -match '^checksums-.+-v(.+)\.txt$') {
    return $matches[1]
  }
  if ($Name -match '^.+-v(.+)-(?:linux-(?:x64|arm64)|darwin-(?:x64|arm64)|windows-x64)\.tar\.gz$') {
    return $matches[1]
  }
  return ""
}

function Get-ReleaseAssetVersionSortKey {
  param (
    [Parameter(Mandatory = $true)] [string] $Name
  )

  $version = Get-ReleaseAssetVersionFromName -Name $Name
  if (-not $version) {
    return $Name
  }

  $versionWithoutBuild = $version -replace '\+.*$', ''
  $core = $versionWithoutBuild
  $prerelease = ""
  if ($versionWithoutBuild.Contains('-')) {
    $versionParts = $versionWithoutBuild -split '-', 2
    $core = $versionParts[0]
    $prerelease = $versionParts[1]
  }

  $coreParts = $core -split '\.'
  $major = if ($coreParts.Length -gt 0 -and $coreParts[0] -match '^\d+$') { [int]$coreParts[0] } else { 0 }
  $minor = if ($coreParts.Length -gt 1 -and $coreParts[1] -match '^\d+$') { [int]$coreParts[1] } else { 0 }
  $patch = if ($coreParts.Length -gt 2 -and $coreParts[2] -match '^\d+$') { [int]$coreParts[2] } else { 0 }
  $sortKey = '{0:D9}|{1:D9}|{2:D9}|' -f $major, $minor, $patch

  if (-not $prerelease) {
    return "${sortKey}1|stable|$Name"
  }

  $releaseKind = if ($prerelease -match '^preview(?:\.|$)') {
    'preview'
  }
  elseif ($prerelease -match '^dev(?:\.|$)') {
    'dev'
  }
  else {
    'prerelease'
  }
  $prereleaseRank = '0|'
  foreach ($part in ($prerelease -split '\.')) {
    if ($part -match '^\d+$') {
      $prereleaseRank += '0|{0:D9}|' -f [int]$part
    }
    else {
      $prereleaseRank += "1|$part|"
    }
  }
  return "$sortKey$prereleaseRank$releaseKind|$Name"
}

function Get-AssetByPattern {
  param (
    [Parameter(Mandatory = $true)] [object] $Release,
    [Parameter(Mandatory = $true)] [string] $Pattern
  )
  $selected = $null
  $selectedSortKey = ""
  foreach ($asset in @($Release.assets | Where-Object { $_.name -match $Pattern })) {
    $sortKey = Get-ReleaseAssetVersionSortKey -Name ([string]$asset.name)
    if ($null -eq $selected -or $sortKey -gt $selectedSortKey) {
      $selected = $asset
      $selectedSortKey = $sortKey
    }
  }
  return $selected
}

function Get-LocalAssetByPattern {
  param (
    [Parameter(Mandatory = $true)] [string] $Pattern
  )
  if (-not $ReleaseAssetsDir) {
    return $null
  }
  if (-not (Test-Path $ReleaseAssetsDir -PathType Container)) {
    throw "HAPPIER_RELEASE_ASSETS_DIR does not exist: $ReleaseAssetsDir"
  }
  $selected = $null
  $selectedSortKey = ""
  foreach ($asset in @(Get-ChildItem -Path $ReleaseAssetsDir -File | Where-Object { $_.Name -match $Pattern })) {
    $sortKey = Get-ReleaseAssetVersionSortKey -Name ([string]$asset.Name)
    if ($null -eq $selected -or $sortKey -gt $selectedSortKey) {
      $selected = $asset
      $selectedSortKey = $sortKey
    }
  }
  return $selected
}

function Resolve-InstallerRequestedVersionPattern {
  param (
    [Parameter(Mandatory = $true)] [string] $Prefix,
    [Parameter(Mandatory = $true)] [string] $Suffix
  )
  if ($Version) {
    return "^$([Regex]::Escape($Prefix))$([Regex]::Escape($Version))$([Regex]::Escape($Suffix))$"
  }
  $versionPattern = Resolve-InstallerDefaultVersionPattern
  return "^$([Regex]::Escape($Prefix))$versionPattern$([Regex]::Escape($Suffix))$"
}

function Resolve-InstallerDefaultVersionPattern {
  if ($Channel -eq 'preview') {
    return '[^-]+-preview(?:\.[0-9A-Za-z.+-]+)?'
  }
  if ($Channel -eq 'publicdev') {
    return '[^-]+-dev(?:\.[0-9A-Za-z.+-]+)?'
  }
  return '[^-]+'
}

function Resolve-InstallerAsset {
  param (
    [Parameter(Mandatory = $false)] [object] $Release,
    [Parameter(Mandatory = $true)] [string] $Pattern
  )
  $localAsset = Get-LocalAssetByPattern -Pattern $Pattern
  if ($localAsset) {
    return @{
      Name = $localAsset.Name
      Source = $localAsset.FullName
    }
  }

  $asset = Get-AssetByPattern -Release $Release -Pattern $Pattern
  if (-not $asset) {
    return $null
  }
  return @{
    Name = [string]$asset.name
    Source = [string]$asset.browser_download_url
  }
}

function Copy-OrDownloadInstallerAsset {
  param (
    [Parameter(Mandatory = $true)] [string] $Source,
    [Parameter(Mandatory = $true)] [string] $DestinationPath
  )
  if (Test-Path $Source) {
    Copy-Item -Path $Source -Destination $DestinationPath -Force
    return
  }
  Invoke-InstallerWebRequestWithRetry -Uri $Source -Headers $GitHubHeaders -OutFile $DestinationPath
}

function Test-InstallerTransientWebException {
  param (
    [Parameter(Mandatory = $true)] [System.Management.Automation.ErrorRecord] $ErrorRecord
  )

  $retryableStatusCodes = @(404, 502, 503, 504)
  $exception = $ErrorRecord.Exception
  $statusCode = $null
  if ($exception -and $exception.Response -and $exception.Response.StatusCode) {
    try {
      $statusCode = [int]$exception.Response.StatusCode
    }
    catch {
      $statusCode = $null
    }
  }
  if ($null -ne $statusCode -and $retryableStatusCodes -contains $statusCode) {
    return $true
  }

  $message = if ($exception) { [string]$exception.Message } else { [string]$ErrorRecord }
  foreach ($code in $retryableStatusCodes) {
    if ($message -match "(^|\D)$code(\D|$)") {
      return $true
    }
  }

  return $false
}

function Invoke-InstallerWebRequestWithRetry {
  param (
    [Parameter(Mandatory = $true)] [string] $Uri,
    [hashtable] $Headers,
    [string] $OutFile
  )

  $retryDelaysMs = @(250, 1000)
  for ($attempt = 0; $attempt -le $retryDelaysMs.Length; $attempt += 1) {
    try {
      $params = @{ Uri = $Uri; UseBasicParsing = $true }
      if ($Headers) {
        $params.Headers = $Headers
      }
      if ($OutFile) {
        $params.OutFile = $OutFile
      }
      return Invoke-WebRequest @params
    }
    catch {
      if ($attempt -ge $retryDelaysMs.Length -or -not (Test-InstallerTransientWebException -ErrorRecord $_)) {
        throw
      }
      Start-Sleep -Milliseconds $retryDelaysMs[$attempt]
    }
  }
}

function Invoke-InstallerRestMethodWithRetry {
  param (
    [Parameter(Mandatory = $true)] [string] $Uri,
    [hashtable] $Headers
  )

  $retryDelaysMs = @(250, 1000)
  for ($attempt = 0; $attempt -le $retryDelaysMs.Length; $attempt += 1) {
    try {
      $params = @{ Uri = $Uri }
      if ($Headers) {
        $params.Headers = $Headers
      }
      return Invoke-RestMethod @params
    }
    catch {
      if ($attempt -ge $retryDelaysMs.Length -or -not (Test-InstallerTransientWebException -ErrorRecord $_)) {
        throw
      }
      Start-Sleep -Milliseconds $retryDelaysMs[$attempt]
    }
  }
}

function Resolve-MinisignExecutablePath {
  param (
    [string[]] $AdditionalPathEntries = @()
  )

  $command = Get-Command minisign -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  $pathEntries = @()
  if ($env:Path) {
    $pathEntries += $env:Path -split ';'
  }
  $userPath = [Environment]::GetEnvironmentVariable("Path", [EnvironmentVariableTarget]::User)
  if ($userPath) {
    $pathEntries += $userPath -split ';'
  }
  $machinePath = [Environment]::GetEnvironmentVariable("Path", [EnvironmentVariableTarget]::Machine)
  if ($machinePath) {
    $pathEntries += $machinePath -split ';'
  }
  if ($env:LOCALAPPDATA) {
    $pathEntries += Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links"
    $pathEntries += Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages"
  }
  $pathEntries += $AdditionalPathEntries

  foreach ($pathEntry in $pathEntries) {
    $trimmedEntry = [string]$pathEntry
    if (-not $trimmedEntry) {
      continue
    }

    $candidate = Join-Path $trimmedEntry.Trim() "minisign.exe"
    if (Test-Path $candidate) {
      return $candidate
    }

    if ($trimmedEntry -match '[\\/]WinGet[\\/]Packages$' -and (Test-Path $trimmedEntry)) {
      $nestedCandidate = Get-ChildItem -Path $trimmedEntry.Trim() -Filter "minisign.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($nestedCandidate) {
        return $nestedCandidate.FullName
      }
    }
  }

  return $null
}

function Invoke-NativeCommandCapturingOutput {
  param (
    [Parameter(Mandatory = $true)] [scriptblock] $Command
  )

  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $output = & $Command 2>&1 | Out-String
    $exitCode = $LASTEXITCODE
    if ($null -eq $exitCode) {
      $exitCode = 1
    }
    return @{
      Output = if ($null -eq $output) { "" } else { $output }
      ExitCode = $exitCode
    }
  }
  finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
}

function Resolve-InstallerPayloadPromotionTimeoutMs {
  $raw = [string]$env:HAPPIER_INSTALLER_PAYLOAD_PROMOTION_TIMEOUT_MS
  if (-not $raw) {
    return 120000
  }
  $parsed = 0
  if (-not [int]::TryParse($raw.Trim(), [ref]$parsed)) {
    return 120000
  }
  if ($parsed -lt 30000) {
    return 30000
  }
  if ($parsed -gt 600000) {
    return 600000
  }
  return $parsed
}

function Normalize-InstallerLockHygienePathNeedle {
  param (
    [string] $Value
  )

  if (-not $Value) {
    return ""
  }

  $normalized = ([string]$Value).Trim()
  if ($normalized.Length -ge 2) {
    if (($normalized.StartsWith('"') -and $normalized.EndsWith('"')) -or ($normalized.StartsWith("'") -and $normalized.EndsWith("'"))) {
      $normalized = $normalized.Substring(1, $normalized.Length - 2).Trim()
    }
  }

  $normalized = $normalized.Replace('\', '/').ToLowerInvariant()
  while ($normalized.Length -gt 1 -and $normalized.EndsWith('/')) {
    $normalized = $normalized.Substring(0, $normalized.Length - 1)
  }

  return $normalized
}

function Resolve-InstallerLockHygieneExecutablePathFromCommandLine {
  param (
    [string] $CommandLine
  )

  if (-not $CommandLine) {
    return ""
  }

  $trimmed = ([string]$CommandLine).Trim()
  if (-not $trimmed) {
    return ""
  }

  if ($trimmed.StartsWith('"')) {
    $endQuote = $trimmed.IndexOf('"', 1)
    if ($endQuote -gt 1) {
      return $trimmed.Substring(1, $endQuote - 1)
    }
  }

  if ($trimmed.StartsWith("'")) {
    $endQuote = $trimmed.IndexOf("'", 1)
    if ($endQuote -gt 1) {
      return $trimmed.Substring(1, $endQuote - 1)
    }
  }

  $firstSpace = $trimmed.IndexOf(' ')
  if ($firstSpace -gt 0) {
    return $trimmed.Substring(0, $firstSpace)
  }

  return $trimmed
}

function Test-InstallerLockHygienePathInScope {
  param (
    [string] $CandidatePath,
    [Parameter(Mandatory = $true)] [string[]] $MatchNeedles
  )

  $candidate = Normalize-InstallerLockHygienePathNeedle -Value $CandidatePath
  if (-not $candidate) {
    return $false
  }

  foreach ($needle in $MatchNeedles) {
    $scope = Normalize-InstallerLockHygienePathNeedle -Value $needle
    if (-not $scope) {
      continue
    }

    $scopePrefix = "$scope/"
    if ($candidate.StartsWith($scopePrefix) -or $candidate -eq $scope) {
      return $true
    }
  }

  return $false
}

function Test-InstallerLockHygieneTextBoundaryCharacter {
  param (
    [string] $Character
  )

  if (-not $Character) {
    return $true
  }

  $boundaryCharacters = @(" ", "`t", "`r", "`n", '"', "'", "=", ";", ",", "(", ")", "[", "]", "{", "}")
  return $boundaryCharacters.Contains($Character)
}

function Test-InstallerLockHygieneTextContainsScopedPath {
  param (
    [string] $Text,
    [Parameter(Mandatory = $true)] [string[]] $MatchNeedles
  )

  $searchText = Normalize-InstallerLockHygienePathNeedle -Value $Text
  if (-not $searchText) {
    return $false
  }

  foreach ($needle in $MatchNeedles) {
    $scope = Normalize-InstallerLockHygienePathNeedle -Value $needle
    if (-not $scope) {
      continue
    }

    $startIndex = 0
    while ($startIndex -lt $searchText.Length) {
      $index = $searchText.IndexOf($scope, $startIndex, [System.StringComparison]::Ordinal)
      if ($index -lt 0) {
        break
      }

      $before = if ($index -eq 0) { "" } else { $searchText.Substring($index - 1, 1) }
      $afterIndex = $index + $scope.Length
      $after = if ($afterIndex -ge $searchText.Length) { "" } else { $searchText.Substring($afterIndex, 1) }
      $beforeOk = Test-InstallerLockHygieneTextBoundaryCharacter -Character $before
      $afterOk = $after -eq "/" -or (Test-InstallerLockHygieneTextBoundaryCharacter -Character $after)
      if ($beforeOk -and $afterOk) {
        return $true
      }

      $startIndex = $index + $scope.Length
    }
  }

  return $false
}

function Test-InstallerLockHygieneDaemonServiceLabelInScope {
  param (
    [string] $Label
  )

  $normalizedLabel = ([string]$Label).Trim().ToLowerInvariant().Replace("/", "\")
  if (-not $normalizedLabel) {
    return $false
  }

  $leafLabel = $normalizedLabel
  $lastSeparatorIndex = $leafLabel.LastIndexOf('\')
  if ($lastSeparatorIndex -ge 0) {
    if ($lastSeparatorIndex -ge ($leafLabel.Length - 1)) {
      return $false
    }
    $leafLabel = $leafLabel.Substring($lastSeparatorIndex + 1)
  }

  return $leafLabel -eq "happier-daemon" -or $leafLabel.StartsWith("happier-daemon.")
}

function Resolve-InstallerLockHygieneWaitMs {
  $raw = [string]$env:HAPPIER_INSTALLER_LOCK_HYGIENE_WAIT_MS
  if (-not $raw) {
    return 30000
  }

  $parsed = 0
  if (-not [int]::TryParse($raw.Trim(), [ref]$parsed)) {
    return 30000
  }
  if ($parsed -lt 5000) {
    return 5000
  }
  if ($parsed -gt 120000) {
    return 120000
  }
  return $parsed
}

function Get-InstallerLockHygieneMatchNeedles {
  param (
    [Parameter(Mandatory = $true)] [string] $InstallHomeDir
  )

  $cliInstallRoot = Join-Path $InstallHomeDir (Resolve-CliInstallRootName)
  $versionsRoot = Join-Path $cliInstallRoot "versions"
  $managedBinDir = Join-Path $InstallHomeDir "bin"
  $shimName = Resolve-CliShimName

  $candidates = @(
    $InstallHomeDir
    $cliInstallRoot
    $versionsRoot
    $managedBinDir
    (Join-Path $managedBinDir "$shimName.exe")
    (Join-Path $managedBinDir "$shimName")
    (Join-Path $managedBinDir "happier.exe")
    (Join-Path $managedBinDir "hprev.exe")
    (Join-Path $managedBinDir "hdev.exe")
  )

  $needles = New-Object System.Collections.Generic.List[string]
  foreach ($candidate in $candidates) {
    $normalized = Normalize-InstallerLockHygienePathNeedle -Value $candidate
    if ($normalized -and -not $needles.Contains($normalized)) {
      $needles.Add($normalized)
    }
  }

  return $needles.ToArray()
}

function Test-InstallerLockHygieneProcessIsQuiesceOwner {
  param (
    [string] $CommandLine
  )

  $normalizedCommandLine = ([string]$CommandLine).Trim().ToLowerInvariant()
  if (-not $normalizedCommandLine) {
    return $false
  }

  return (
    ($normalizedCommandLine -match '(^|\s)daemon\s+start(?:-sync)?(\s|$)') -or
    ($normalizedCommandLine -match '(^|\s)--version(\s|$)')
  )
}

function Get-InstallerScopedHappierProcesses {
  param (
    [Parameter(Mandatory = $true)] [string[]] $MatchNeedles
  )

  $happierProcessNames = @("happier", "hprev", "hdev")
  $processes = Get-CimInstance Win32_Process -Filter "Name='happier.exe' OR Name='hprev.exe' OR Name='hdev.exe'" -ErrorAction SilentlyContinue
  if (-not $processes) {
    return @()
  }

  $matched = New-Object System.Collections.Generic.List[object]
  foreach ($process in $processes) {
    if ($null -eq $process -or $process.ProcessId -eq $PID) {
      continue
    }

    $rawName = [string]$process.Name
    $normalizedName = $rawName.ToLowerInvariant()
    if ($normalizedName.EndsWith(".exe")) {
      $normalizedName = $normalizedName.Substring(0, $normalizedName.Length - 4)
    }
    if (-not ($happierProcessNames -contains $normalizedName)) {
      continue
    }

    if (-not (Test-InstallerLockHygieneProcessIsQuiesceOwner -CommandLine ([string]$process.CommandLine))) {
      continue
    }

    $commandExecutablePath = Resolve-InstallerLockHygieneExecutablePathFromCommandLine -CommandLine ([string]$process.CommandLine)
    $executablePath = [string]$process.ExecutablePath
    $matchesScope = (Test-InstallerLockHygienePathInScope -CandidatePath $executablePath -MatchNeedles $MatchNeedles) -or (Test-InstallerLockHygienePathInScope -CandidatePath $commandExecutablePath -MatchNeedles $MatchNeedles)

    if ($matchesScope) {
      $matched.Add($process)
    }
  }

  return $matched.ToArray()
}

function Get-InstallerScopedHappierServices {
  param (
    [Parameter(Mandatory = $true)] [string[]] $MatchNeedles
  )

  $services = Get-CimInstance Win32_Service -ErrorAction SilentlyContinue
  if (-not $services) {
    return @()
  }

  $matched = New-Object System.Collections.Generic.List[object]
  foreach ($service in $services) {
    if ($null -eq $service) {
      continue
    }

    $matchesDaemonServiceLabel =
      (Test-InstallerLockHygieneDaemonServiceLabelInScope -Label $service.Name) -or
      (Test-InstallerLockHygieneDaemonServiceLabelInScope -Label $service.DisplayName)
    if (-not $matchesDaemonServiceLabel) {
      continue
    }

    $activeServiceStates = @("running", "start pending", "stop pending", "continue pending", "pause pending")
    $serviceState = ([string]$service.State).Trim().ToLowerInvariant()
    if ($serviceState -and -not $activeServiceStates.Contains($serviceState)) {
      continue
    }

    $servicePathText = [string]$service.PathName
    $serviceExecutablePath = Resolve-InstallerLockHygieneExecutablePathFromCommandLine -CommandLine $servicePathText
    if (
      (Test-InstallerLockHygienePathInScope -CandidatePath $serviceExecutablePath -MatchNeedles $MatchNeedles) -or
      (Test-InstallerLockHygieneTextContainsScopedPath -Text $servicePathText -MatchNeedles $MatchNeedles)
    ) {
      $matched.Add($service)
    }
  }

  return $matched.ToArray()
}

function Get-InstallerScopedHappierScheduledTasks {
  param (
    [Parameter(Mandatory = $true)] [string[]] $MatchNeedles
  )

  $tasks = @()
  try {
    $tasks = Get-ScheduledTask -TaskPath "\Happier\" -ErrorAction SilentlyContinue
  }
  catch {
    return @()
  }
  if (-not $tasks) {
    return @()
  }

  $activeTaskStates = @("running", "queued")
  $matched = New-Object System.Collections.Generic.List[object]
  foreach ($task in $tasks) {
    if ($null -eq $task) {
      continue
    }

    $taskLabel = "$([string]$task.TaskPath)$([string]$task.TaskName)"
    if (-not (Test-InstallerLockHygieneDaemonServiceLabelInScope -Label $taskLabel)) {
      continue
    }

    $taskState = ([string]$task.State).Trim().ToLowerInvariant()
    if ($taskState -and -not $activeTaskStates.Contains($taskState)) {
      continue
    }

    foreach ($action in @($task.Actions)) {
      if ($null -eq $action) {
        continue
      }

      $actionExecutablePath = Resolve-InstallerLockHygieneExecutablePathFromCommandLine -CommandLine ([string]$action.Execute)
      $actionText = "$([string]$action.Execute) $([string]$action.Arguments)"
      if (
        (Test-InstallerLockHygienePathInScope -CandidatePath $actionExecutablePath -MatchNeedles $MatchNeedles) -or
        (Test-InstallerLockHygieneTextContainsScopedPath -Text $actionText -MatchNeedles $MatchNeedles)
      ) {
        $matched.Add($task)
        break
      }
    }
  }

  return $matched.ToArray()
}

function Wait-InstallerLockHygieneProcessesToExit {
  param (
    [Parameter(Mandatory = $true)] [string[]] $MatchNeedles,
    [Parameter(Mandatory = $true)] [int] $WaitMs
  )

  $deadline = (Get-Date).AddMilliseconds($WaitMs)
  while ((Get-Date) -lt $deadline) {
    $remaining = Get-InstallerScopedHappierProcesses -MatchNeedles $MatchNeedles
    if ($remaining.Count -eq 0) {
      return @()
    }
    Start-Sleep -Milliseconds 250
  }

  return Get-InstallerScopedHappierProcesses -MatchNeedles $MatchNeedles
}

function Remove-StaleInstallerVersionBackups {
  param (
    [Parameter(Mandatory = $true)] [string] $InstallHomeDir
  )

  $versionsDir = Join-Path (Join-Path $InstallHomeDir (Resolve-CliInstallRootName)) "versions"
  if (-not (Test-Path $versionsDir -PathType Container)) {
    return
  }

  $backupDirectories = @(
    Get-ChildItem -Path $versionsDir -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match '\.bak-' }
  )

  foreach ($backupDirectory in $backupDirectories) {
    try {
      Remove-Item -Path $backupDirectory.FullName -Recurse -Force -ErrorAction Stop
    }
    catch {
      Write-Warning "Failed to remove stale backup directory $($backupDirectory.FullName): $($_.Exception.Message)"
    }
  }
}

function Invoke-InstallerPreInstallLockHygiene {
  param (
    [Parameter(Mandatory = $true)] [string] $InstallHomeDir
  )

  $matchNeedles = Get-InstallerLockHygieneMatchNeedles -InstallHomeDir $InstallHomeDir
  $existingInvoker = Resolve-InstalledCliInvoker
  if ($existingInvoker) {
    $preInstallCommandTimeoutMs = Resolve-InstallerPreInstallCommandTimeoutMs
    foreach ($commandArgs in @(
        @("service", "stop", "--transfer-managed-local-services", "--json"),
        @("daemon", "stop", "--all", "--transfer-managed-local-services", "--json")
      )) {
      try {
        $commandResult = Invoke-InstallerCommandWithDaemonServiceContextCapturingOutputWithTimeout -CliPath $existingInvoker -CommandArgs $commandArgs -HomeDir $InstallHomeDir -TimeoutMs $preInstallCommandTimeoutMs
        if ([int]$commandResult.ExitCode -ne 0) {
          $output = ([string]$commandResult.Output).Trim()
          if ($commandResult.TimedOut) {
            Write-Warning "Pre-install lock hygiene command timed out after $preInstallCommandTimeoutMs ms ($($commandArgs -join ' ')); continuing with scoped process cleanup."
          }
          else {
            Write-Warning "Pre-install lock hygiene command exited with code $($commandResult.ExitCode) ($($commandArgs -join ' ')); continuing with scoped process cleanup."
          }
          if ($output) {
            Write-Warning "Pre-install lock hygiene command output ($($commandArgs -join ' ')): $output"
          }
        }
      }
      catch {
        Write-Warning "Pre-install lock hygiene command failed ($($commandArgs -join ' ')): $($_.Exception.Message)"
      }
    }
  }

  $matchingProcesses = Get-InstallerScopedHappierProcesses -MatchNeedles $matchNeedles
  foreach ($process in $matchingProcesses) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  }

  $waitMs = Resolve-InstallerLockHygieneWaitMs
  $remainingProcesses = Wait-InstallerLockHygieneProcessesToExit -MatchNeedles $matchNeedles -WaitMs $waitMs
  if ($remainingProcesses.Count -gt 0) {
    $details = $remainingProcesses |
      ForEach-Object {
        "$($_.ProcessId):$([string]$_.Name)"
      } |
      Sort-Object -Unique
    throw "Pre-install lock hygiene failed to quiesce managed runtime holders within $waitMs ms: $($details -join ', ')"
  }

  $remainingServices = Get-InstallerScopedHappierServices -MatchNeedles $matchNeedles
  if ($remainingServices.Count -gt 0) {
    $details = $remainingServices |
      ForEach-Object {
        "$([string]$_.Name):$([string]$_.State)"
      } |
      Sort-Object -Unique
    throw "Pre-install lock hygiene found scoped managed services still active after cleanup: $($details -join ', ')"
  }

  $remainingScheduledTasks = Get-InstallerScopedHappierScheduledTasks -MatchNeedles $matchNeedles
  if ($remainingScheduledTasks.Count -gt 0) {
    $details = $remainingScheduledTasks |
      ForEach-Object {
        "$([string]$_.TaskPath)$([string]$_.TaskName):$([string]$_.State)"
      } |
      Sort-Object -Unique
    throw "Pre-install lock hygiene found scoped managed scheduled tasks still active after cleanup: $($details -join ', ')"
  }

  Remove-StaleInstallerVersionBackups -InstallHomeDir $InstallHomeDir
}

function Resolve-InstallerPowerShellExecutablePath {
  $currentHostExecutableName = if ($PSVersionTable -and $PSVersionTable.PSEdition -eq "Core") {
    "pwsh.exe"
  }
  else {
    "powershell.exe"
  }

  if ($PSHOME) {
    $currentHostExecutablePath = Join-Path $PSHOME $currentHostExecutableName
    if (Test-Path -LiteralPath $currentHostExecutablePath -PathType Leaf) {
      return $currentHostExecutablePath
    }
  }

  foreach ($commandName in @("pwsh.exe", "pwsh", "powershell.exe", "powershell")) {
    $command = Get-Command -Name $commandName -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command -and $command.Source -and (Test-Path -LiteralPath $command.Source -PathType Leaf)) {
      return $command.Source
    }
  }

  throw "Unable to locate PowerShell executable for installer payload promotion."
}

function Invoke-InstallerPayloadPromotionWithTimeout {
  param (
    [Parameter(Mandatory = $true)] [string] $BinaryPath,
    [Parameter(Mandatory = $true)] [string] $PayloadRoot,
    [Parameter(Mandatory = $true)] [string] $Version,
    [Parameter(Mandatory = $true)] [string] $ChannelValue,
    [Parameter(Mandatory = $true)] [string] $InstallHomeDir
  )

  $timeoutMs = Resolve-InstallerPayloadPromotionTimeoutMs
  $runToken = [System.Guid]::NewGuid().ToString("N")
  $runnerBinaryPath = Join-Path $env:TEMP "happier-payload-promotion-$runToken.exe"
  $runnerScriptPath = Join-Path $env:TEMP "happier-payload-promotion-$runToken.ps1"
  $stdoutPath = Join-Path $env:TEMP "happier-payload-promotion-$runToken.stdout.log"
  $stderrPath = Join-Path $env:TEMP "happier-payload-promotion-$runToken.stderr.log"

  $escapeSingleQuotedLiteral = {
    param([string] $Value)
    return $Value.Replace("'", "''")
  }

  $runnerScript = @"
`$ErrorActionPreference = 'Stop'
`$previousHappyHomeDir = `$env:HAPPIER_HOME_DIR
`$previousSkipPayloadOwnerStopCommands = `$env:HAPPIER_CLI_SKIP_PAYLOAD_OWNER_STOP_COMMANDS
`$previousSkipInstallPayloadMigration = `$env:HAPPIER_CLI_SKIP_INSTALL_PAYLOAD_MIGRATION
try {
  `$env:HAPPIER_HOME_DIR = '$(& $escapeSingleQuotedLiteral $InstallHomeDir)'
  `$env:HAPPIER_CLI_SKIP_PAYLOAD_OWNER_STOP_COMMANDS = '1'
  `$env:HAPPIER_CLI_SKIP_INSTALL_PAYLOAD_MIGRATION = '1'
  & '$(& $escapeSingleQuotedLiteral $runnerBinaryPath)' self __install-payload --component happier-cli --payload-root '$(& $escapeSingleQuotedLiteral $PayloadRoot)' --version '$(& $escapeSingleQuotedLiteral $Version)' --channel '$(& $escapeSingleQuotedLiteral $ChannelValue)'
  `$exitCode = `$LASTEXITCODE
  if (`$null -eq `$exitCode) {
    `$exitCode = 1
  }
  exit `$exitCode
}
finally {
  if (`$null -eq `$previousHappyHomeDir) {
    Remove-Item Env:HAPPIER_HOME_DIR -ErrorAction SilentlyContinue
  }
  else {
    `$env:HAPPIER_HOME_DIR = `$previousHappyHomeDir
  }
  if (`$null -eq `$previousSkipPayloadOwnerStopCommands) {
    Remove-Item Env:HAPPIER_CLI_SKIP_PAYLOAD_OWNER_STOP_COMMANDS -ErrorAction SilentlyContinue
  }
  else {
    `$env:HAPPIER_CLI_SKIP_PAYLOAD_OWNER_STOP_COMMANDS = `$previousSkipPayloadOwnerStopCommands
  }
  if (`$null -eq `$previousSkipInstallPayloadMigration) {
    Remove-Item Env:HAPPIER_CLI_SKIP_INSTALL_PAYLOAD_MIGRATION -ErrorAction SilentlyContinue
  }
  else {
    `$env:HAPPIER_CLI_SKIP_INSTALL_PAYLOAD_MIGRATION = `$previousSkipInstallPayloadMigration
  }
}
"@

  try {
    Copy-Item -Path $BinaryPath -Destination $runnerBinaryPath -Force
    Set-Content -Path $runnerScriptPath -Value $runnerScript -Encoding utf8

    $powerShellExecutablePath = Resolve-InstallerPowerShellExecutablePath
    $process = Start-Process -FilePath $powerShellExecutablePath -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $runnerScriptPath) -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -WindowStyle Hidden

    $completed = $process.WaitForExit($timeoutMs)
    if (-not $completed) {
      Stop-InstallerProcessTree -Process $process

      return @{
        ExitCode = 124
        Output = "Payload promotion timed out after $timeoutMs ms."
        TimedOut = $true
      }
    }

    $stdout = if (Test-Path $stdoutPath -PathType Leaf) { Get-Content -Path $stdoutPath -Raw -ErrorAction SilentlyContinue } else { "" }
    $stderr = if (Test-Path $stderrPath -PathType Leaf) { Get-Content -Path $stderrPath -Raw -ErrorAction SilentlyContinue } else { "" }
    $output = @($stdout, $stderr) -join ""

    return @{
      ExitCode = [int]$process.ExitCode
      Output = [string]$output
      TimedOut = $false
    }
  }
  finally {
    Remove-Item -Path $runnerBinaryPath -Force -ErrorAction SilentlyContinue
    Remove-Item -Path $runnerScriptPath -Force -ErrorAction SilentlyContinue
    Remove-Item -Path $stdoutPath -Force -ErrorAction SilentlyContinue
    Remove-Item -Path $stderrPath -Force -ErrorAction SilentlyContinue
  }
}

function Ensure-Minisign {
  param (
    [Parameter(Mandatory = $true)] [string] $TempRoot
  )
  $existingMinisign = Resolve-MinisignExecutablePath
  if ($existingMinisign) {
    return $existingMinisign
  }

  # Self-contained fallback: download a known minisign release asset.
  $minisignVersion = "0.12"
  $asset = "minisign-$minisignVersion-win64.zip"
  $expectedSha = "37b600344e20c19314b2e82813db2bfdcc408b77b876f7727889dbd46d539479"
  $zipPath = Join-Path $TempRoot $asset
  Invoke-InstallerWebRequestWithRetry -Uri "https://github.com/jedisct1/minisign/releases/download/$minisignVersion/$asset" -OutFile $zipPath
  $actualSha = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualSha -ne $expectedSha) {
    throw "minisign bootstrap checksum mismatch (expected $expectedSha, got $actualSha)."
  }

  $extractDir = Join-Path $TempRoot "minisign-extract"
  New-Item -ItemType Directory -Path $extractDir -Force | Out-Null
  Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force
  $exe = Get-ChildItem -Path $extractDir -Filter "minisign.exe" -Recurse | Select-Object -First 1
  if (-not $exe) {
    throw "Failed to locate minisign.exe in bootstrap archive."
  }

  try {
    & $exe.FullName --version *> $null
  }
  catch {
    Write-Warning "Downloaded minisign binary is not compatible with this system. Attempting install via winget..."
    try {
      $wingetInstallResult = Invoke-NativeCommandCapturingOutput {
        winget install --id jedisct1.minisign --accept-source-agreements --accept-package-agreements
      }
      if ($wingetInstallResult.ExitCode -ne 0 -and $wingetInstallResult.Output) {
        Write-Warning $wingetInstallResult.Output.Trim()
      }
      $wingetMinisign = Resolve-MinisignExecutablePath
      if ($wingetMinisign) {
        return $wingetMinisign
      }
      if ($wingetInstallResult.ExitCode -ne 0) {
        throw "winget install failed."
      }
    }
    catch {}
    throw "minisign is not available and could not be installed automatically. Please install minisign manually (for example, 'winget install jedisct1.minisign') and retry."
  }

  return $exe.FullName
}

function Resolve-MinisignPublicKey {
  param (
    [Parameter(Mandatory = $true)] [string] $TargetPath
  )
  if ($MinisignPubKey) {
    Set-Content -Path $TargetPath -Value "$MinisignPubKey`n" -NoNewline
    return
  }
  if (-not $MinisignPubKeyUrl) {
    throw "HAPPIER_MINISIGN_PUBKEY_URL is empty; cannot fetch minisign public key."
  }
  Invoke-InstallerWebRequestWithRetry -Uri $MinisignPubKeyUrl -OutFile $TargetPath
}

$tag = if ($Channel -eq "preview") { "cli-preview" } elseif ($Channel -eq "publicdev") { "cli-dev" } else { "cli-stable" }
if (-not $ReleaseAssetsDir) {
  Write-Host "Fetching $tag release metadata..."
  try {
    $release = Invoke-InstallerRestMethodWithRetry -Uri "https://api.github.com/repos/$Repo/releases/tags/$tag" -Headers $GitHubHeaders
  }
  catch {
    if ($Channel -eq "stable") {
      throw "No stable releases found for Happier CLI."
    }
    if ($Channel -eq "publicdev") {
      throw "No dev releases found for Happier CLI."
    }
    throw "No preview releases found for Happier CLI."
  }
}
else {
  $release = $null
}
$assetPattern = Resolve-InstallerRequestedVersionPattern -Prefix "happier-v" -Suffix "-windows-x64.tar.gz"
$checksumsPattern = Resolve-InstallerRequestedVersionPattern -Prefix "checksums-happier-v" -Suffix ".txt"
$signaturePattern = Resolve-InstallerRequestedVersionPattern -Prefix "checksums-happier-v" -Suffix ".txt.minisig"
$asset = Resolve-InstallerAsset -Release $release -Pattern $assetPattern
$checksumsAsset = Resolve-InstallerAsset -Release $release -Pattern $checksumsPattern
$signatureAsset = Resolve-InstallerAsset -Release $release -Pattern $signaturePattern
if (-not $asset) {
  throw "Unable to locate Windows x64 binary on release tag $tag."
}
if (-not $checksumsAsset) {
  throw "Unable to locate checksum asset on release tag $tag."
}
if (-not $signatureAsset) {
  throw "Unable to locate minisign signature asset on release tag $tag."
}

$script:PostInstallRunStatus = 0
$script:PostInstallActionWasExplicit = [bool]($Run -or $SetupRelay)
$tmpDir = New-InstallerStagingDirectory -InstallHomeDir $InstallDir
try {
  $archivePath = Join-Path $tmpDir.FullName "happier.tar.gz"
  $checksumsPath = Join-Path $tmpDir.FullName "checksums.txt"
  $signaturePath = Join-Path $tmpDir.FullName "checksums.txt.minisig"
  $pubKeyPath = Join-Path $tmpDir.FullName "minisign.pub"

  Copy-OrDownloadInstallerAsset -Source $asset.Source -DestinationPath $archivePath
  Copy-OrDownloadInstallerAsset -Source $checksumsAsset.Source -DestinationPath $checksumsPath
  Copy-OrDownloadInstallerAsset -Source $signatureAsset.Source -DestinationPath $signaturePath

  $assetName = [string]$asset.Name
  $expectedSha = $null
  foreach ($line in (Get-Content -Path $checksumsPath)) {
    if ($line -match '^([a-fA-F0-9]{64})\s{2}(.+)$' -and $matches[2] -eq $assetName) {
      $expectedSha = $matches[1].ToLowerInvariant()
      break
    }
  }
  if (-not $expectedSha) {
    throw "Failed to resolve checksum for $assetName"
  }
  $actualSha = (Get-FileHash -Path $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($expectedSha -ne $actualSha) {
    throw "Checksum verification failed."
  }
  Write-Host "Checksum verified."

  $minisign = Ensure-Minisign -TempRoot $tmpDir.FullName
  Resolve-MinisignPublicKey -TargetPath $pubKeyPath
  $minisignVerifyResult = Invoke-NativeCommandCapturingOutput {
    & $minisign -Vm $checksumsPath -x $signaturePath -p $pubKeyPath
  }
  if ($minisignVerifyResult.ExitCode -ne 0) {
    if ($minisignVerifyResult.Output) {
      Write-Warning $minisignVerifyResult.Output.Trim()
    }
    throw "Signature verification failed."
  }
  Write-Host "Signature verified."

  $extractDir = Join-Path $tmpDir.FullName "extract"
  New-Item -ItemType Directory -Path $extractDir | Out-Null
  $tarPath = Resolve-TarExecutablePath
  & $tarPath -xzf $archivePath -C $extractDir
  $version = $assetName -replace '^happier-v', '' -replace '-windows-x64\.tar\.gz$', ''
  if (-not $version -or $version -eq $assetName) {
    throw "Failed to infer release version from asset name: $assetName"
  }
  $payloadRoot = Join-Path $extractDir "happier-v$version-windows-x64"
  if (-not (Test-Path $payloadRoot)) {
    throw "Failed to locate extracted payload root: $payloadRoot"
  }
  $binary = Join-Path $payloadRoot "happier.exe"
  if (-not (Test-Path $binary)) {
    throw "Failed to locate extracted happier.exe"
  }

  New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
  $target = Join-Path $BinDir "$((Resolve-CliShimName)).exe"

  Invoke-InstallerPreInstallLockHygiene -InstallHomeDir $InstallDir
  $promotionResult = Invoke-InstallerPayloadPromotionWithTimeout -BinaryPath $binary -PayloadRoot $payloadRoot -Version $version -ChannelValue $Channel -InstallHomeDir $InstallDir
  if ($promotionResult.ExitCode -ne 0) {
    $promotionOutput = if ($promotionResult.Output) { $promotionResult.Output.Trim() } else { "" }
    if ($promotionResult.TimedOut) {
      if ($promotionOutput) {
        Write-Warning $promotionOutput
      }
      throw "Payload promotion timed out. Refusing direct binary copy to avoid partial install state drift (versioned payload/current marker/shim/channel migration)."
    }
    $payloadPromotionFallbackSafe = Test-InstallerPayloadDirectCopyFallbackSafe
    $legacyFallbackCompatible = $promotionOutput -match 'Unknown self subcommand:\s+__install-payload'
    $longPathOrMissingSourceSignature = $promotionOutput -match '(ENOENT: no such file or directory, copyfile|ENOENT: no such file or directory, open|ENAMETOOLONG|name too long|path too long)'

    if ($payloadPromotionFallbackSafe -and ($legacyFallbackCompatible -or $longPathOrMissingSourceSignature)) {
      Write-Warning "Payload promotion is unsupported by this CLI build, falling back to legacy direct binary copy."
      if ($promotionOutput) {
        Write-Warning $promotionOutput
      }
      Copy-Item -Path $binary -Destination $target -Force
    }
    elseif ($longPathOrMissingSourceSignature) {
      if ($promotionOutput) {
        Write-Warning $promotionOutput
      }
      throw "Payload promotion failed without a safe fallback. Refusing direct binary copy to avoid partial install state drift (versioned payload/current marker/shim/channel migration)."
    }
    else {
      if ($promotionOutput) {
        Write-Warning $promotionOutput
      }
      throw "Payload promotion failed."
    }
  }
  if ($LegacyBinDir -ne $BinDir) {
    Remove-Item -Path (Join-Path $LegacyBinDir "happier.exe") -Force -ErrorAction SilentlyContinue
  }

  if ($NoPathUpdate -ne "1") {
    $userPath = [Environment]::GetEnvironmentVariable("Path", [EnvironmentVariableTarget]::User)
    $pathEntries = @()
    if ($userPath) {
      $pathEntries = @(
        $userPath -split ';' |
          ForEach-Object { $_.Trim() } |
          Where-Object { $_ -and $_ -ne $LegacyBinDir -and $_ -ne $BinDir }
      )
    }
    $updatedPathEntries = @($BinDir) + $pathEntries
    [Environment]::SetEnvironmentVariable("Path", ($updatedPathEntries -join ';'), [EnvironmentVariableTarget]::User)
    $machinePath = [Environment]::GetEnvironmentVariable("Path", [EnvironmentVariableTarget]::Machine)
    $machinePathEntries = @()
    if ($machinePath) {
      $machinePathEntries = @(
        $machinePath -split ';' |
          ForEach-Object { $_.Trim() } |
          Where-Object { $_ -and $updatedPathEntries -notcontains $_ }
      )
    }
    $processPathEntries = @($updatedPathEntries) + @($machinePathEntries)
    $env:Path = ($processPathEntries -join ';')
    if ($pathEntries.Length -eq 0 -or $userPath -notmatch [Regex]::Escape($BinDir)) {
      Write-Host "Added $BinDir to user PATH."
      Show-PathReloadGuidance -ShimName (Resolve-CliShimName) -BinDir $BinDir
    }
  }

  $invoker = Resolve-InstalledCliInvoker
  if (-not $invoker) {
    $invoker = $target
  }

  # Mirror install.sh:2305-2331: print a labeled summary block so the user
  # can see both the managed binary path and the shim that PATH resolves to.
  # The shim/binary distinction matters when users embed the path in build
  # scripts — they typically want the shim, but the binary path is the
  # authoritative location of the installed CLI.
  $displayShimPath = $target
  $displayShimDir = Split-Path -Parent $displayShimPath
  $displayShimBasename = [System.IO.Path]::GetFileNameWithoutExtension($displayShimPath)
  $displayBinaryPath = $invoker
  Write-Host ""
  Write-Host "Happier CLI installed:"
  Write-Host "  binary: $displayBinaryPath"
  Write-Host "  shim:   $displayShimPath"
  Write-Host ""

  $shimDirOnCurrentPath = $false
  if ($env:Path) {
    foreach ($pathEntry in ($env:Path -split ';')) {
      if ($pathEntry.Trim() -eq $displayShimDir) {
        $shimDirOnCurrentPath = $true
        break
      }
    }
  }
  if ($shimDirOnCurrentPath) {
    Write-Host "You can run ``$displayShimBasename`` right away."
  }
  elseif ($NoPathUpdate -eq "1") {
    Write-Host "PATH updates were skipped because HAPPIER_NO_PATH_UPDATE=1."
    Write-Host "Run the installed CLI directly using the absolute path:"
    Write-Host "  $displayShimPath"
  }
  else {
    Write-Host "To use ``$displayShimBasename`` from any new shell, $displayShimDir has been added to your PATH."
    Write-Host "In THIS shell, restart PowerShell or run directly using the absolute path:"
    Write-Host "  $displayShimPath"
  }
  Write-Host ""

  & $invoker --version

  $backgroundServiceInventory = @{
    Supported = $false
    Entries = @()
  }
  $shouldInspectBackgroundServices = $true
  if ($WithDaemonExplicit -and (ConvertTo-InstallerBoolean -Raw ([string]$WithDaemonPreference)) -eq "0") {
    $shouldInspectBackgroundServices = $false
  }
  if ($shouldInspectBackgroundServices) {
    $backgroundServiceInventory = Get-InstalledBackgroundServiceInventory -CliPath $invoker
  }
  if ($shouldInspectBackgroundServices -and $Noninteractive -ne "1" -and $backgroundServiceInventory.RepairSupported) {
    # Mirror install.sh:864-882: when the installer has a real TTY (UserInteractive
    # AND stdin not redirected), hand off to the CLI's interactive `doctor repair`
    # so the user can accept/reject each finding inline. Otherwise fall back to
    # the read-only report, which prints the CTA "To handle these interactively:"
    # footer so the user still knows the next step.
    try {
      if (Test-InteractiveInstallerPromptAvailable) {
        Invoke-InstallerCommandWithDaemonServiceContext -CliPath $invoker -CommandArgs @("doctor", "repair") -HomeDir $DaemonServiceStateHomeDir
      }
      else {
        Invoke-InstallerCommandWithDaemonServiceContext -CliPath $invoker -CommandArgs @("doctor", "repair", "--report-only") -HomeDir $DaemonServiceStateHomeDir
      }
    }
    catch {
      # ignore: doctor repair output is best-effort and should never block installs/updates
    }
  }

  $resolvedWithDaemon = Resolve-WithDaemonPreference -Entries $backgroundServiceInventory.Entries -DefaultFollowingMatchesSelectedReleaseChannel $backgroundServiceInventory.DefaultFollowingMatchesSelectedReleaseChannel
  if ($resolvedWithDaemon -ne "0") {
    if ($backgroundServiceInventory.Supported) {
      $installStrategy = Resolve-ExistingBackgroundServiceInstallStrategy -Entries $backgroundServiceInventory.Entries -DefaultFollowingMatchesSelectedReleaseChannel $backgroundServiceInventory.DefaultFollowingMatchesSelectedReleaseChannel
      $installCommand = Get-BackgroundServiceInstallManualCommand -CliPath $invoker
      if ($installStrategy -eq "replace-all") {
        $repairResult = Invoke-DoctorRepairIfSupported -CliPath $invoker
        if ($repairResult.Status -eq 'applied') {
          Write-Host "Updating automatic startup to this release channel..."
        }
        elseif ($repairResult.Status -eq 'unsupported') {
          Write-Host "Setting up automatic startup (user-mode)..."
          $installResult = Invoke-BackgroundServiceInstallCompatibly -CliPath $invoker
          if (-not $installResult.Ok) {
            Write-Warning "background service install failed. You can retry manually: `"$installCommand`""
          }
        }
        else {
          if ($backgroundServiceInventory.RepairSupported -and @($backgroundServiceInventory.Entries | Where-Object { $_.mode -eq 'system' }).Count -gt 0) {
            Write-Warning "system background services require an elevated PowerShell to repair or switch. Retry from an elevated PowerShell: `"$invoker doctor repair --yes`""
          }
          else {
            Write-Warning "background service install failed. You can retry manually: `"$invoker doctor repair --yes`""
          }
        }
      }
      elseif ($installStrategy -eq "add") {
        Write-Host "Setting up automatic startup (additional service, user-mode)..."
        $installResult = Invoke-BackgroundServiceInstallCompatibly -CliPath $invoker
        if (-not $installResult.Ok) {
          Write-Warning "background service install failed. You can retry manually: `"$installCommand`""
        }
      }
      elseif ($installStrategy -eq "skip") {
        Write-Host "Keeping existing background services unchanged."
      }
      else {
        $skipBackgroundServiceInstall = $false
        if ($Noninteractive -eq "1") {
          $repairResult = Invoke-DoctorRepairIfSupported -CliPath $invoker
          if ($repairResult.Status -eq 'applied') {
            Write-Host "Repairing automatic startup (best-effort)..."
          }
          elseif ($repairResult.Status -eq 'failed') {
            if ($backgroundServiceInventory.RepairSupported -and @($backgroundServiceInventory.Entries | Where-Object { $_.mode -eq 'system' }).Count -gt 0) {
              Write-Warning "system background services require an elevated PowerShell to repair or switch. Retry from an elevated PowerShell: `"$invoker doctor repair --yes`""
              $skipBackgroundServiceInstall = $true
            }
            else {
              Write-Host "Repairing automatic startup (best-effort)..."
              Write-Warning "background service repair failed. You can retry manually: `"$invoker doctor repair --yes`""
              $skipBackgroundServiceInstall = $true
            }
          }
        }
        if (-not $skipBackgroundServiceInstall) {
          Write-Host "Setting up automatic startup (user-mode)..."
          $installResult = Invoke-BackgroundServiceInstallCompatibly -CliPath $invoker
          if (-not $installResult.Ok) {
            Write-Warning "background service install failed. You can retry manually: `"$installCommand`""
          }
        }
      }
    }
  }

  $script:PostInstallMachineIsConfigured = Test-InstalledCliReportsConfiguredMachine -CliPath $invoker
  $script:PostInstallSetupIsDone = $script:PostInstallMachineIsConfigured

  if ($Run -or $SetupRelay) {
    $script:LastInstallerCommandExitCode = 0
    Invoke-PostInstallAction -CliPath $invoker
    $script:PostInstallRunStatus = $script:LastInstallerCommandExitCode
    if (([string]$Run).Trim().ToLowerInvariant() -eq "setup" -and $script:PostInstallRunStatus -eq 0) {
      $script:PostInstallSetupIsDone = $true
    }
  }
  elseif (Test-ShouldHandOffToGuidedSetup -CliPath $invoker) {
    Write-Host ""
    # Reuse the existing -Run machinery rather than adding a second dispatch path.
    $Run = "setup"
    $RunArgs = @()
    try {
      $script:LastInstallerCommandExitCode = 0
      Invoke-PostInstallAction -CliPath $invoker
      # An incomplete guided setup is not a failed binary install, but it is
      # also not "done". Keep the next-steps line until setup exits zero.
      $script:PostInstallSetupIsDone = ($script:LastInstallerCommandExitCode -eq 0)
    }
    catch {
      # A declined or failed setup does not fail the install; the next-steps
      # block below still tells the user how to pick it back up.
      Write-Warning "Guided setup did not finish: $($_.Exception.Message)"
    }
  }

  Write-PostInstallGetStarted -CliName $displayShimBasename
}
finally {
  Remove-InstallerStagingDirectory -Directory $tmpDir
}

# Match install.sh: an explicitly requested post-install action is part of the
# command's contract and propagates its status. The automatic guided handoff is
# best-effort and never turns a successful binary install into a failed install.
if ($script:PostInstallActionWasExplicit) {
  exit $script:PostInstallRunStatus
}
