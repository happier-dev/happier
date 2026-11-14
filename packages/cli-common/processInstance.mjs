import { readFileSync, readlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import { createHash } from 'node:crypto';

const PROCESS_INSTANCE_PROBE_TIMEOUT_MS = 5_000;

function normalizePid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 1 ? pid : null;
}

function parseLinuxProcFields(statText) {
  const raw = String(statText ?? '').trim();
  const commandEnd = raw.lastIndexOf(') ');
  if (commandEnd < 0) return null;
  return raw.slice(commandEnd + 2).trim().split(/\s+/);
}

export function parseLinuxProcStartTime(statText) {
  const startTime = String(parseLinuxProcFields(statText)?.[19] ?? '').trim();
  return /^\d+$/.test(startTime) ? startTime : null;
}

export function observeProcessLivenessSync(pid, {
  killImpl = process.kill,
  platform = process.platform,
  readFileSyncImpl = readFileSync,
} = {}) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return { status: 'dead', reason: 'invalid_pid' };
  let reason = 'signal_probe';
  try {
    killImpl(n, 0);
  } catch (error) {
    if (error?.code === 'ESRCH') return { status: 'dead', reason: 'not_found' };
    if (error?.code === 'EPERM') reason = 'permission_denied_but_present';
    else return { status: 'inconclusive', reason: error?.code ?? 'liveness_probe_failed', error };
  }
  if (platform === 'linux') {
    try {
      const stat = readFileSyncImpl(`/proc/${n}/stat`, 'utf8');
      // An unreaped process still passes signal 0 but has already departed.
      // Missing procfs evidence must not turn a genuinely live owner into dead.
      if (stat.startsWith(`${n} (`) && parseLinuxProcFields(stat)?.[0] === 'Z') {
        return { status: 'dead', reason: 'zombie' };
      }
    } catch {}
  }
  return { status: 'alive', reason };
}

export function parseLinuxProcStartTimeMs(statText) {
  const ticks = parseLinuxProcStartTime(statText);
  if (ticks === null) return null;
  // Preserve the daemon's numeric tenfold tick scale in one owner. Equality,
  // rather than elapsed wall time, is the contract for this boot-relative witness.
  const scaledTicks = Number(ticks) * 10;
  return Number.isSafeInteger(scaledTicks) ? scaledTicks : null;
}

export function hashProcessCommand(command) {
  return createHash('sha256').update(command).digest('hex');
}

function isValidProcessStartTimeMs(value) {
  return Number.isInteger(value) && value >= 0;
}

export function processGenerationMatches(expected, observed) {
  return isValidProcessStartTimeMs(expected)
    && isValidProcessStartTimeMs(observed)
    && expected === observed;
}

export function processGenerationProvesReuse(expected, observed) {
  return isValidProcessStartTimeMs(expected)
    && isValidProcessStartTimeMs(observed)
    && expected !== observed;
}

/** Legacy numeric identities have second-resolution Darwin witnesses; native tagged custody is compared separately. */
export function compareNumericProcessGenerationIdentities(expectedIdentity, observedIdentity, platform = process.platform) {
  const parse = (value) => {
    const match = /^(\d+):(\d+)$/u.exec(value);
    if (!match) return null;
    const pid = Number(match[1]);
    const startMs = Number(match[2]);
    return Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(startMs) && startMs >= 0
      ? { pid, startMs }
      : null;
  };
  const expected = parse(expectedIdentity);
  const observed = parse(observedIdentity);
  if (!expected || !observed || expected.pid !== observed.pid) return 'ambiguous';
  if (processGenerationProvesReuse(expected.startMs, observed.startMs)) return 'reused';
  if (!processGenerationMatches(expected.startMs, observed.startMs)) return 'ambiguous';
  // ps lstart on Darwin has only whole-second precision. Equal legacy values
  // cannot authorize destructive managed-process custody after same-second reuse.
  return platform === 'darwin' ? 'ambiguous' : 'same';
}

/** A recorded start witness outranks mutable command text; hash is a legacy fallback. */
export function processIdentityMatches(expected, observed) {
  if (
    !Number.isInteger(expected?.pid)
    || expected.pid <= 0
    || expected.pid !== observed?.pid
  ) return false;
  if (expected.processStartTimeMs !== undefined) {
    return processGenerationMatches(
      expected.processStartTimeMs,
      observed.processStartTimeMs,
    );
  }
  const expectedHash = expected.processCommandHash;
  return typeof expectedHash === 'string'
    && /^[a-f0-9]{64}$/u.test(expectedHash)
    && expectedHash === observed.processCommandHash;
}

function readSpawnOutput(result) {
  if (result?.error || result?.signal || result?.status !== 0) return null;
  const output = String(result?.stdout ?? '').trim();
  return output || null;
}

function parseWindowsCreationDate(output) {
  const lines = String(output ?? '')
    .replaceAll('\0', '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    const value = line.startsWith('CreationDate=')
      ? line.slice('CreationDate='.length).trim()
      : line;
    if (/^\d{14}\.\d{6}[+-]\d{3}$/.test(value)) return value;
  }
  return null;
}

