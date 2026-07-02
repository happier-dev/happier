import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import {
  readFakeCodexAppServerRequestLog,
  startCodexAppServerRemoteHarness,
  type StartedCodexAppServerRemoteHarness,
} from '../../src/testkit/codexAppServerRemoteHarness';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createRunDirs } from '../../src/testkit/runDir';
import { fetchSessionV2 } from '../../src/testkit/sessions';
import {
  enqueueSessionPromptForScenario,
  waitForAssistantMessageContaining,
  waitForSessionActive,
} from '../../src/testkit/providers/scenarios/sessionRuntime';
import { sleep, waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });

async function waitForFakeCodexTurnStart(requestLogPath: string): Promise<void> {
  await waitFor(async () => {
    const requests = await readFakeCodexAppServerRequestLog(requestLogPath);
    return requests.some((entry) => entry.method === 'turn/start');
  }, {
    timeoutMs: 45_000,
    intervalMs: 250,
    context: 'fake Codex app-server turn/start request',
  });
}

describe('core e2e: session turn reconnect', () => {
  let harness: StartedCodexAppServerRemoteHarness | null = null;
  let restartedServer: StartedServer | null = null;

  afterEach(async () => {
    await restartedServer?.stop().catch(() => {});
    restartedServer = null;
    await harness?.stop().catch(() => {});
    harness = null;
  });

  it('persists a terminal session turn mutation while server-light is unavailable and delivers it after reconnect', async () => {
    const testDir = run.testDir('session-turn-reconnect');
    harness = await startCodexAppServerRemoteHarness({
      testDir,
      runId: run.runId,
      testName: 'session-turn-reconnect',
      cliEnvOverrides: {
        HAPPIER_E2E_FAKE_CODEX_APP_SERVER_TURN_DELAY_MS: '2000',
      },
    });

    const { auth, requestLogPath, secret, server, serverBaseUrl, sessionId } = harness;
    await waitForSessionActive({ baseUrl: serverBaseUrl, token: auth.token, sessionId, timeoutMs: 30_000 });

    const prompt = `session-turn-reconnect-${randomUUID()}`;
    await enqueueSessionPromptForScenario({
      baseUrl: serverBaseUrl,
      token: auth.token,
      sessionId,
      secret,
      text: prompt,
      meta: { source: 'session-turn-reconnect-e2e' },
    });
    await waitForFakeCodexTurnStart(requestLogPath);

    await server.stop();
    await sleep(3_000);

    restartedServer = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      preserveExistingDataDir: true,
      extraEnv: {
        HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
      },
      __portAllocator: async () => server.port,
    });

    await waitForSessionActive({ baseUrl: serverBaseUrl, token: auth.token, sessionId, timeoutMs: 45_000 });
    await waitForAssistantMessageContaining({
      baseUrl: serverBaseUrl,
      token: auth.token,
      sessionId,
      secret,
      requiredSubstring: prompt,
      timeoutMs: 60_000,
    });

    await waitFor(async () => {
      const session = await fetchSessionV2(serverBaseUrl, auth.token, sessionId);
      return session.latestTurnStatus === 'completed';
    }, {
      timeoutMs: 60_000,
      intervalMs: 500,
      context: 'terminal session turn mutation after reconnect',
    });
  });
});
