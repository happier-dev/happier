import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  processInstanceFingerprintMatches,
  readProcessInstanceFingerprintSync,
} from './processInstance.mjs';

test('readProcessInstanceFingerprintSync reads the Linux proc start-time field', () => {
  const stat = `123 (node worker) S ${Array.from({ length: 18 }, (_, index) => index + 1).join(' ')} 987654 0 0`;
  assert.equal(
    readProcessInstanceFingerprintSync(123, {
      platform: 'linux',
      readFileSyncImpl: () => stat,
      spawnSyncImpl: () => {
        throw new Error('portable fallback must not run');
      },
    }),
    'linux-proc:987654',
  );
});

test('readProcessInstanceFingerprintSync reads a Windows CIM creation timestamp', () => {
  const calls = [];
  const fingerprint = readProcessInstanceFingerprintSync(456, {
    platform: 'win32',
    spawnSyncImpl: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: '2026-07-23T12:34:56.0000000Z\r\n' };
    },
  });

  assert.equal(fingerprint, 'win32-cim:2026-07-23T12:34:56.0000000Z');
  assert.equal(calls[0].command, 'powershell.exe');
  assert.match(calls[0].args.at(-1), /ProcessId=456/);
  assert.equal(calls[0].options.shell, undefined);
});

test('readProcessInstanceFingerprintSync returns null when the Windows probe reports a missing process', () => {
  assert.equal(
    readProcessInstanceFingerprintSync(456, {
      platform: 'win32',
      spawnSyncImpl: () => ({ status: 3, stdout: '' }),
    }),
    null,
  );
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
      stderrMode = options.stdio[2];
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

test('processInstanceFingerprintMatches fails closed when either observation is unavailable', () => {
  assert.equal(processInstanceFingerprintMatches('linux-proc:1', 'linux-proc:1'), true);
  assert.equal(processInstanceFingerprintMatches('linux-proc:1', null), false);
  assert.equal(processInstanceFingerprintMatches(null, 'linux-proc:1'), false);
});