function readWindowsProcessCreationDateDmtfSync(pid, spawnSyncImpl) {
  const wmicCreationDate = parseWindowsCreationDate(readSpawnOutput(spawnSyncImpl(
    'wmic.exe',
    ['process', 'where', `processid=${pid}`, 'get', 'CreationDate', '/value'],
    { encoding: 'utf8', windowsHide: true, shell: false, timeout: PROCESS_INSTANCE_PROBE_TIMEOUT_MS },
  )));
  if (wmicCreationDate) return wmicCreationDate;

  const script = [
    `$process = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"`,
    'if ($null -eq $process) { exit 3 }',
    '[System.Management.ManagementDateTimeConverter]::ToDmtfDateTime($process.CreationDate)',
  ].join('; ');
  return parseWindowsCreationDate(readSpawnOutput(spawnSyncImpl(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, shell: false, timeout: PROCESS_INSTANCE_PROBE_TIMEOUT_MS },
  )));
}

function readWindowsProcessCreationDateLegacySync(pid, spawnSyncImpl) {
  const script = [
    `$process = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"`,
    'if ($null -eq $process) { exit 3 }',
    '$process.CreationDate',
  ].join('; ');
  return readSpawnOutput(spawnSyncImpl(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, shell: false, timeout: PROCESS_INSTANCE_PROBE_TIMEOUT_MS },
  ));
}

function readWindowsProcessCreationDatePredecessorIsoSync(
  pid,
  spawnSyncImpl,
  expectedCreationDate = '',
) {
  // New fingerprints retain CIM's microsecond precision. Existing ISO fingerprints with a
  // nonzero seventh digit still use their exact CIM observation rather than being truncated.
  const useNativeStartTime = !expectedCreationDate || /\.\d{6}0Z$/.test(expectedCreationDate);
  const cimScript = [
    `$process = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction Stop`,
    'if ($null -eq $process) { exit 3 }',
    '$t = $process.CreationDate.ToUniversalTime()',
  ].join('; ');
  const script = [
    ...(useNativeStartTime ? [
      `$t = $null; try { $t = [System.Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime() } catch [System.ArgumentException] { exit 3 } catch { $t = $null }`,
      'if ($null -ne $t) { $t = [DateTime]::new($t.Ticks - ($t.Ticks % 10), [DateTimeKind]::Utc) } else {',
      '[Console]::Error.WriteLine("[happier] Windows process fingerprint: .NET StartTime unavailable; using slower CIM probe.")',
      cimScript,
      '}',
    ] : [cimScript]),
    '$t.ToString("O")',
  ].join('; ');
  return readSpawnOutput(spawnSyncImpl(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, shell: false, timeout: PROCESS_INSTANCE_PROBE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'inherit'] },
  ));
}

export function readProcessInstanceFingerprintSync(
  pidValue,
  {
    platform = process.platform,
    readFileSyncImpl = readFileSync,
    spawnSyncImpl = spawnSync,
    windowsCreationDateFormat = 'iso',
    expectedFingerprint = null,
  } = {},
) {
  const pid = normalizePid(pidValue);
  if (!pid) return null;

  if (platform === 'linux') {
    try {
      const startTime = parseLinuxProcStartTime(
        readFileSyncImpl(`/proc/${pid}/stat`, 'utf8'),
      );
      return startTime ? `linux-proc:${startTime}` : null;
    } catch {
      return null;
    }
  }

  if (platform === 'win32') {
    const expectedWindowsCreationDate = String(expectedFingerprint ?? '').startsWith('win32-cim:')
      ? String(expectedFingerprint).slice('win32-cim:'.length)
      : '';
    const expectedUsesDmtf = /^\d{14}\.\d{6}[+-]\d{3}$/.test(expectedWindowsCreationDate);
    const expectedUsesPredecessorIso =
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/.test(expectedWindowsCreationDate);
    const creationDate = expectedUsesPredecessorIso
      ? readWindowsProcessCreationDatePredecessorIsoSync(
        pid,
        spawnSyncImpl,
        expectedWindowsCreationDate,
      )
      : expectedUsesDmtf || (!expectedWindowsCreationDate && windowsCreationDateFormat === 'dmtf')
        ? readWindowsProcessCreationDateDmtfSync(pid, spawnSyncImpl)
        : expectedWindowsCreationDate || windowsCreationDateFormat === 'legacy'
          ? readWindowsProcessCreationDateLegacySync(pid, spawnSyncImpl)
          : readWindowsProcessCreationDatePredecessorIsoSync(pid, spawnSyncImpl);
    return creationDate ? `win32-cim:${creationDate}` : null;
  }

  const startedAt = readSpawnOutput(spawnSyncImpl(
    'ps',
    ['-o', 'lstart=', '-p', String(pid)],
    { encoding: 'utf8', shell: false, timeout: PROCESS_INSTANCE_PROBE_TIMEOUT_MS },
  ));
  return startedAt ? `${platform}-ps:${startedAt}` : null;
}

