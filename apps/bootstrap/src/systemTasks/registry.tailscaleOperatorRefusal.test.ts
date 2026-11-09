import { dirname, join } from 'node:path';

import { executeSystemTask } from '@happier-dev/cli-common/systemTasks';
import { createFakeTailscaleCli } from '@happier-dev/tests/testkit/tailscale/fakeTailscaleCli';
import { expect, it, vi } from 'vitest';

import { createHsetupSystemTaskRegistry } from './registry.js';

it('preserves the native operator refusal through secure-access setup without URL polling or private diagnostics', async () => {
  const fakeCli = createFakeTailscaleCli({
    serveEnableOutputs: [{
      exitCode: 1,
      stderr: "sending serve config: 401 Unauthorized: must be root, or be an operator and able to run 'sudo tailscale' to serve a path or Unix socket\n/private/operator/path token=private-token",
    }],
  });
  vi.stubEnv('HAPPIER_TAILSCALE_BIN', fakeCli.cliPath);
  vi.stubEnv('HAPPIER_FAKE_TAILSCALE_STATE_PATH', join(dirname(fakeCli.cliPath), 'scenario.json'));
  vi.stubEnv('HAPPIER_FAKE_TAILSCALE_LOG_PATH', join(dirname(fakeCli.cliPath), 'invocations.log'));
  try {
    const result = await executeSystemTask({
      spec: {
        protocolVersion: 1,
        kind: 'secureAccess.tailscale.v1',
        params: { upstreamUrl: 'http://127.0.0.1:3005', loginPolicy: 'skip' },
      },
      taskId: 'operator-refused',
      registry: createHsetupSystemTaskRegistry({ relayAccess: { writeConfig: async () => undefined } }),
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'tailscale_operator_authorization_refused' } });
    if (result.ok) throw new Error('Expected operator refusal');
    expect(result.error?.message).toContain('sudo');
    expect(JSON.stringify(result)).not.toContain('/private/operator/path');
    expect(JSON.stringify(result)).not.toContain('private-token');
    expect(fakeCli.readInvocations().map(args => args.slice(0, 2))).toEqual([
      ['status', '--json'], ['status', '--json'], ['serve', 'status'],
      ['serve', 'status'], ['serve', '--bg'],
    ]);
  } finally {
    vi.unstubAllEnvs();
    fakeCli.cleanup();
  }
});
