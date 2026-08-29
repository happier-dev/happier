import { afterEach, describe, expect, it } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  AutomationDefinitionDetailSchema,
  AutomationV3RunListResponseSchema,
  buildAccountStoredContentCompatibilityHttpHeadersV1,
  CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
  type AutomationV3RunListItem,
} from '@happier-dev/protocol';

import { createRunDirs } from '../../src/testkit/runDir';
import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { fakeClaudeFixturePath, waitForFakeClaudeUserText } from '../../src/testkit/fakeClaude';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });

type SessionMessagesResponse = Readonly<{
  messages: ReadonlyArray<Readonly<{
    localId: string | null;
    content: unknown;
  }>>;
}>;

async function requestJson<T>(params: {
  baseUrl: string;
  token: string;
  path: string;
  method?: 'GET' | 'POST';
  body?: unknown;
}): Promise<T> {
  const hasBody = params.body !== undefined;
  const response = await fetch(`${params.baseUrl}${params.path}`, {
    method: params.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${params.token}`,
      ...buildAccountStoredContentCompatibilityHttpHeadersV1(
        CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
      ),
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(hasBody ? { body: JSON.stringify(params.body) } : {}),
  });

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) ${params.path}: ${JSON.stringify(payload)}`);
  }
  return payload as T;
}

