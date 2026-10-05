param(
  [ValidateSet('Provision','Start','Doctor','Capacity')][string]$Action,
  [string]$Instance, [string]$User, [int]$Cpus, [int]$MemoryGiB,
  [string]$PublicKey = '', [string]$ProvisionBase64 = ''
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Wsl([string[]]$Arguments) {
  $output = & wsl.exe @Arguments
  if ($LASTEXITCODE -ne 0) { throw "wsl.exe failed ($LASTEXITCODE): $($Arguments[0]): $($output -join [Environment]::NewLine)" }
  return $output
}
function Distributions([switch]$Running) {
  if (!(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss' -ErrorAction SilentlyContinue)) { return @() }
  $arguments = @('--list','--quiet')
  if ($Running) { $arguments += '--running' }
  return @(Wsl $arguments | ForEach-Object { ($_ -replace [char]0,'').Trim() } | Where-Object { $_ })
}
function Guest([string]$Script, [string]$GuestUser = 'root') {
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Script))
  return Wsl @('--distribution',$Instance,'--user',$GuestUser,'--cd','/','--exec','sh','-ceu',("printf %s " + $encoded + " | base64 -d | sh -eu"))
}
function ApplyCapacity {
  $file = Join-Path $env:USERPROFILE '.wslconfig'
  $text = if (Test-Path -LiteralPath $file) { [IO.File]::ReadAllText($file) } else { '' }
  $lineBreak = [Environment]::NewLine
  foreach ($setting in @(@('memory',"$($MemoryGiB)GB"),@('processors',"$Cpus"))) {
    $key = $setting[0]; $value = $setting[1]
    $section = [regex]::Match($text,'(?ims)^\[wsl2\]\s*\r?\n(?<body>.*?)(?=^\[|\z)')
    if (!$section.Success) {
      $text = $text.TrimEnd() + $lineBreak + '[wsl2]' + $lineBreak + "$key=$value" + $lineBreak
    } else {
      $body = $section.Groups['body'].Value
      $pattern = "(?im)^\s*$key\s*=.*$"
      if ([regex]::IsMatch($body,$pattern)) { $body = [regex]::Replace($body,$pattern,"$key=$value") }
      else { $body = $body.TrimEnd() + $lineBreak + "$key=$value" + $lineBreak }
      $text = $text.Substring(0,$section.Groups['body'].Index) + $body + $text.Substring($section.Groups['body'].Index+$section.Groups['body'].Length)
    }
  }
  if (!(Test-Path -LiteralPath $file) -or [IO.File]::ReadAllText($file) -ne $text) {
    [IO.File]::WriteAllText($file,$text,(New-Object Text.UTF8Encoding($false)))
  }
}
if ($Action -eq 'Provision') {
  $restart = $false
  foreach ($feature in @('VirtualMachinePlatform','Microsoft-Windows-Subsystem-Linux')) {
    $state = Get-WindowsOptionalFeature -Online -FeatureName $feature
    if ($state.State -ne 'Enabled') {
      $result = Enable-WindowsOptionalFeature -Online -FeatureName $feature -All -NoRestart
      $restart = $restart -or $result.RestartNeeded
    }
  }
  if ($restart) { throw 'WINDOWS_REBOOT_REQUIRED: reboot the Windows host, then rerun provisioning' }
  & wsl.exe --version | Out-Null
  if ($LASTEXITCODE -ne 0) {
    $release = Invoke-RestMethod 'https://api.github.com/repos/microsoft/WSL/releases/latest'
    $asset = $release.assets | Where-Object { $_.name -match '^wsl\..*\.x64\.msi$' } | Select-Object -First 1
    if (!$asset) { throw 'Official WSL x64 installer unavailable' }
    $installer = Join-Path $env:TEMP $asset.name
    Invoke-WebRequest $asset.browser_download_url -OutFile $installer -UseBasicParsing
    $signature = Get-AuthenticodeSignature $installer
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Microsoft Corporation') { throw 'WSL installer signature verification failed' }
    $result = Start-Process msiexec.exe -ArgumentList @('/i',('"' + $installer + '"'),'/qn','/norestart') -Wait -PassThru
    if ($result.ExitCode -eq 3010) { throw 'WINDOWS_REBOOT_REQUIRED: WSL installation requires a reboot' }
    if ($result.ExitCode -ne 0) { throw "WSL installation failed ($($result.ExitCode))" }
  }
  $existing = (Distributions) -contains $Instance
  $alreadyProvisioned = $false
  if ($existing) {
    Guest ('test "$(cat /etc/happier-worker-owner)" = ' + $User) | Out-Null
    $task = Get-ScheduledTask -TaskName "Happier-WSL-$Instance" -ErrorAction SilentlyContinue
    $alreadyProvisioned = $null -ne $task
  }
  if (!$alreadyProvisioned) {
  if (@(Distributions -Running | Where-Object { $_ -ne $Instance }).Count -gt 0) { throw 'Stop existing WSL workloads before changing host-wide capacity' }
  ApplyCapacity
  Wsl @('--shutdown') | Out-Null
  if ((Distributions) -notcontains $Instance) {
    Wsl @('--install','--distribution','Ubuntu-24.04','--name',$Instance,'--no-launch','--web-download') | Out-Host
  }
  $key64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($PublicKey))
  $setup = @'
printf '%s\n' '__USER__' > /etc/happier-worker-owner
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y openssh-server netcat-openbsd sudo ca-certificates
id -u '__USER__' >/dev/null 2>&1 || useradd --create-home --shell /bin/bash '__USER__'
printf '%s\n' '__USER__ ALL=(ALL) NOPASSWD:ALL' > '/etc/sudoers.d/happier-worker-__USER__'
chmod 440 '/etc/sudoers.d/happier-worker-__USER__'
install -d -m 700 -o '__USER__' -g '__USER__' '/home/__USER__/.ssh'
key=$(printf %s '__KEY__' | base64 -d)
touch '/home/__USER__/.ssh/authorized_keys'
grep -qxF "$key" '/home/__USER__/.ssh/authorized_keys' || printf '%s\n' "$key" >> '/home/__USER__/.ssh/authorized_keys'
chown '__USER__:__USER__' '/home/__USER__/.ssh/authorized_keys'
chmod 600 '/home/__USER__/.ssh/authorized_keys'
mkdir -p /etc/ssh/sshd_config.d
printf '%s\n' 'Port 2222' 'PasswordAuthentication no' 'PermitRootLogin no' > /etc/ssh/sshd_config.d/90-happier-worker.conf
printf '%s\n' '[boot]' 'systemd=true' '[user]' 'default=__USER__' > /etc/wsl.conf
printf %s '__PROVISION__' | base64 -d > /tmp/happier-linux-provision.sh
chmod 755 /tmp/happier-linux-provision.sh
sudo -H -u '__USER__' /tmp/happier-linux-provision.sh --profile=happier
mkdir -p '/home/__USER__/happier-dev' '/home/__USER__/.happier/dev-targets'
chown -R '__USER__:__USER__' '/home/__USER__/happier-dev' '/home/__USER__/.happier'
ssh-keygen -A
'@
  $setup = $setup.Replace('__USER__',$User).Replace('__KEY__',$key64).Replace('__PROVISION__',$ProvisionBase64)
  Guest $setup | Out-Host
  Wsl @('--terminate',$Instance) | Out-Null
  }
}
if ($Action -eq 'Capacity') {
  Guest ('test "$(cat /etc/happier-worker-owner)" = ' + $User) | Out-Null
  $others = @(Distributions -Running | Where-Object { $_ -ne $Instance })
  if ($others.Count -gt 0) { throw 'Stop other WSL distributions before applying host-wide capacity' }
  Stop-ScheduledTask -TaskName "Happier-WSL-$Instance" -ErrorAction SilentlyContinue
  ApplyCapacity
  Wsl @('--shutdown') | Out-Null
}
$exists = (Distributions) -contains $Instance
$running = $exists -and ((Distributions -Running) -contains $Instance)
if (!$exists) { throw "WSL distribution $Instance does not exist; run managed WSL provisioning" }
if ($Action -ne 'Doctor') {
  Guest 'systemctl start ssh' | Out-Null
  $running = $true
  $taskName = "Happier-WSL-$Instance"
  $taskAction = New-ScheduledTaskAction -Execute 'wsl.exe' -Argument ("--distribution $Instance --user root --exec sleep infinity")
  $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType S4U -RunLevel Highest
  $triggers = @(New-ScheduledTaskTrigger -AtStartup)
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $triggers -Principal $principal -Settings $settings -Force | Out-Null
  if ((Get-ScheduledTask -TaskName $taskName).State -ne 'Running') { Start-ScheduledTask -TaskName $taskName }
}
$toolchainOk = $false; $guestHostKey = ''; $observedCpus = 0; $observedMemoryKiB = 0
if ($running) {
  $probe = Guest 'command -v node; node --version; command -v corepack; getconf _NPROCESSORS_ONLN; awk ''/MemTotal:/ {print $2}'' /proc/meminfo' $User
  $lines = @($probe | Where-Object { $_ })
  $toolchainOk = $lines.Count -ge 5 -and $lines[1] -match '^v(2[2-9]|[3-9][0-9])\.'
  if ($toolchainOk) { $observedCpus = [int]$lines[3]; $observedMemoryKiB = [long]$lines[4] }
  $guestHostKey = (Guest 'cat /etc/ssh/ssh_host_ed25519_key.pub').Trim()
}
$file = Join-Path $env:USERPROFILE '.wslconfig'
$config = if (Test-Path -LiteralPath $file) { [IO.File]::ReadAllText($file) } else { '' }
$capacityMatches = $observedCpus -eq $Cpus -and $config -match "(?m)^\s*memory\s*=\s*$($MemoryGiB)GB\s*$" -and $config -match "(?m)^\s*processors\s*=\s*$Cpus\s*$"
$task = Get-ScheduledTask -TaskName "Happier-WSL-$Instance" -ErrorAction SilentlyContinue
$result = [ordered]@{
  exists=$exists;status=$(if($running){'Running'}else{'Stopped'});ok=($running -and $toolchainOk -and $capacityMatches);
  host='Windows';guestHostKey=$guestHostKey;guestToolchain=@{ok=$toolchainOk};
  resources=@{cpus=$observedCpus;memoryKiB=$observedMemoryKiB;memoryGiB=$MemoryGiB};
  drift=@{resources=@(if (!$capacityMatches) { 'WSL host capacity differs' })};
  autostart=$(if($task){$task.State.ToString()}else{'Missing'})
}
Write-Output ('__HAPPIER_WSL__=' + ($result | ConvertTo-Json -Compress -Depth 5))
