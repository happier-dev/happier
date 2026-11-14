import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import {
  parseLinuxProcStartTime,
  parseLinuxProcStartTimeMs,
  processGenerationMatches,
  processGenerationProvesReuse,
  compareNumericProcessGenerationIdentities,
  processIdentityMatches,
  processInstanceFingerprintMatches,
  readProcessHostIdentitySync,
  readProcessInstanceFingerprintSync,
  readProcessStartTimeMsSync,
  observeProcessLivenessSync,
} from './processInstance.mjs';

test('OS liveness distinguishes departed Linux tasks without treating stopped or unobservable tasks as dead', () => {
  const boundary = { platform: 'linux', killImpl: () => {} };
  assert.deepEqual(observeProcessLivenessSync(42, {
    ...boundary, readFileSyncImpl: () => '42 (fixture (with spaces)) Z 1 0 0',
  }), { status: 'dead', reason: 'zombie' });
  for (const state of ['D', 'T']) {
    assert.deepEqual(observeProcessLivenessSync(42, {
      ...boundary, readFileSyncImpl: () => `42 (fixture) ${state} 1 0 0`,
    }), { status: 'alive', reason: 'signal_probe' });
  }
  for (const code of [null, 'EPERM']) {
    assert.deepEqual(observeProcessLivenessSync(42, {
      ...boundary,
      killImpl: () => { if (code) throw Object.assign(new Error('denied'), { code }); },
      readFileSyncImpl: () => { throw Object.assign(new Error('unavailable'), { code: 'EACCES' }); },
    }), { status: 'alive', reason: code ? 'permission_denied_but_present' : 'signal_probe' });
  }
  assert.deepEqual(observeProcessLivenessSync(1, { platform: 'darwin', killImpl: () => {} }),
    { status: 'alive', reason: 'signal_probe' });
});

test('process identity uses the start witness across command drift and fences pid reuse', () => {
  const recorded = { pid: 42, processStartTimeMs: 190, processCommandHash: 'a'.repeat(64) };
  assert.equal(processIdentityMatches(recorded, {
    pid: 42,
    processStartTimeMs: 190,
    processCommandHash: 'b'.repeat(64),
  }), true);
  assert.equal(processIdentityMatches(recorded, {
    pid: 42,
    processStartTimeMs: 200,
    processCommandHash: 'a'.repeat(64),
  }), false);
  assert.equal(processIdentityMatches(recorded, {
    pid: 43,
    processStartTimeMs: 190,
    processCommandHash: 'a'.repeat(64),
  }), false);
  assert.equal(processGenerationMatches(190, 190), true);
  assert.equal(processGenerationProvesReuse(190, 200), true);
  assert.equal(processIdentityMatches({
    pid: 42,
    processCommandHash: 'a'.repeat(64),
  }, recorded), true);
  assert.equal(processIdentityMatches({
    pid: 42,
    processCommandHash: 'a'.repeat(64),
  }, { ...recorded, processCommandHash: 'b'.repeat(64) }), false);
});

test('persisted numeric generations share the marker verdict across platforms', () => {
  assert.equal(compareNumericProcessGenerationIdentities('41:1754041400000', '41:1754041400000', 'linux'), 'same');
  assert.equal(compareNumericProcessGenerationIdentities('41:1754041400000', '41:1754041400000', 'darwin'), 'ambiguous');
  assert.equal(compareNumericProcessGenerationIdentities('41:1754041400000', '41:1754041401000'), 'reused');
  assert.equal(compareNumericProcessGenerationIdentities('41:1754041400000', '42:1754041400000'), 'ambiguous');
});

test('parseLinuxProcStartTime reads field 22 even when the command contains spaces and parentheses', () => {
  const fields = Array.from({ length: 30 }, (_, index) => String(index + 3));
  fields[19] = '987654';
  assert.equal(
    parseLinuxProcStartTime(`42 (worker (blue) pool) ${fields.join(' ')}`),
    '987654',
  );
});

test('parseLinuxProcStartTimeMs keeps the daemon numeric witness boot-relative', () => {
  const fields = Array.from({ length: 30 }, (_, index) => String(index + 3));
  fields[19] = '2221490';
  assert.equal(parseLinuxProcStartTimeMs(`42 (runner) ${fields.join(' ')}`), 22_214_900);
  assert.equal(parseLinuxProcStartTimeMs('invalid stat'), null);
});

