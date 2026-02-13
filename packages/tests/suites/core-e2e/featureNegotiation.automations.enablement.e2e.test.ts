import { afterEach, describe, expect, it } from 'vitest';

import { createRunDirs } from '../../src/testkit/runDir';
import { fetchJson } from '../../src/testkit/http';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: feature negotiation automations enablement', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('removes automation routes when automations feature is disabled', async () => {
    const testDir = run.testDir('feature-negotiation-automations-disabled');
    server = await startServerLight({
      testDir,
      extraEnv: {
        HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '0',
      },
    });

    const features = await fetchJson<any>(`${server.baseUrl}/v1/features`);
    expect(features.status).toBe(200);
    expect(features.data?.features?.automations?.enabled).toBe(false);

    const automations = await fetchJson<any>(`${server.baseUrl}/v2/automations`);
    expect(automations.status).toBe(404);
  }, 180_000);

  it('keeps automation routes mounted when automations feature is enabled', async () => {
    const testDir = run.testDir('feature-negotiation-automations-enabled');
    server = await startServerLight({ testDir });

    const features = await fetchJson<any>(`${server.baseUrl}/v1/features`);
    expect(features.status).toBe(200);
    expect(features.data?.features?.automations?.enabled).toBe(true);

    const automations = await fetchJson<any>(`${server.baseUrl}/v2/automations`);
    expect(automations.status).not.toBe(404);
  }, 180_000);
});
