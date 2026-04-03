import test from 'node:test';
import assert from 'node:assert/strict';

import { execFileSyncPortable } from '../pipeline/lib/exec-file-sync-portable.mjs';

test('execFileSyncPortable enables shell when cmd ends with .cmd', () => {
  /** @type {any} */
  let seenOpts = null;
  const out = execFileSyncPortable(
    'C:\\hostedtoolcache\\windows\\node\\22.22.1\\x64\\corepack.cmd',
    ['yarn', '--version'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    {
      execFileSync: (cmd, args, opts) => {
        void cmd;
        void args;
        seenOpts = opts;
        return 'ok';
      },
    },
  );

  assert.equal(out, 'ok');
  assert.equal(Boolean(seenOpts?.shell), true);
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

