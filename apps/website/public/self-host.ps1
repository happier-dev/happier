param(
  [string] $Channel = $(if ($env:HAPPIER_CHANNEL) { $env:HAPPIER_CHANNEL } else { "stable" }),

  [ValidateSet("user", "system")]
  [string] $Mode = $(if ($env:HAPPIER_SELF_HOST_MODE) { $env:HAPPIER_SELF_HOST_MODE } else { "user" }),

  [ValidateSet("install", "reinstall", "version", "check", "uninstall", "restart")]
  [string] $Action = $(if ($env:HAPPIER_INSTALLER_ACTION) { $env:HAPPIER_INSTALLER_ACTION } else { "install" }),

  [switch] $Json
)

$ErrorActionPreference = "Stop"

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

function Display-ChannelLabel {
  param (
    [Parameter(Mandatory = $true)] [string] $Normalized
  )
  if ($Normalized -eq "publicdev") { return "dev" }
  return $Normalized
}

function Resolve-HappierHomeDir {
  if ($env:HAPPIER_HOME) { return $env:HAPPIER_HOME }
  return (Join-Path $env:USERPROFILE ".happier")
}

function Resolve-InstallDirs {
  param (
    [Parameter(Mandatory = $true)] [string] $ResolvedMode
  )
  $home = Resolve-HappierHomeDir

  if ($ResolvedMode -eq "system") {
    $installDir = if ($env:HAPPIER_INSTALL_DIR) { $env:HAPPIER_INSTALL_DIR } else { "C:\ProgramData\Happier" }
    $binDir = if ($env:HAPPIER_BIN_DIR) { $env:HAPPIER_BIN_DIR } else { "C:\ProgramData\Happier\bin" }
    return @{ InstallDir = $installDir; BinDir = $binDir }
  }

  $installDirUser = if ($env:HAPPIER_INSTALL_DIR) { $env:HAPPIER_INSTALL_DIR } else { $home }
  $binDirUser = if ($env:HAPPIER_BIN_DIR) { $env:HAPPIER_BIN_DIR } else { (Join-Path $home "bin") }
  return @{ InstallDir = $installDirUser; BinDir = $binDirUser }
}

function Ensure-HappierCli {
  param(
    [Parameter(Mandatory = $true)] [string] $ResolvedChannel,
    [Parameter(Mandatory = $true)] [string] $ResolvedMode
  )

  $happierCmd = Get-Command happier -ErrorAction SilentlyContinue
  if ($happierCmd) {
    & $happierCmd.Source relay host --help *> $null
    if ($LASTEXITCODE -eq 0) {
      return $happierCmd.Source
    }
  }

  $dirs = Resolve-InstallDirs -ResolvedMode $ResolvedMode
  $env:HAPPIER_CHANNEL = (Display-ChannelLabel -Normalized $ResolvedChannel)
  $env:HAPPIER_PRODUCT = "cli"
  $env:HAPPIER_WITH_DAEMON = "0"
  $env:HAPPIER_INSTALL_DIR = $dirs.InstallDir
  $env:HAPPIER_BIN_DIR = $dirs.BinDir

  if (-not $env:HAPPIER_NONINTERACTIVE) {
    $env:HAPPIER_NONINTERACTIVE = "1"
  }

  Write-Host "Installing Happier CLI..."
  try {
    irm https://happier.dev/install.ps1 | iex
  }
  catch {
    throw "Failed to install Happier CLI: $($_.Exception.Message)"
  }

  $happierCmd = Get-Command happier -ErrorAction SilentlyContinue
  if (-not $happierCmd) {
    $candidate = Join-Path $dirs.BinDir "happier.exe"
    if (Test-Path $candidate) {
      $happierCmd = Get-Command $candidate -ErrorAction SilentlyContinue
    }
  }
  if (-not $happierCmd) {
    throw "happier is still not available after install. Ensure $($dirs.BinDir) is on PATH."
  }

  & $happierCmd.Source relay host --help *> $null
  if ($LASTEXITCODE -ne 0) {
    throw "Installed happier does not support 'relay host' yet."
  }

  return $happierCmd.Source
}

function Build-RelayHostArgs {
  param(
    [Parameter(Mandatory = $true)] [string] $Subcommand,
    [Parameter(Mandatory = $true)] [string] $ResolvedChannel,
    [Parameter(Mandatory = $true)] [string] $ResolvedMode
  )

  $args = @("relay", "host", $Subcommand, "--channel", (Display-ChannelLabel -Normalized $ResolvedChannel), "--mode", $ResolvedMode)
  if ($env:HAPPIER_NONINTERACTIVE -and $env:HAPPIER_NONINTERACTIVE -ne "0") {
    $args += "--non-interactive"
  }
  if ($Json) {
    $args += "--json"
  }
  return $args
}

$ResolvedChannel = Normalize-Channel -Raw ([string]$Channel)

$happier = Ensure-HappierCli -ResolvedChannel $ResolvedChannel -ResolvedMode $Mode

if ($Action -eq "version") {
  & $happier --version
  exit 0
}

$withoutCli = ($env:HAPPIER_WITH_CLI -and $env:HAPPIER_WITH_CLI -ne "1")
$purgeData = ($env:HAPPIER_SELF_HOST_PURGE_DATA -and $env:HAPPIER_SELF_HOST_PURGE_DATA -ne "0")

switch ($Action) {
  "check" {
    & $happier @(Build-RelayHostArgs -Subcommand "status" -ResolvedChannel $ResolvedChannel -ResolvedMode $Mode) *> $null
    & $happier @(Build-RelayHostArgs -Subcommand "doctor" -ResolvedChannel $ResolvedChannel -ResolvedMode $Mode)
    break
  }
  "uninstall" {
    $args = Build-RelayHostArgs -Subcommand "uninstall" -ResolvedChannel $ResolvedChannel -ResolvedMode $Mode
    $args += @("--yes")
    if ($purgeData) { $args += @("--purge-data") }
    & $happier @args
    break
  }
  "restart" {
    & $happier @(Build-RelayHostArgs -Subcommand "restart" -ResolvedChannel $ResolvedChannel -ResolvedMode $Mode)
    break
  }
  "install" {
    $args = Build-RelayHostArgs -Subcommand "install" -ResolvedChannel $ResolvedChannel -ResolvedMode $Mode
    if ($withoutCli) { $args += @("--without-cli") }
    & $happier @args
    break
  }
  "reinstall" {
    $args = Build-RelayHostArgs -Subcommand "install" -ResolvedChannel $ResolvedChannel -ResolvedMode $Mode
    if ($withoutCli) { $args += @("--without-cli") }
    $args += @("--reinstall")
    & $happier @args
    break
  }
  default {
    throw "Unsupported action: $Action"
  }
}

