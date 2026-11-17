import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { it } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { fetchJson } from '../../src/testkit/http';
import { createRunDirs } from '../../src/testkit/runDir';
import { startDatabaseWorkbenchPostgres } from '../../src/testkit/process/databaseWorkbenchPostgres';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';

it('prepares an opted-in PostgreSQL Home and serves its advertised canonical guest CLI archive', async () => {
  const run = createRunDirs({ runLabel: 'server-light-guest-payload' });
  const testDir = run.testDir('producer-to-home-http');
  const database = await startDatabaseWorkbenchPostgres({ preloadStatistics: false });
  let server: StartedServer | undefined;
  try {
    server = await startServerLight({ testDir: join(testDir, 'server'), dbProvider: 'postgres', extraEnv: {
      DATABASE_URL: database.homeDatabaseUrl,
      HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1',
      HAPPIER_DEV_GUEST_CLI_EXPORT: '1',
      // Preparation must obtain its metadata from the actual source producer.
      HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT: undefined,
      HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_METADATA: undefined,
    } });
    const features = await fetchJson<unknown>(`${server.baseUrl}/v1/features`);
    assert.equal(features.status, 200);
    const guestCli = FeaturesResponseSchema.parse(features.data).capabilities.guestCli;
    assert.equal(guestCli?.source, 'home-payload');
    assert.ok(guestCli?.payloads?.length, 'An opted-in prepared Home must advertise a producer-owned guest archive');
    for (const payload of guestCli.payloads) {
      const response: Response = await fetch(new URL(payload.url, server.baseUrl));
      assert.equal(response.status, 200, 'The advertised guest archive must be reachable through this Home');
      assert.ok(response.body);
      const digest = createHash('sha256');
      const reader = response.body.getReader();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        digest.update(chunk.value);
      }
      assert.equal(digest.digest('hex'), payload.sha256, 'The Home must serve the exact archive its producer advertised');
    }
  } finally {
    try { await server?.stop(); } finally { await database.stop(); }
  }
}, 0);
