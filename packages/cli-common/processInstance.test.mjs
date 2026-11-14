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

test('readProcessInstanceFingerprintSync prefers .NET Process.StartTime and keeps CIM as a fallback on Windows', () => {
  const calls = [];
  readProcessInstanceFingerprintSync(456, {
    platform: 'win32',
    spawnSyncImpl: (command, args) => {
      calls.push({ command, args });
      return { status: 0, stdout: '2026-07-23T12:34:56.1234560Z\r\n' };
    },
  });

  assert.equal(calls.length, 1);
  const script = calls[0].args.at(-1);
  const fastPathIndex = script.indexOf('[System.Diagnostics.Process]::GetProcessById(456).StartTime');
  const cimIndex = script.indexOf('Get-CimInstance Win32_Process -Filter "ProcessId=456"');
  assert.ok(fastPathIndex >= 0, 'uses the .NET fast path');
  assert.ok(cimIndex > fastPathIndex, 'falls back to CIM after the fast path');
  // A missing process must still report "not found" (exit 3) instead of falling through to CIM.
  assert.match(script, /catch \[System\.ArgumentException\] \{ exit 3 \}/);
  // Truncate to whole microseconds so the value matches WMI's CreationDate precision.
  assert.match(script, /\$t\.Ticks % 10/);
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

test(
  'Windows .NET fast path produces the same fingerprint as the CIM query',
  { skip: process.platform !== 'win32' && 'requires Windows' },
  () => {
    const cimScript = [
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${process.pid}" -ErrorAction Stop`,
      'if ($null -eq $p) { exit 3 }',
      '$p.CreationDate.ToUniversalTime().ToString("O")',
    ].join('; ');
    const cim = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cimScript], {
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(cim.status, 0);
    assert.equal(readProcessInstanceFingerprintSync(process.pid), `win32-cim:${String(cim.stdout).trim()}`);
  },
);

test('processInstanceFingerprintMatches fails closed when either observation is unavailable', () => {
  assert.equal(processInstanceFingerprintMatches('linux-proc:1', 'linux-proc:1'), true);
  assert.equal(processInstanceFingerprintMatches('linux-proc:1', null), false);
  assert.equal(processInstanceFingerprintMatches(null, 'linux-proc:1'), false);
});