test('readProcessStartTimeMsSync produces the same Linux numeric witness as the daemon inventory', () => {
  const fields = Array.from({ length: 30 }, (_, index) => String(index + 3));
  fields[19] = '1234';
  assert.equal(readProcessStartTimeMsSync(42, {
    platform: 'linux',
    readFileSyncImpl: () => `42 (worker) ${fields.join(' ')}`,
  }), 12_340);
  assert.equal(readProcessStartTimeMsSync(42, {
    platform: 'darwin',
    spawnSyncImpl: () => ({ status: 0, signal: null, stdout: 'Mon Jul 20 12:34:56 2026\n' }),
  }), Date.parse('Mon Jul 20 12:34:56 2026'));
  assert.equal(readProcessStartTimeMsSync(42, {
    platform: 'win32',
    spawnSyncImpl: () => ({ status: 0, signal: null, stdout: '2026-07-22T23:34:56.1234560Z\r\n' }),
  }), Date.parse('2026-07-22T23:34:56.1234560Z'));
  assert.equal(readProcessStartTimeMsSync(42, {
    platform: 'linux',
    readFileSyncImpl: () => { throw new Error('proc unavailable'); },
  }), null);
});

test('processInstanceFingerprintMatches preserves the predecessor pure comparison contract', () => {
  assert.equal(processInstanceFingerprintMatches('linux-proc:1', 'linux-proc:1'), true);
  assert.equal(processInstanceFingerprintMatches(' linux-proc:1 ', 'linux-proc:1'), true);
  assert.equal(processInstanceFingerprintMatches('linux-proc:1', null), false);
  assert.equal(processInstanceFingerprintMatches(null, 'linux-proc:1'), false);
});

test('readProcessInstanceFingerprintSync uses the platform-owned incarnation source', () => {
  assert.equal(readProcessInstanceFingerprintSync(42, {
    platform: 'linux',
    readFileSyncImpl: () => {
      const fields = Array.from({ length: 30 }, (_, index) => String(index + 3));
      fields[19] = '1234';
      return `42 (worker) ${fields.join(' ')}`;
    },
  }), 'linux-proc:1234');

  let darwinOptions = null;
  assert.equal(readProcessInstanceFingerprintSync(42, {
    platform: 'darwin',
    spawnSyncImpl: (_command, _args, options) => {
      darwinOptions = options;
      return { status: 0, signal: null, stdout: 'Mon Jul 20 12:34:56 2026\n' };
    },
  }), 'darwin-ps:Mon Jul 20 12:34:56 2026');
  assert.equal(darwinOptions.timeout, 5_000);

  const windowsCalls = [];
  assert.equal(readProcessInstanceFingerprintSync(42, {
    platform: 'win32',
    windowsCreationDateFormat: 'dmtf',
    spawnSyncImpl: (command, args, options) => {
      windowsCalls.push({ command, args, options });
      return {
        status: 0,
        signal: null,
        stdout: '\r\r\nCreationDate=20260720123456.000000+120\r\r\n\r\r\n',
      };
    },
  }), 'win32-cim:20260720123456.000000+120');
  assert.deepEqual(windowsCalls, [{
    command: 'wmic.exe',
    args: ['process', 'where', 'processid=42', 'get', 'CreationDate', '/value'],
    options: {
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
      timeout: 5_000,
    },
  }]);
});

test('readProcessInstanceFingerprintSync writes predecessor-compatible Windows ISO fingerprints through the native fast path', () => {
  const calls = [];
  assert.equal(readProcessInstanceFingerprintSync(42, {
    platform: 'win32',
    spawnSyncImpl: (command, args, options) => {
      calls.push({ command, args, options });
      return {
        status: 0,
        signal: null,
        stdout: '2026-07-22T23:34:56.1234560Z\r\n',
      };
    },
  }), 'win32-cim:2026-07-22T23:34:56.1234560Z');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'powershell.exe');
  assert.equal(calls[0].options.timeout, 5_000);
});

test('readProcessInstanceFingerprintSync normalizes WMIC and PowerShell Windows creation dates identically', () => {
  const dmtfCreationDate = '20260720123456.123456-420';
  const wmicFingerprint = readProcessInstanceFingerprintSync(42, {
    platform: 'win32',
    windowsCreationDateFormat: 'dmtf',
    spawnSyncImpl: () => ({
      status: 0,
      signal: null,
      stdout: `CreationDate=${dmtfCreationDate}\r\n`,
    }),
  });
  let call = 0;
  const powershellFingerprint = readProcessInstanceFingerprintSync(42, {
    platform: 'win32',
    windowsCreationDateFormat: 'dmtf',
    spawnSyncImpl: () => {
      call += 1;
      return call === 1
        ? { status: 1, signal: null, stdout: '' }
        : { status: 0, signal: null, stdout: `${dmtfCreationDate}\r\n` };
    },
  });

  assert.equal(wmicFingerprint, `win32-cim:${dmtfCreationDate}`);
  assert.equal(powershellFingerprint, wmicFingerprint);
});

