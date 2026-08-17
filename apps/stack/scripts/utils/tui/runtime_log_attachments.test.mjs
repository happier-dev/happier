import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveTuiRuntimeLogAttachments } from './runtime_log_attachments.mjs';

test('TUI attaches the detached owner and persisted local and remote component logs', () => {
  assert.deepEqual(
    resolveTuiRuntimeLogAttachments({
      stackBaseDir: '/stacks/exp1',
      runtimeState: {
        logs: { runner: '/stacks/exp1/logs/dev.100.log' },
        remoteTargets: { mac: { status: 'running' } },
      },
      remoteTargetNames: ['linux', 'mac'],
    }),
    [
      { id: 'runner', path: '/stacks/exp1/logs/dev.100.log' },
      { id: 'server', path: '/stacks/exp1/logs/server.log' },
      { id: 'expo', path: '/stacks/exp1/logs/expo.log' },
      { id: 'ui', path: '/stacks/exp1/logs/ui.log' },
      { id: 'remote:linux', path: '/stacks/exp1/logs/remote-linux.log' },
      { id: 'remote:mac', path: '/stacks/exp1/logs/remote-mac.log' },
    ],
  );
});

test('TUI log attachment skips empty and duplicate paths', () => {
  assert.deepEqual(
    resolveTuiRuntimeLogAttachments({
      stackBaseDir: '/stacks/exp1',
      runtimeState: { logs: { runner: '/stacks/exp1/logs/server.log' } },
    }),
    [
      { id: 'runner', path: '/stacks/exp1/logs/server.log' },
      { id: 'expo', path: '/stacks/exp1/logs/expo.log' },
      { id: 'ui', path: '/stacks/exp1/logs/ui.log' },
    ],
  );
});
