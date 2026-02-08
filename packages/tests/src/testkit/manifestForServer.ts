import type { StartedServer } from './process/serverLight';

import { writeTestManifest, type TestManifest } from './manifest';

export function writeTestManifestForServer(params: {
  testDir: string;
  server: StartedServer;
  startedAt?: string;
  runId?: string;
  testName?: string;
  seed?: number;
  sessionIds?: string[];
  env?: TestManifest['env'];
}): string {
  const startedAt = params.startedAt ?? new Date().toISOString();
  return writeTestManifest(params.testDir, {
    startedAt,
    runId: params.runId,
    testName: params.testName,
    seed: params.seed,
    baseUrl: params.server.baseUrl,
    ports: { server: params.server.port },
    sessionIds: params.sessionIds,
    env: params.env,
  });
}