test('readProcessInstanceFingerprintSync falls back from unavailable or invalid WMIC output', () => {
  for (const wmicResult of [
    { error: Object.assign(new Error('missing'), { code: 'ENOENT' }), status: null, signal: null, stdout: '' },
    { status: 0, signal: null, stdout: 'CreationDate=not-a-date\r\n' },
  ]) {
    const calls = [];
    assert.equal(readProcessInstanceFingerprintSync(42, {
      platform: 'win32',
      windowsCreationDateFormat: 'dmtf',
      spawnSyncImpl: (command, args) => {
        calls.push({ command, args });
        return calls.length === 1
          ? wmicResult
          : { status: 0, signal: null, stdout: '20260720123456.123456-420\r\n' };
      },
    }), 'win32-cim:20260720123456.123456-420');
    assert.equal(calls[0].command, 'wmic.exe');
    assert.equal(calls[1].command, 'powershell.exe');
    assert.match(calls[1].args.at(-1), /ManagementDateTimeConverter/);
  }
});

test('readProcessInstanceFingerprintSync preserves an existing legacy Windows fingerprint during comparison', () => {
  const expectedFingerprint = 'win32-cim:samedi, 25 juillet 2026 16:49:20';
  const calls = [];
  assert.equal(readProcessInstanceFingerprintSync(42, {
    platform: 'win32',
    windowsCreationDateFormat: 'dmtf',
    expectedFingerprint,
    spawnSyncImpl: (command, args) => {
      calls.push({ command, args });
      return {
        status: 0,
        signal: null,
        stdout: 'samedi, 25 juillet 2026 16:49:20\r\n',
      };
    },
  }), expectedFingerprint);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'powershell.exe');
  assert.doesNotMatch(calls[0].args.at(-1), /ManagementDateTimeConverter/);
});

test('readProcessInstanceFingerprintSync preserves the predecessor ISO Windows fingerprint during comparison', () => {
  const expectedFingerprint = 'win32-cim:2026-07-23T12:34:56.1234567Z';
  const calls = [];
  assert.equal(readProcessInstanceFingerprintSync(42, {
    platform: 'win32',
    expectedFingerprint,
    spawnSyncImpl: (command, args) => {
      calls.push({ command, args });
      const script = args.at(-1);
      return {
        status: 0,
        signal: null,
        stdout: script.includes('Get-CimInstance')
          ? '2026-07-23T12:34:56.1234567Z\r\n'
          : 'samedi, 25 juillet 2026 16:49:20\r\n',
      };
    },
  }), expectedFingerprint);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'powershell.exe');
  assert.match(calls[0].args.at(-1), /Get-CimInstance/);
  assert.doesNotMatch(calls[0].args.at(-1), /GetProcessById/);
});

test('readProcessInstanceFingerprintSync fails closed when every incarnation source is unavailable', () => {
  assert.equal(readProcessInstanceFingerprintSync(42, {
    platform: 'linux',
    readFileSyncImpl: () => { throw new Error('denied'); },
  }), null);
  let windowsCalls = 0;
  assert.equal(readProcessInstanceFingerprintSync(42, {
    platform: 'win32',
    windowsCreationDateFormat: 'dmtf',
    spawnSyncImpl: () => {
      windowsCalls += 1;
      return windowsCalls === 1
        ? { status: 0, signal: null, stdout: 'CreationDate=invalid\r\n' }
        : { status: 1, signal: null, stdout: '' };
    },
  }), null);
  assert.equal(windowsCalls, 2);
});

test('readProcessHostIdentitySync reads the platform-owned stable host identity', () => {
  assert.deepEqual(readProcessHostIdentitySync({
    platform: 'linux',
    readFileSyncImpl: (path) => ({
      '/etc/machine-id': 'linux-machine\n',
      '/proc/sys/kernel/random/boot_id': 'linux-boot\n',
    })[path],
    readlinkSyncImpl: () => 'pid:[4026531836]',
  }), {
    machineId: 'linux-machine',
    bootId: 'linux-boot',
    pidNamespace: 'pid:[4026531836]',
    pidNamespaced: true,
  });

  const darwinCalls = [];
  assert.deepEqual(readProcessHostIdentitySync({
    platform: 'darwin',
    spawnSyncImpl: (command, args, options) => {
      darwinCalls.push({ command, args, timeout: options.timeout });
      return {
        status: 0,
        signal: null,
        stdout: [
          '+-o J316sAP  <class IOPlatformExpertDevice, id 0x100000120, registered>',
          '  {',
          '    "IOPlatformSerialNumber" = "C02XXXXXXX"',
          '    "IOPlatformUUID" = "564D1B84-1C2D-4E5F-8A9B-0C1D2E3F4A5B"',
          '  }',
        ].join('\n'),
      };
    },
  }), {
    machineId: 'darwin:564D1B84-1C2D-4E5F-8A9B-0C1D2E3F4A5B',
    bootId: null,
    pidNamespace: null,
    pidNamespaced: false,
  });
  assert.deepEqual(darwinCalls, [{
    command: '/usr/sbin/ioreg',
    args: ['-rd1', '-c', 'IOPlatformExpertDevice'],
    timeout: 5_000,
  }]);

  assert.deepEqual(readProcessHostIdentitySync({
    platform: 'win32',
    hostnameImpl: () => 'BUILD-BOX',
    spawnSyncImpl: (command, args) => {
      assert.equal(command, 'reg.exe');
      assert.ok(args.includes('/reg:64'));
      return {
        status: 0,
        signal: null,
        stdout: '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n'
          + '    MachineGuid    REG_SZ    2B6F1C64-AAAA-4BBB-8CCC-0123456789AB\r\n\r\n',
      };
    },
  }), {
    machineId: 'win32:2b6f1c64-aaaa-4bbb-8ccc-0123456789ab:build-box',
    bootId: null,
    pidNamespace: null,
    pidNamespaced: false,
  });
});

