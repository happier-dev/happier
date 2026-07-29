import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

function normalizePid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 1 ? pid : null;
}

export function parseLinuxProcStartTime(statText) {
  const raw = String(statText ?? '').trim();
  const commandEnd = raw.lastIndexOf(') ');
  if (commandEnd < 0) return null;
  const fieldsFromState = raw.slice(commandEnd + 2).trim().split(/\s+/);
  const startTime = String(fieldsFromState[19] ?? '').trim();
  return /^\d+$/.test(startTime) ? startTime : null;
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
    { encoding: 'utf8', windowsHide: true, shell: false },
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
    { encoding: 'utf8', windowsHide: true, shell: false },
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
    { encoding: 'utf8', windowsHide: true, shell: false },
  ));
}

function convertWindowsDmtfCreationDateToPredecessorIso(value) {
  const match = String(value ?? '').match(
    /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-])(\d{3})$/,
  );
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction, sign, offsetText] = match;
  const [year, month, day, hour, minute, second] = [
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
  ].map(Number);
  const localEpochMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const localDate = new Date(localEpochMs);
  if (
    year < 1000
    || localDate.getUTCFullYear() !== year
    || localDate.getUTCMonth() !== month - 1
    || localDate.getUTCDate() !== day
    || localDate.getUTCHours() !== hour
    || localDate.getUTCMinutes() !== minute
    || localDate.getUTCSeconds() !== second
  ) {
    return null;
  }
  const signedOffsetMinutes = Number(offsetText) * (sign === '+' ? 1 : -1);
  const utcDate = new Date(localEpochMs - signedOffsetMinutes * 60_000);
  return `${utcDate.toISOString().slice(0, 19)}.${fraction}0Z`;
}

function readWindowsProcessCreationDatePredecessorIsoSync(
  pid,
  spawnSyncImpl,
  expectedCreationDate = '',
) {
  if (!expectedCreationDate || /\.\d{6}0Z$/.test(expectedCreationDate)) {
    const dmtfCreationDate = readWindowsProcessCreationDateDmtfSync(pid, spawnSyncImpl);
    const convertedCreationDate =
      convertWindowsDmtfCreationDateToPredecessorIso(dmtfCreationDate);
    if (convertedCreationDate) return convertedCreationDate;
  }
  const script = [
    `$process = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"`,
    'if ($null -eq $process) { exit 3 }',
    '$process.CreationDate.ToUniversalTime().ToString("O")',
  ].join('; ');
  return readSpawnOutput(spawnSyncImpl(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, shell: false },
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
    { encoding: 'utf8', shell: false },
  ));
  return startedAt ? `${platform}-ps:${startedAt}` : null;
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
