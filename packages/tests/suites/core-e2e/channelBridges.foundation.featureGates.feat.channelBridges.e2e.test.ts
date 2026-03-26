import { afterEach, describe, expect, it } from 'vitest';

import { createRunDirs } from '../../src/testkit/runDir';
import { fetchJson } from '../../src/testkit/http';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: channel bridges foundation', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('advertises channel bridge gates as disabled when the server env gate is disabled', async () => {
    const testDir = run.testDir('feature-negotiation-channel-bridges-disabled');
    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_FEATURE_CHANNEL_BRIDGES__ENABLED: '0',
      },
    });

    const features = await fetchJson<any>(`${server.baseUrl}/v1/features`);
    expect(features.status).toBe(200);
    expect(features.data?.features?.channelBridges?.enabled).toBe(false);
    expect(features.data?.features?.channelBridges?.telegram?.enabled).toBe(false);
  }, 180_000);

  it('advertises channel bridge gates as enabled by default', async () => {
    const testDir = run.testDir('feature-negotiation-channel-bridges-enabled');
    server = await startServerLight({ testDir, dbProvider: 'sqlite' });

    const features = await fetchJson<any>(`${server.baseUrl}/v1/features`);
    expect(features.status).toBe(200);
    expect(features.data?.features?.channelBridges?.enabled).toBe(true);
    expect(features.data?.features?.channelBridges?.telegram?.enabled).toBe(true);
  }, 180_000);
});