test('readProcessHostIdentitySync fails closed when the host identity source is unavailable', () => {
  const failedSpawn = () => ({ status: 1, signal: null, stdout: '' });
  assert.equal(readProcessHostIdentitySync({
    platform: 'linux',
    readFileSyncImpl: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
  }), null);
  assert.equal(readProcessHostIdentitySync({ platform: 'darwin', spawnSyncImpl: failedSpawn }), null);
  assert.equal(readProcessHostIdentitySync({
    platform: 'darwin',
    spawnSyncImpl: () => ({ status: 0, signal: null, stdout: '"IOPlatformUUID" = ""' }),
  }), null);
  assert.equal(readProcessHostIdentitySync({
    platform: 'win32',
    hostnameImpl: () => 'BUILD-BOX',
    spawnSyncImpl: failedSpawn,
  }), null);
  assert.equal(readProcessHostIdentitySync({ platform: 'freebsd' }), null);
});

const windowsOnly = { skip: process.platform !== 'win32' && 'requires Windows' };

function readCimFingerprint(pid) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction Stop; if ($null -eq $p) { exit 3 }; $p.CreationDate.ToUniversalTime().ToString("O")`,
  ], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return `win32-cim:${result.stdout.trim()}`;
}

// Only intercept the OS command boundary; execute the owner's real PowerShell script.
function windowsProbe({ pid = process.pid, transform = (script) => script } = {}) {
  let result;
  let stderrMode;
  const fingerprint = readProcessInstanceFingerprintSync(pid, {
    platform: 'win32',
    spawnSyncImpl(command, args, options) {
      stderrMode = options.stdio?.[2];
      result = spawnSync(command, [...args.slice(0, -1), transform(args.at(-1))], {
        ...options, stdio: ['ignore', 'pipe', 'pipe'],
      });
      return result;
    },
  });
  return { fingerprint, result, stderrMode };
}

function replaceStartTime(script, expression, pid = process.pid) {
  const original = `[System.Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime()`;
  assert.ok(script.includes(original), 'must intercept the actual OS read');
  return script.replace(original, expression);
}

const rejectCim = 'function Get-CimInstance { throw "CIM must not run" }; ';

test('Windows fast path matches CIM with CIM disabled in the production probe', windowsOnly, () => {
  const expected = readCimFingerprint(process.pid);
  const { fingerprint, result } = windowsProbe({ transform: (script) => rejectCim + script });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fingerprint, expected);
  assert.equal(result.stderr, '');
});

test('Windows fast path truncates sub-microsecond ticks to the persisted CIM precision', windowsOnly, () => {
  const { fingerprint, result } = windowsProbe({ transform: (script) => rejectCim + replaceStartTime(script,
    '[DateTime]::Parse("2026-07-23T12:34:56.1234567Z").ToUniversalTime()') });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fingerprint, 'win32-cim:2026-07-23T12:34:56.1234560Z');
});

test('Windows fallback preserves the fingerprint and reports the slow path on stderr', windowsOnly, () => {
  const expected = readCimFingerprint(process.pid);
  const { fingerprint, result, stderrMode } = windowsProbe({ transform: (script) => replaceStartTime(script,
    '$(throw [System.ComponentModel.Win32Exception]::new(5))') });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fingerprint, expected);
  assert.match(result.stderr, /process.*fingerprint.*CIM/i);
  assert.equal(stderrMode, 'inherit', 'the diagnostic must be visible without opt-in logging');
});

test('Windows expired process returns null without querying CIM', windowsOnly, () => {
  const expired = spawnSync(process.execPath, ['-e', '']);
  assert.equal(expired.status, 0);
  const { fingerprint, result } = windowsProbe({ pid: expired.pid, transform: (script) => rejectCim + script });
  assert.equal(fingerprint, null);
  assert.equal(result.status, 3, result.stderr);
  assert.equal(result.stderr, '');
});
