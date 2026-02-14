param(
  [ValidateSet("stable", "preview")]
  [string] $Channel = $(if ($env:HAPPIER_CHANNEL) { $env:HAPPIER_CHANNEL } else { "preview" }),

  [ValidateSet("user", "system")]
  [string] $Mode = $(if ($env:HAPPIER_SELF_HOST_MODE) { $env:HAPPIER_SELF_HOST_MODE } else { "user" })
)

$ErrorActionPreference = "Stop"

$Repo = if ($env:HAPPIER_GITHUB_REPO) { $env:HAPPIER_GITHUB_REPO } else { "happier-dev/happier" }
$Token = if ($env:HAPPIER_GITHUB_TOKEN) { $env:HAPPIER_GITHUB_TOKEN } elseif ($env:GITHUB_TOKEN) { $env:GITHUB_TOKEN } else { "" }
$GitHubHeaders = @{
  "X-GitHub-Api-Version" = "2022-11-28"
}
if ($Token) {
  $GitHubHeaders["Authorization"] = "Bearer $Token"
}

$HappierHome = if ($env:HAPPIER_HOME) { $env:HAPPIER_HOME } else { Join-Path $env:USERPROFILE ".happier" }
$StackInstallDir = if ($env:HAPPIER_STACK_INSTALL_ROOT) { $env:HAPPIER_STACK_INSTALL_ROOT } else { Join-Path $HappierHome "stack" }
$StackBinDir = if ($env:HAPPIER_STACK_BIN_DIR) { $env:HAPPIER_STACK_BIN_DIR } else { Join-Path $HappierHome "bin" }

$DefaultMinisignPubKey = @"
untrusted comment: minisign public key 91AE28177BF6E43C
RWQ85PZ7FyiukYbL3qv/bKnwgbT68wLVzotapeMFIb8n+c7pBQ7U8W2t
"@
$MinisignPubKey = if ($env:HAPPIER_MINISIGN_PUBKEY) { $env:HAPPIER_MINISIGN_PUBKEY } else { $DefaultMinisignPubKey.Trim() }
$MinisignPubKeyUrl = if ($env:HAPPIER_MINISIGN_PUBKEY_URL) { $env:HAPPIER_MINISIGN_PUBKEY_URL } else { "https://happier.dev/happier-release.pub" }

function Get-AssetByPattern {
  param (
    [Parameter(Mandatory = $true)] [object] $Release,
    [Parameter(Mandatory = $true)] [string] $Pattern
  )
  return $Release.assets | Where-Object { $_.name -match $Pattern } | Select-Object -First 1
}

function Ensure-Minisign {
  param (
    [Parameter(Mandatory = $true)] [string] $TempRoot
  )
  if (Get-Command minisign -ErrorAction SilentlyContinue) {
    return "minisign"
  }

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

$tag = if ($Channel -eq "preview") { "stack-preview" } else { "stack-stable" }
Write-Host "Fetching $tag release metadata..."
try {
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/tags/$tag" -Headers $GitHubHeaders
}
catch {
  if ($Channel -eq "preview") {
    throw "No stable releases found for Happier Stack."
  }
  throw "No preview releases found for Happier Stack."
}

$asset = Get-AssetByPattern -Release $release -Pattern '^hstack-v.*-windows-x64\.tar\.gz$'
$checksumsAsset = Get-AssetByPattern -Release $release -Pattern '^checksums-hstack-v.*\.txt$'
$signatureAsset = Get-AssetByPattern -Release $release -Pattern '^checksums-hstack-v.*\.txt\.minisig$'
if (-not $asset) {
  throw "Unable to locate Windows x64 hstack binary on release tag $tag."
}
if (-not $checksumsAsset) {
  throw "Unable to locate checksum asset on release tag $tag."
}
if (-not $signatureAsset) {
  throw "Unable to locate minisign signature asset on release tag $tag."
}

$tmpDir = New-Item -ItemType Directory -Path (Join-Path $env:TEMP ("happier-self-host-" + [System.Guid]::NewGuid().ToString("N")))
try {
  $archivePath = Join-Path $tmpDir.FullName "hstack.tar.gz"
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
  & $minisign -Vm $checksumsPath -x $signaturePath -p $pubKeyPath *> $null
  if ($LASTEXITCODE -ne 0) {
    throw "Signature verification failed."
  }
  Write-Host "Signature verified."

  $extractDir = Join-Path $tmpDir.FullName "extract"
  New-Item -ItemType Directory -Path $extractDir | Out-Null
  tar -xzf $archivePath -C $extractDir
  $binary = Get-ChildItem -Path $extractDir -Filter "hstack.exe" -Recurse | Select-Object -First 1
  if (-not $binary) {
    throw "Failed to locate extracted hstack.exe"
  }

  New-Item -ItemType Directory -Path (Join-Path $StackInstallDir "bin") -Force | Out-Null
  New-Item -ItemType Directory -Path $StackBinDir -Force | Out-Null

  $target = Join-Path $StackInstallDir "bin\hstack.exe"
  Copy-Item -Path $binary.FullName -Destination $target -Force
  Copy-Item -Path $target -Destination (Join-Path $StackBinDir "hstack.exe") -Force

  if (($env:Path -split ';') -notcontains $StackBinDir) {
    [Environment]::SetEnvironmentVariable("Path", "$StackBinDir;$env:Path", [EnvironmentVariableTarget]::User)
    Write-Host "Added $StackBinDir to user PATH."
  }

  Write-Host "hstack installed at $target"

  $args = @("self-host", "install", "--non-interactive", "--channel", $Channel, "--mode", $Mode)
  if ($env:HAPPIER_WITH_CLI -and $env:HAPPIER_WITH_CLI -ne "1") {
    $args += "--without-cli"
  }

  & $target @args
  if ($LASTEXITCODE -ne 0) {
    throw "hstack self-host install failed."
  }

  Write-Host ""
  Write-Host "Happier Self-Host installation completed."
  Write-Host "Run: hstack self-host status"
}
finally {
  Remove-Item -Path $tmpDir.FullName -Recurse -Force -ErrorAction SilentlyContinue
}

