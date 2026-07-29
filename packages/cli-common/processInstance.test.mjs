import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseLinuxProcStartTime,
  processInstanceFingerprintMatches,
  readProcessInstanceFingerprintSync,
} from './processInstance.mjs';

test('parseLinuxProcStartTime reads field 22 even when the command contains spaces and parentheses', () => {
  const fields = Array.from({ length: 30 }, (_, index) => String(index + 3));
  fields[19] = '987654';
  assert.equal(
    parseLinuxProcStartTime(`42 (worker (blue) pool) ${fields.join(' ')}`),
    '987654',
  );
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

  assert.equal(readProcessInstanceFingerprintSync(42, {
    platform: 'darwin',
    spawnSyncImpl: () => ({ status: 0, signal: null, stdout: 'Mon Jul 20 12:34:56 2026\n' }),
  }), 'darwin-ps:Mon Jul 20 12:34:56 2026');

  const windowsCalls = [];
  assert.equal(readProcessInstanceFingerprintSync(42, {
    platform: 'win32',
    windowsCreationDateFormat: 'dmtf',
    spawnSyncImpl: (command, args) => {
      windowsCalls.push({ command, args });
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
  }]);
});

test('readProcessInstanceFingerprintSync writes predecessor-compatible Windows ISO fingerprints from WMIC', () => {
  const calls = [];
  assert.equal(readProcessInstanceFingerprintSync(42, {
    platform: 'win32',
    spawnSyncImpl: (command, args) => {
      calls.push({ command, args });
      return {
        status: 0,
        signal: null,
        stdout: 'CreationDate=20260723013456.123456+120\r\n',
      };
    },
  }), 'win32-cim:2026-07-22T23:34:56.1234560Z');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'wmic.exe');
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
        stdout: script.includes('ToUniversalTime().ToString("O")')
          ? '2026-07-23T12:34:56.1234567Z\r\n'
          : 'samedi, 25 juillet 2026 16:49:20\r\n',
      };
    },
  }), expectedFingerprint);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'powershell.exe');
  assert.match(calls[0].args.at(-1), /ToUniversalTime\(\)\.ToString\("O"\)/);
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