describe('core e2e: schedule trigger fan-out through the loaded server and daemon', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;

  afterEach(async () => {
    await daemon?.stop().catch(() => {});
    daemon = null;
    await server?.stop().catch(() => {});
    server = null;
  });

  it('fires two authored schedule triggers independently and executes each through the daemon into Session custody', async () => {
    const testDir = run.testDir('automations-schedule-triggers-daemon-custody');
    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1',
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'plaintext_only',
      },
    });
    const auth = await createTestAuth(server.baseUrl);

    const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    const workspaceDir = resolve(join(testDir, 'workspace'));
    await mkdir(daemonHomeDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    const daemonAuth = await seedCliAuthForTestAccount({
      cliHome: daemonHomeDir,
      serverUrl: server.baseUrl,
      auth,
      mode: 'tokenOnly',
    });
    const fakeClaudePath = fakeClaudeFixturePath();
    const fakeClaudeLogPath = resolve(join(testDir, 'fake-claude.jsonl'));

    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: daemonHomeDir,
      // Materialize an isolated snapshot from the canonical dist built for
      // this moving-byte run. The shared snapshot may belong to another
      // concurrently moving lane and is intentionally not overwritten here.
      snapshotDir: resolve(join(testDir, 'cli-dist')),
      env: {
        ...process.env,
        CI: '1',
        HAPPIER_VARIANT: 'dev',
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_HOME_DIR: daemonHomeDir,
        HAPPIER_SERVER_URL: server.baseUrl,
        HAPPIER_WEBAPP_URL: server.baseUrl,
        HAPPIER_CLAUDE_PATH: fakeClaudePath,
        HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeClaudeLogPath,
        HAPPIER_E2E_FAKE_CLAUDE_LOG_FULL_STDIN: '1',
        HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
        HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1',
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'plaintext_only',
      },
    });

    await waitFor(async () => {
      const response = await requestJson<{ machine: { id: string } }>({
        baseUrl: server!.baseUrl,
        token: auth.token,
        path: `/v1/machines/${encodeURIComponent(daemonAuth.machineId)}`,
      });
      return response.machine.id === daemonAuth.machineId;
    }, { timeoutMs: 60_000, intervalMs: 100, context: 'Automation daemon machine registration' });

    // One Automation, three authored schedule triggers: two independently
    // enabled intervals and one disabled sibling that must never fire.
    const prompt = 'E2E_SCHEDULE_TRIGGER_FANOUT_PROMPT';
    const fastTriggerId = 'e2e-schedule-fanout-fast';
    const slowTriggerId = 'e2e-schedule-fanout-slow';
    const disabledTriggerId = 'e2e-schedule-fanout-disabled';
    const automationId = 'e2e-schedule-trigger-fanout';
    const created = AutomationDefinitionDetailSchema.parse(await requestJson<unknown>({
      baseUrl: server.baseUrl,
      token: auth.token,
      path: '/v3/automations',
      method: 'POST',
      body: {
        automationId,
        name: 'Schedule trigger fan-out',
        enabled: true,
        triggers: [
          {
            triggerId: fastTriggerId,
            trigger: {
              kind: 'schedule',
              enabled: true,
              schedule: { kind: 'interval', scheduleExpr: null, everyMs: 10_000, timezone: null },
            },
          },
          {
            triggerId: slowTriggerId,
            trigger: {
              kind: 'schedule',
              enabled: true,
              schedule: { kind: 'interval', scheduleExpr: null, everyMs: 12_000, timezone: null },
            },
          },
          {
            triggerId: disabledTriggerId,
            trigger: {
              kind: 'schedule',
              enabled: false,
              schedule: { kind: 'interval', scheduleExpr: null, everyMs: 10_000, timezone: null },
            },
          },
        ],
        executionRecipe: {
          v: 1,
          templateVersion: 1,
          template: { t: 'plain', v: { v: 1, prompt } },
          triggerEvidence: null,
          target: {
            kind: 'newSession',
            spawn: {
              executionTarget: {
                serverId: daemonAuth.serverId,
                machineId: daemonAuth.machineId,
              },
              directory: workspaceDir,
              agentTarget: {
                kind: 'agent',
                identity: {
                  pluginId: 'happier.agent.claude',
                  localId: 'claude',
                },
              },
            },
          },
        },
        assignments: [{ machineId: daemonAuth.machineId, enabled: true, priority: 1 }],
      },
    }));
    expect(created.id).toBe(automationId);
    expect(created.triggers.map((trigger) => trigger.id).sort()).toEqual(
      [fastTriggerId, slowTriggerId, disabledTriggerId].sort(),
    );

    // The loaded server's own schedule worker admits each due trigger; the
    // loaded daemon claims each Run and the newSession target gives each Run
    // its own produced Session.
    type SettledRuns = Readonly<{ fast: AutomationV3RunListItem; slow: AutomationV3RunListItem }>;
    let settled: SettledRuns | null = null;
    const byRunId = (a: AutomationV3RunListItem, b: AutomationV3RunListItem): number =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    await waitFor(async () => {
      const page = AutomationV3RunListResponseSchema.parse(await requestJson<unknown>({
        baseUrl: server!.baseUrl,
        token: auth.token,
        path: `/v3/automations/${encodeURIComponent(automationId)}/runs?limit=50`,
      }));
      // Explicit succeeded rows selected by stable Run identity, never the
      // API-order row that a newer queued occurrence could overwrite.
      const fast = page.runs
        .filter((runItem) => runItem.triggerId === fastTriggerId && runItem.state === 'succeeded')
        .sort(byRunId)[0];
      const slow = page.runs
        .filter((runItem) => runItem.triggerId === slowTriggerId && runItem.state === 'succeeded')
        .sort(byRunId)[0];
      if (
        fast === undefined
        || slow === undefined
        || fast.id === slow.id
        || typeof fast.producedSessionId !== 'string'
        || typeof slow.producedSessionId !== 'string'
        || fast.producedSessionId === slow.producedSessionId
      ) {
        return false;
      }
      // Recurring intervals: pause promptly inside the detection pass so
      // later occurrences cannot race the custody assertions below.
      AutomationDefinitionDetailSchema.parse(await requestJson<unknown>({
        baseUrl: server!.baseUrl,
        token: auth.token,
        path: `/v3/automations/${encodeURIComponent(automationId)}/pause`,
        method: 'POST',
      }));
      settled = { fast, slow };
      return true;
    }, { timeoutMs: 180_000, intervalMs: 250, context: 'Both schedule trigger Runs settled in their produced Sessions' });

    expect(settled).not.toBeNull();
    const { fast: fastRun, slow: slowRun } = settled as SettledRuns;
    expect(fastRun.id).not.toBe(slowRun.id);
    for (const [runItem, expectedTriggerId] of [
      [fastRun, fastTriggerId],
      [slowRun, slowTriggerId],
    ] as const) {
      expect(runItem.triggerId).toBe(expectedTriggerId);
      expect(runItem.cause).toMatchObject({
        kind: 'trigger',
        triggerId: expectedTriggerId,
        triggerKind: 'schedule',
      });
      expect(runItem.errorCode).toBeNull();
      expect(typeof runItem.producedSessionId).toBe('string');
    }

    // The disabled sibling admitted nothing, and both enabled triggers own
    // the succeeded Runs selected above. Overfired extra occurrences after
    // the pause decision are deliberately not asserted either way.
    const finalPage = AutomationV3RunListResponseSchema.parse(await requestJson<unknown>({
      baseUrl: server.baseUrl,
      token: auth.token,
      path: `/v3/automations/${encodeURIComponent(automationId)}/runs?limit=50`,
    }));
    expect(finalPage.runs.every((runItem) => runItem.triggerId !== disabledTriggerId)).toBe(true);
    expect(finalPage.runs.some((runItem) => runItem.id === fastRun.id && runItem.state === 'succeeded')).toBe(true);
    expect(finalPage.runs.some((runItem) => runItem.id === slowRun.id && runItem.state === 'succeeded')).toBe(true);

    // Result custody: each Run's deterministic input reached its produced
    // Session under that Run's identity. The fake-agent log is supplemental
    // execution evidence; the per-Run custody assertions below are decisive.
    const expectedCustody = [
      { run: fastRun, localId: `automation:run:${fastRun.id}` },
      { run: slowRun, localId: `automation:run:${slowRun.id}` },
    ] as const;
    await waitForFakeClaudeUserText(
      fakeClaudeLogPath,
      (text) => text.includes(prompt),
      { timeoutMs: 90_000, pollMs: 100 },
    );
    for (const { run: runItem, localId } of expectedCustody) {
      const producedSessionId = runItem.producedSessionId;
      if (typeof producedSessionId !== 'string') {
        throw new Error(`Missing produced Session for Automation Run ${runItem.id}`);
      }
      let messages: SessionMessagesResponse | null = null;
      await waitFor(async () => {
        messages = await requestJson<SessionMessagesResponse>({
          baseUrl: server!.baseUrl,
          token: auth.token,
          path: `/v1/sessions/${encodeURIComponent(producedSessionId)}/messages?limit=100`,
        });
        return messages.messages.some((message) => message.localId === localId);
      }, { timeoutMs: 90_000, intervalMs: 100, context: `Automation Session input ${localId} materialized` });

      const automationInput = messages?.messages.find((message) => message.localId === localId);
      expect(automationInput).toBeDefined();
      if (!automationInput) throw new Error(`Missing Automation Session input ${localId}`);
      expect(automationInput.content).toEqual(
        expect.objectContaining({
          t: 'plain',
          v: expect.objectContaining({
            role: 'user',
            content: expect.objectContaining({ type: 'text', text: prompt }),
          }),
        }),
      );
    }
  }, 600_000);
});
