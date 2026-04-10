param(
  [string] $Channel = $(if ($env:HAPPIER_CHANNEL) { $env:HAPPIER_CHANNEL } else { "stable" }),
  [switch] $SetupRelay,
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
$GitHubHeaders = @{
  "X-GitHub-Api-Version" = "2022-11-28"
}
if ($Token) {
  $GitHubHeaders["Authorization"] = "Bearer $Token"
}
$InstallDir = if ($env:HAPPIER_INSTALL_DIR) { $env:HAPPIER_INSTALL_DIR } else { Join-Path $env:USERPROFILE ".happier" }
$DaemonServiceStateHomeDir = if ($env:HAPPIER_HOME_DIR) { $env:HAPPIER_HOME_DIR } else { Join-Path $env:USERPROFILE ".happier" }
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

function Read-BackgroundServicePromptChoice {
  param (
    [Parameter(Mandatory = $true)] [string] $DefaultChoice,
    [Parameter(Mandatory = $true)] [bool] $HasExistingServices
  )

  if (-not (Test-InteractiveInstallerPromptAvailable)) {
    return $DefaultChoice
  }

  $channelLabel = if ($Channel -eq "publicdev") { "dev" } else { $Channel }
  $defaultHint = "y/N"
  $recommendedNote = "recommended: no"
  if ($DefaultChoice -eq "1") {
    $defaultHint = "Y/n"
    $recommendedNote = "recommended: yes"
  }

  $prompt = "Install background service for automatic startup on the $channelLabel release-channel?"
  if ($HasExistingServices) {
    $prompt = "Update background service startup after installing the $channelLabel release-channel CLI?"
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
    [Parameter(Mandatory = $false)] [object[]] $ExistingEntries = @()
  )

  if ($WithDaemonExplicit) {
    return ConvertTo-InstallerBoolean -Raw ([string]$WithDaemonPreference)
  }

  $defaultChoice = Get-DefaultBackgroundServiceChoice
  if ($Noninteractive -eq "1") {
    return $defaultChoice
  }
  return Read-BackgroundServicePromptChoice -DefaultChoice $defaultChoice -HasExistingServices ($ExistingEntries.Count -gt 0)
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

function Get-InstalledBackgroundServiceInventory {
  param (
    [Parameter(Mandatory = $true)] [string] $CliPath
  )

  try {
    $raw = Invoke-InstallerCommandWithDaemonServiceContext -CliPath $CliPath -CommandArgs @("service", "list", "--json") -HomeDir $DaemonServiceStateHomeDir | Out-String
    if (-not $raw) {
      return @{
        Supported = $false
        Entries = @()
      }
    }
    $payload = $raw | ConvertFrom-Json
    $propertyNames = @($payload.PSObject.Properties.Name)
    if ($propertyNames -contains 'entries') {
      return @{
        Supported = $true
        Entries = @($payload.entries)
      }
    }
    if ($propertyNames -contains 'services') {
      return @{
        Supported = $true
        Entries = @($payload.services)
      }
    }
  }
  catch {
    return @{
      Supported = $false
      Entries = @()
    }
  }

  return @{
    Supported = $false
    Entries = @()
  }
}

function Test-BackgroundServiceInventoryHasDefaultFollowing {
  param (
    [Parameter(Mandatory = $true)] [object[]] $Entries
  )

  return @($Entries | Where-Object { $_.targetMode -eq 'default-following' }).Count -gt 0
}

function Show-InstalledBackgroundServiceSummary {
  param (
    [Parameter(Mandatory = $true)] [string] $CliPath,
    [Parameter(Mandatory = $true)] [object[]] $Entries
  )

  if ($Entries.Count -eq 0) {
    return
  }

  Write-Host "Current background services:"
  try {
    Invoke-InstallerCommandWithDaemonServiceContext -CliPath $CliPath -CommandArgs @("service", "list") -HomeDir $DaemonServiceStateHomeDir
  }
  catch {
    # best-effort summary only
  }
  try {
    Invoke-InstallerCommandWithDaemonServiceContext -CliPath $CliPath -CommandArgs @("service", "status") -HomeDir $DaemonServiceStateHomeDir
  }
  catch {
    # best-effort summary only
  }

  if (Test-BackgroundServiceInventoryHasDefaultFollowing -Entries $Entries) {
    Write-Host "Automatic startup follows the managed default release-channel, not the newly installed CLI lane." -ForegroundColor Yellow
    Write-Host "Switch the managed default background service to this release-channel only if you want automatic startup to follow this lane." -ForegroundColor Cyan
    Write-Host "Keep the current default background service if you only want to use this CLI interactively. Replace it only if you also want to clean up competing services." -ForegroundColor Cyan
    Write-Host "You can still run this CLI directly. Interactive session commands will not replace the current relay owner unless you explicitly switch or take it over." -ForegroundColor Cyan
    return
  }

  Write-Host "Pinned background services keep their current release-channels and relay targets until you replace them." -ForegroundColor Yellow
  Write-Host "Installing this CLI alone does not move automatic startup to this lane." -ForegroundColor Cyan
  Write-Host "You can still run this CLI directly. Interactive session commands will not replace the current relay owner unless you explicitly switch or take it over." -ForegroundColor Cyan
}

function Resolve-ExistingBackgroundServiceInstallStrategy {
  param (
    [Parameter(Mandatory = $true)] [object[]] $Entries
  )

  if ($Noninteractive -eq "1") {
    return ""
  }

  if ($Entries.Count -eq 0) {
    return ""
  }

  $replacePrompt = "Existing background services detected. Replace them with this installation?"
  if (Test-BackgroundServiceInventoryHasDefaultFollowing -Entries $Entries) {
    $replacePrompt = "A default background service is already installed. Switch the managed default background service to this release-channel?"
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

function Invoke-PostInstallAction {
  param (
    [Parameter(Mandatory = $true)] [string] $CliPath
  )

  $setupRelayDefaultArgs = @()
  if ($SetupRelay -and -not $Run) {
    $Run = "setup-relay"
    $setupRelayDefaultArgs = @("--mode", "user", "--yes", "--channel", $(if ($Channel -eq "publicdev") { "dev" } else { $Channel }))
  }
  if (-not $Run) {
    return
  }

  $runValue = $Run.Trim().ToLowerInvariant()
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
      $helpOutput = (& $CliPath --help 2>$null | Out-String)
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

if (($SetupRelay -or $Run) -and ($existing = Resolve-InstalledCliInvoker)) {
  Invoke-PostInstallAction -CliPath $existing
  exit 0
}

function Get-AssetByPattern {
  param (
    [Parameter(Mandatory = $true)] [object] $Release,
    [Parameter(Mandatory = $true)] [string] $Pattern
  )
  return $Release.assets | Where-Object { $_.name -match $Pattern } | Select-Object -First 1
}

function Resolve-MinisignExecutablePath {
  param (
    [string[]] $AdditionalPathEntries = @()
  )

  $command = Get-Command minisign -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  foreach ($pathEntry in $AdditionalPathEntries) {
    $trimmedEntry = [string]$pathEntry
    if (-not $trimmedEntry) {
      continue
    }

    $candidate = Join-Path $trimmedEntry.Trim() "minisign.exe"
    if (Test-Path $candidate) {
      return $candidate
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
  Invoke-WebRequest -Uri "https://github.com/jedisct1/minisign/releases/download/$minisignVersion/$asset" -OutFile $zipPath
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
      if ($wingetInstallResult.ExitCode -ne 0) {
        if ($wingetInstallResult.Output) {
          Write-Warning $wingetInstallResult.Output.Trim()
        }
        throw "winget install failed."
      }
      $pathEntries = @()
      $userPath = [Environment]::GetEnvironmentVariable("Path", [EnvironmentVariableTarget]::User)
      if ($userPath) {
        $pathEntries += $userPath -split ';'
      }
      $machinePath = [Environment]::GetEnvironmentVariable("Path", [EnvironmentVariableTarget]::Machine)
      if ($machinePath) {
        $pathEntries += $machinePath -split ';'
      }
      $wingetMinisign = Resolve-MinisignExecutablePath -AdditionalPathEntries $pathEntries
      if ($wingetMinisign) {
        return $wingetMinisign
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
  Invoke-WebRequest -Uri $MinisignPubKeyUrl -OutFile $TargetPath
}

$tag = if ($Channel -eq "preview") { "cli-preview" } elseif ($Channel -eq "publicdev") { "cli-dev" } else { "cli-stable" }
Write-Host "Fetching $tag release metadata..."
try {
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/tags/$tag" -Headers $GitHubHeaders
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
$asset = Get-AssetByPattern -Release $release -Pattern '^happier-v.*-windows-x64\.tar\.gz$'
$checksumsAsset = Get-AssetByPattern -Release $release -Pattern '^checksums-happier-v.*\.txt$'
$signatureAsset = Get-AssetByPattern -Release $release -Pattern '^checksums-happier-v.*\.txt\.minisig$'
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

  Invoke-WebRequest -Uri $asset.browser_download_url -Headers $GitHubHeaders -OutFile $archivePath
  Invoke-WebRequest -Uri $checksumsAsset.browser_download_url -Headers $GitHubHeaders -OutFile $checksumsPath
  Invoke-WebRequest -Uri $signatureAsset.browser_download_url -Headers $GitHubHeaders -OutFile $signaturePath

  $assetName = [System.IO.Path]::GetFileName($asset.browser_download_url)
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
  tar -xzf $archivePath -C $extractDir
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
    if ($promotionResult.Output -match 'Unknown self subcommand:\s+__install-payload') {
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
  if ($pathEntries.Length -eq 0 -or $userPath -notmatch [Regex]::Escape($BinDir)) {
    Write-Host "Added $BinDir to user PATH."
  }

  $invoker = Resolve-InstalledCliInvoker
  if (-not $invoker) {
    $invoker = $target
  }

  Write-Host "Happier CLI installed at $invoker"
  & $invoker --version

  $backgroundServiceInventory = @{
    Supported = $false
    Entries = @()
  }
  $backgroundServiceInventory = Get-InstalledBackgroundServiceInventory -CliPath $invoker
  if ($backgroundServiceInventory.Supported -and $backgroundServiceInventory.Entries.Count -gt 0 -and $Noninteractive -ne "1") {
    Show-InstalledBackgroundServiceSummary -CliPath $invoker -Entries $backgroundServiceInventory.Entries
  }

  $resolvedWithDaemon = Resolve-WithDaemonPreference -ExistingEntries $backgroundServiceInventory.Entries
  if ($resolvedWithDaemon -ne "0") {
    if ($backgroundServiceInventory.Supported) {
      $installStrategy = Resolve-ExistingBackgroundServiceInstallStrategy -Entries $backgroundServiceInventory.Entries
      if ($installStrategy -eq "replace-all") {
        Write-Host "Switching managed background-service startup to this release-channel..."
        try {
          Invoke-InstallerCommandWithDaemonServiceContext -CliPath $invoker -CommandArgs @("service", "repair", "--yes") -HomeDir $DaemonServiceStateHomeDir *> $null
        } catch {
          Write-Warning "background service install failed. You can retry manually: `"$invoker service repair --yes`""
        }
      }
      elseif ($installStrategy -eq "add") {
        Write-Host "Installing an additional background service (user-mode)..."
        try {
          Invoke-InstallerCommandWithDaemonServiceContext -CliPath $invoker -CommandArgs @("service", "install", "--yes") -HomeDir $DaemonServiceStateHomeDir *> $null
        } catch {
          Write-Warning "background service install failed. You can retry manually: `"$invoker service install --yes`""
        }
      }
      elseif ($installStrategy -eq "skip") {
        Write-Host "Keeping existing background services unchanged."
      }
      else {
        if ($Noninteractive -eq "1") {
          Write-Host "Reconciling existing background services (best-effort)..."
          try {
            Invoke-InstallerCommandWithDaemonServiceContext -CliPath $invoker -CommandArgs @("service", "repair", "--yes") -HomeDir $DaemonServiceStateHomeDir *> $null
          }
          catch {
            # best-effort
          }
        }
        Write-Host "Installing background service (user-mode)..."
        try {
          Invoke-InstallerCommandWithDaemonServiceContext -CliPath $invoker -CommandArgs @("service", "install", "--yes") -HomeDir $DaemonServiceStateHomeDir *> $null
        } catch {
          Write-Warning "background service install failed. You can retry manually: `"$invoker service install --yes`""
        }
      }
    }
  }

  Invoke-PostInstallAction -CliPath $invoker
}
finally {
  Remove-Item -Path $tmpDir.FullName -Recurse -Force -ErrorAction SilentlyContinue
}
