import test from 'node:test';
import assert from 'node:assert/strict';

import { execFileSyncPortable } from '../pipeline/lib/exec-file-sync-portable.mjs';

test('execFileSyncPortable preserves Windows cmd shim argument boundaries', () => {
  /** @type {{ cmd: string; args: string[]; opts: any } | null} */
  let seen = null;
  const out = execFileSyncPortable(
    'C:\\npm\\prefix\\yarn.cmd',
    [
      '--silent',
      'tauri',
      'signer',
      'sign',
      '--password',
      'opaque! secret',
      'D:\\a\\happier\\bundle\\Happier (dev)_0.2.10-266_x64_en-US.msi',
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    {
      execFileSync: (cmd, args, opts) => {
        seen = { cmd, args, opts };
        return 'ok';
      },
    },
  );

  assert.equal(out, 'ok');
  assert.equal(seen?.cmd, 'cmd.exe');
  assert.deepEqual(seen?.args?.slice(0, 3), ['/d', '/s', '/c']);
  assert.match(seen?.args?.[3] ?? '', /Happier\^ \^\(dev\^\)_0\.2\.10-266_x64_en-US\.msi/);
  assert.match(seen?.args?.[3] ?? '', /opaque\^!\^ secret/);
  assert.equal(seen?.opts?.windowsVerbatimArguments, true);
  assert.equal(seen?.opts?.shell, undefined);
});

test('execFileSyncPortable does not override an explicit shell option', () => {
  /** @type {any} */
  let seenOpts = null;
  execFileSyncPortable(
    'C:\\hostedtoolcache\\windows\\node\\22.22.1\\x64\\corepack.cmd',
    ['yarn', '--version'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: false },
    {
      execFileSync: (cmd, args, opts) => {
        void cmd;
        void args;
        seenOpts = opts;
        return 'ok';
      },
    },
  );

  assert.equal(seenOpts?.shell, false);
});
