import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import { FeaturesResponseSchema } from '@happier-dev/protocol';

import { fetchJson } from '../../src/testkit/http';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createRunDirs } from '../../src/testkit/runDir';

const run = createRunDirs({ runLabel: 'core' });

async function fetchServerIdentity(baseUrl: string): Promise<string> {
  const response = await fetchJson<unknown>(`${baseUrl}/v1/features`, { timeoutMs: 20_000 });
  expect(response.status).toBe(200);
  const payload = FeaturesResponseSchema.parse(response.data);
  expect(payload.capabilities.server).not.toHaveProperty('serverIdentityId');
  const serverIdentityId = payload.capabilities.serverIdentity.serverIdentityId;
  expect(typeof serverIdentityId).toBe('string');
  if (!serverIdentityId) throw new Error('Expected serverIdentityId');
  return serverIdentityId;
}

describe('core e2e: server identity stability', () => {
  let server: StartedServer | null = null;

  afterAll(async () => {
    await server?.stop().catch(() => {});
    server = null;
  }, 60_000);

  it('provides one compatibility-safe serverIdentityId across host aliases and restarts', async () => {
    const testDir = run.testDir(`server-identity-stability-${randomUUID()}`);
    server = await startServerLight({ testDir });

    const identityFromDefaultUrl = await fetchServerIdentity(server.baseUrl);

    const loopbackUrl = new URL(server.baseUrl);
    loopbackUrl.hostname = '127.0.0.1';
    const identityFromLoopbackAlias = await fetchServerIdentity(loopbackUrl.toString().replace(/\/$/, ''));
    expect(identityFromLoopbackAlias).toBe(identityFromDefaultUrl);

    await server.stop();
    server = await startServerLight({ testDir, preserveExistingDataDir: true });

    await expect(fetchServerIdentity(server.baseUrl)).resolves.toBe(identityFromDefaultUrl);
  }, 240_000);
});