/** Numeric process birth in the same units used by CLI process inventory. */
export function readProcessStartTimeMsSync(pidValue, boundary = {}) {
  const pid = normalizePid(pidValue);
  if (!pid) return null;
  const platform = boundary.platform ?? process.platform;
  if (platform === 'linux') {
    try {
      return parseLinuxProcStartTimeMs(
        (boundary.readFileSyncImpl ?? readFileSync)(`/proc/${pid}/stat`, 'utf8'),
      );
    } catch {
      return null;
    }
  }
  const fingerprint = readProcessInstanceFingerprintSync(pid, boundary);
  const prefix = platform === 'win32' ? 'win32-cim:' : `${platform}-ps:`;
  if (!fingerprint?.startsWith(prefix)) return null;
  const parsed = Date.parse(fingerprint.slice(prefix.length));
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function processInstanceFingerprintMatches(expectedFingerprint, observedFingerprint) {
  const expected = String(expectedFingerprint ?? '').trim();
  const observed = String(observedFingerprint ?? '').trim();
  return Boolean(expected && observed && expected === observed);
}

export function processInstanceFingerprintMatchesSync(pid, expectedFingerprint, options = {}) {
  const expected = String(expectedFingerprint ?? '').trim();
  if (!expected) return false;
  const observed = readProcessInstanceFingerprintSync(pid, {
    ...options,
    expectedFingerprint: expected,
  });
  return observed !== null && observed === expected;
}

function readLinuxProcessHostIdentitySync(readFileSyncImpl, readlinkSyncImpl) {
  try {
    const machineId = String(readFileSyncImpl('/etc/machine-id', 'utf8') ?? '').trim();
    const bootId = String(readFileSyncImpl('/proc/sys/kernel/random/boot_id', 'utf8') ?? '').trim();
    let pidNamespace = null;
    try {
      pidNamespace = String(readlinkSyncImpl('/proc/self/ns/pid') ?? '').trim() || null;
    } catch {
      // Without the PID namespace, host/boot identity still proves prior-boot owners dead, but
      // same-boot PID observations cannot be attributed to this namespace.
    }
    // Linux process fingerprints are boot-relative and PIDs are namespace-scoped, so local PID
    // evidence is attributable only when boot and PID namespace also match.
    return machineId && bootId ? { machineId, bootId, pidNamespace, pidNamespaced: true } : null;
  } catch {
    return null;
  }
}

function parseDarwinPlatformUuid(output) {
  const match = /"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]{36})"/.exec(String(output ?? ''));
  return match ? match[1].toUpperCase() : null;
}

function parseWindowsMachineGuid(output) {
  const match = /MachineGuid\s+REG_SZ\s+([0-9A-Fa-f-]{36})/.exec(String(output ?? ''));
  return match ? match[1].toLowerCase() : null;
}

/**
 * Stable identity of the host whose PID space the current process observes, or null when it
 * cannot be proven. Two processes with equal identities can attribute each other's PID/incarnation
 * facts; darwin and win32 have one PID space per host and wall-clock process fingerprints, so the
 * hardware/installation id alone scopes them. The win32 hostname separates process-isolated
 * containers that can inherit an image's MachineGuid.
 */
export function readProcessHostIdentitySync({
  platform = process.platform,
  readFileSyncImpl = readFileSync,
  readlinkSyncImpl = readlinkSync,
  spawnSyncImpl = spawnSync,
  hostnameImpl = hostname,
} = {}) {
  if (platform === 'linux') return readLinuxProcessHostIdentitySync(readFileSyncImpl, readlinkSyncImpl);

  if (platform === 'darwin') {
    const platformUuid = parseDarwinPlatformUuid(readSpawnOutput(spawnSyncImpl(
      '/usr/sbin/ioreg',
      ['-rd1', '-c', 'IOPlatformExpertDevice'],
      { encoding: 'utf8', shell: false, timeout: PROCESS_INSTANCE_PROBE_TIMEOUT_MS },
    )));
    return platformUuid
      ? { machineId: `darwin:${platformUuid}`, bootId: null, pidNamespace: null, pidNamespaced: false }
      : null;
  }

  if (platform === 'win32') {
    const machineGuid = parseWindowsMachineGuid(readSpawnOutput(spawnSyncImpl(
      'reg.exe',
      ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64'],
      { encoding: 'utf8', windowsHide: true, shell: false, timeout: PROCESS_INSTANCE_PROBE_TIMEOUT_MS },
    )));
    let hostName = '';
    try {
      hostName = String(hostnameImpl() ?? '').trim().toLowerCase();
    } catch {}
    return machineGuid && hostName
      ? { machineId: `win32:${machineGuid}:${hostName}`, bootId: null, pidNamespace: null, pidNamespaced: false }
      : null;
  }

  return null;
}
