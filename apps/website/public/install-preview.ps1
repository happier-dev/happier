param(
  [string] $Channel = $(if ($env:HAPPIER_CHANNEL) { $env:HAPPIER_CHANNEL } else { "preview" }),
  [string] $Version = $(if ($env:HAPPIER_INSTALL_VERSION) { $env:HAPPIER_INSTALL_VERSION } else { "" }),
  [switch] $SetupRelay,
  [switch] $Rollback,
  [switch] $WithDaemon,
  [switch] $WithoutDaemon,
  [string] $Run = $(if ($env:HAPPIER_INSTALLER_RUN_ACTION) { $env:HAPPIER_INSTALLER_RUN_ACTION } else { "" }),
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
if ($Rollback.IsPresent) {
  $InstallerAction = "rollback"
}
if ($InstallerAction -eq "reinstall") {
  $InstallerAction = "install"
}
if ($InstallerAction -ne "install" -and $InstallerAction -ne "rollback") {
  throw "Unsupported HAPPIER_INSTALLER_ACTION '$InstallerAction' for install.ps1. Expected install or rollback."
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
$Noninteractive = if ($env:HAPPIER_NONINTERACTIVE) { $env:HAPPIER_NONINTERACTIVE } else { "0" }
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

function Test-InstallerDefaultChannelMatchesSelectedChannel {
  $statePath = Join-Path $InstallDir "default-cli-release-channel.json"
  if (Test-Path $statePath -PathType Leaf) {
    $raw = Get-Content -Path $statePath -Raw -ErrorAction SilentlyContinue
    return $raw -match ('"releaseChannel"\s*:\s*"' + [Regex]::Escape($Channel) + '"')
  }
  return $Channel -eq "stable"
}

function Sync-InstallerCliRollbackShim {
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

function Invoke-InstallerCliRollback {
  $managedRoot = Resolve-CliInstallRootName
  $installRoot = Join-Path $InstallDir $managedRoot
  $previousVersion = Read-InstallerMarkerFile -Path (Join-Path $installRoot "previous.version")
  if (-not $previousVersion) {
    throw "No previous $(Resolve-CliShimName) version is available for rollback."
  }

  $previousDir = Join-Path (Join-Path $installRoot "versions") $previousVersion
  $previousBinary = Join-Path $previousDir "happier.exe"
  if (-not (Test-Path $previousBinary -PathType Leaf)) {
    throw "Rollback target is missing or incomplete: $previousDir"
  }

  $currentVersion = Read-InstallerMarkerFile -Path (Join-Path $installRoot "current.version")
  Set-InstallerDirectoryPointer -Path (Join-Path $installRoot "current") -Target $previousDir
  Set-Content -Path (Join-Path $installRoot "current.version") -Value "$previousVersion`n" -NoNewline

  if ($currentVersion) {
    $currentDir = Join-Path (Join-Path $installRoot "versions") $currentVersion
    if (Test-Path $currentDir -PathType Container) {
      Set-InstallerDirectoryPointer -Path (Join-Path $installRoot "previous") -Target $currentDir
      Set-Content -Path (Join-Path $installRoot "previous.version") -Value "$currentVersion`n" -NoNewline
    }
  }

  $shimName = Resolve-CliShimName
  Sync-InstallerCliRollbackShim -ShimName $shimName -BinaryPath $previousBinary
  if ($shimName -ne "happier" -and (Test-InstallerDefaultChannelMatchesSelectedChannel)) {
    Sync-InstallerCliRollbackShim -ShimName "happier" -BinaryPath $previousBinary
  }

  Write-Host "Rolled back $shimName from $(if ($currentVersion) { $currentVersion } else { 'current' }) to $previousVersion."
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
          Entries = $entries
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
        Entries = $entries
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
    $invokerName = (Split-Path -Leaf $CliPath)
    if ([string]::IsNullOrWhiteSpace($invokerName)) { $invokerName = "happier" }
    $helpOutput = ""
    try {
      if ($requiredSubcommand -eq "relay") {
        $helpOutput = (& $CliPath relay --help 2>$null | Out-String)
      } else {
        $helpOutput = (& $CliPath --help 2>$null | Out-String)
      }
    } catch {
      $helpOutput = ""
    }
    $pattern = "(?m)^\\s*($([Regex]::Escape($invokerName))|happier)\\s+$([Regex]::Escape($requiredSubcommand))\\b"
    if (-not ($helpOutput -match $pattern)) {
      throw "Installed Happier CLI does not support the '$requiredSubcommand' command surface required for -Run $runValue. Update your Happier CLI (or switch installer channel) and try again."
    }
  }
  Invoke-InstallerCommandWithDaemonServiceContext -CliPath $CliPath -CommandArgs $argsToPass -HomeDir $DaemonServiceStateHomeDir
}

if ($InstallerAction -eq "rollback") {
  Invoke-InstallerCliRollback
  exit 0
}

if ($Run -and -not $SetupRelay -and ($existing = Resolve-InstalledCliInvoker)) {
  Invoke-PostInstallAction -CliPath $existing
  exit 0
}

function Get-InstallerAssetVersionSortKey {
  param (
    [Parameter(Mandatory = $true)] [string] $Name
  )

  $version = ""
  if ($Name -match '^checksums-.+-v(.+)\.txt\.minisig$') {
    $version = $matches[1]
  }
  elseif ($Name -match '^checksums-.+-v(.+)\.txt$') {
    $version = $matches[1]
  }
  elseif ($Name -match '^.+-v(.+)-(linux|darwin|windows)-[^-]+\.tar\.gz$') {
    $version = $matches[1]
  }
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

  $prereleaseRank = '0|'
  foreach ($part in ($prerelease -split '\.')) {
    if ($part -match '^\d+$') {
      $prereleaseRank += '0|{0:D9}|' -f [int]$part
    }
    else {
      $prereleaseRank += "1|$part|"
    }
  }
  return "$sortKey$prereleaseRank$Name"
}

function Select-NewestInstallerAsset {
  param (
    [Parameter(Mandatory = $true)] [object[]] $Assets
  )

  $selected = $null
  $selectedSortKey = ""
  foreach ($asset in @($Assets)) {
    if ($null -eq $asset) {
      continue
    }
    $sortKey = Get-InstallerAssetVersionSortKey -Name ([string]$asset.name)
    if ($null -eq $selected -or $sortKey -gt $selectedSortKey) {
      $selected = $asset
      $selectedSortKey = $sortKey
    }
  }
  return $selected
}

function Get-AssetByPattern {
  param (
    [Parameter(Mandatory = $true)] [object] $Release,
    [Parameter(Mandatory = $true)] [string] $Pattern
  )
  return Select-NewestInstallerAsset -Assets @($Release.assets | Where-Object { $_.name -match $Pattern })
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
  return Select-NewestInstallerAsset -Assets @(Get-ChildItem -Path $ReleaseAssetsDir -File | Where-Object { $_.Name -match $Pattern })
}

function Resolve-InstallerRequestedVersionPattern {
  param (
    [Parameter(Mandatory = $true)] [string] $Prefix,
    [Parameter(Mandatory = $true)] [string] $Suffix
  )
  if ($Version) {
    return "^$([Regex]::Escape($Prefix))$([Regex]::Escape($Version))$([Regex]::Escape($Suffix))$"
  }
  return "^$([Regex]::Escape($Prefix)).*$([Regex]::Escape($Suffix))$"
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

  $retryableStatusCodes = @(502, 503, 504)
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
    if ($message -match "(^|\\D)$code(\\D|$)") {
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
      $params = @{ Uri = $Uri }
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

$tmpDir = New-Item -ItemType Directory -Path (Join-Path $env:TEMP ("happier-install-" + [System.Guid]::NewGuid().ToString("N")))
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

  $previousHappyHomeDir = $env:HAPPIER_HOME_DIR
  try {
    $env:HAPPIER_HOME_DIR = $InstallDir
    $promotionResult = Invoke-NativeCommandCapturingOutput {
      & $binary self __install-payload --component happier-cli --payload-root $payloadRoot --version $version --channel $Channel
    }
  }
  finally {
    if ($null -eq $previousHappyHomeDir) {
      Remove-Item Env:HAPPIER_HOME_DIR -ErrorAction SilentlyContinue
    }
    else {
      $env:HAPPIER_HOME_DIR = $previousHappyHomeDir
    }
  }
  if ($promotionResult.ExitCode -ne 0) {
    if ($promotionResult.Output -match '(Unknown self subcommand:\s+__install-payload|ENOENT: no such file or directory, open)') {
      Write-Warning "Payload promotion failed, falling back to direct binary copy."
      if ($promotionResult.Output) {
        Write-Warning $promotionResult.Output.Trim()
      }
      Copy-Item -Path $binary -Destination $target -Force
    }
    else {
      if ($promotionResult.Output) {
        Write-Warning $promotionResult.Output.Trim()
      }
      throw "Payload promotion failed."
    }
  }
  if ($LegacyBinDir -ne $BinDir) {
    Remove-Item -Path (Join-Path $LegacyBinDir "happier.exe") -Force -ErrorAction SilentlyContinue
  }

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

  Invoke-PostInstallAction -CliPath $invoker
}
finally {
  Remove-Item -Path $tmpDir.FullName -Recurse -Force -ErrorAction SilentlyContinue
}
