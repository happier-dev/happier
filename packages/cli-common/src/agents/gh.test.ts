import { afterEach, describe, expect, it, vi } from 'vitest';

import { runGhCommand } from './gh.js';

// A real child process observes the exact environment the gh process would receive.
const inspectEnvironment = [
  '-e',
  'process.stdout.write(JSON.stringify({ token: process.env.GH_TOKEN ?? null, hostOnly: process.env.HAPPIER_GH_HOST_ONLY ?? null }));',
];

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('runGhCommand', () => {
  it('keeps supplied Session environments isolated, including an empty environment', async () => {
    vi.stubEnv('GH_TOKEN', 'host-token');
    vi.stubEnv('HAPPIER_GH_HOST_ONLY', 'host-only');

    await Promise.all([{}, { GH_TOKEN: 'first-session' }, { GH_TOKEN: 'second-session' }].map(async (env) => {
      const result = await runGhCommand({ binPath: process.execPath, args: inspectEnvironment, env });

      expect(result.ok).toBe(true);
      expect(JSON.parse(result.stdout)).toEqual({ token: env.GH_TOKEN ?? null, hostOnly: null });
    }));
  });

  it('inherits the process environment when the caller omits an environment', async () => {
    vi.stubEnv('GH_TOKEN', 'host-token');
    vi.stubEnv('HAPPIER_GH_HOST_ONLY', 'host-only');

    const result = await runGhCommand({ binPath: process.execPath, args: inspectEnvironment });

    expect(result.ok).toBe(true);
    expect(JSON.parse(result.stdout)).toEqual({ token: 'host-token', hostOnly: 'host-only' });
  });
});
