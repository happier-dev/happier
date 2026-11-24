import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SessionModelTransitionResultV1Schema } from '@happier-dev/protocol/sessions/control/modelTransitionV1';
import { resolveSessionComposerSendDestination } from '../../../../apps/ui/sources/sync/domains/session/input/resolveSessionComposerSendDestination';
import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { fakeClaudeEchoResponseText, fakeClaudeFixturePath, waitForFakeClaudeUserText } from '../../src/testkit/fakeClaude';
import { enqueuePendingQueueV2, listPendingQueueV2 } from '../../src/testkit/pendingQueueV2';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { readFakeClaudeRuntimeContinuityEvidence, releaseFakeClaudeRuntimeContinuityTurn, waitForFakeClaudeRuntimeContinuityEffect } from '../../src/testkit/providers/fakeClaudeContinuity';
import { callSessionScopedRpc, enqueueSessionPromptForScenario, waitForAssistantMessageContaining } from '../../src/testkit/providers/scenarios/sessionRuntime';
import { createRunDirs } from '../../src/testkit/runDir';
import { encryptDataKeyBase64 } from '../../src/testkit/rpcCrypto';
import { fetchSessionMetadataV2, readDecryptedSessionMetadataV2 } from '../../src/testkit/sessionHandoffMetadata';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: armed model busy Send → Queued → delivered', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;
  afterEach(async () => {
    try { await daemon?.stop(); } finally { await server?.stop(); }
    daemon = null;
    server = null;
  });

  it('keeps input queued during the active turn, then applies the armed model and delivers once', async () => {
    const testDir = run.testDir(`armed-model-busy-delivery-${randomUUID()}`);
    const daemonHomeDir = resolve(testDir, 'daemon-home');
    const workspaceDir = resolve(testDir, 'workspace');
    const releaseFilePath = resolve(testDir, 'release-active-turn');
    const logPath = resolve(testDir, 'fake-claude.jsonl');
    await Promise.all([mkdir(daemonHomeDir, { recursive: true }), mkdir(workspaceDir, { recursive: true })]);
    server = await startServerLight({ testDir, dbProvider: 'sqlite' });
    const baseUrl = server.baseUrl;
    const auth = await createTestAuth(baseUrl);
    await seedCliAuthForTestAccount({ cliHome: daemonHomeDir, serverUrl: baseUrl, auth, mode: 'legacy' });
    const env: NodeJS.ProcessEnv = {
      ...process.env, CI: '1', HAPPIER_VARIANT: 'dev', HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_HOME_DIR: daemonHomeDir, HAPPIER_SERVER_URL: baseUrl, HAPPIER_WEBAPP_URL: baseUrl,
      HAPPIER_CLAUDE_PATH: fakeClaudeFixturePath(), HAPPIER_E2E_FAKE_CLAUDE_LOG: logPath,
      HAPPIER_E2E_FAKE_CLAUDE_LOG_FULL_STDIN: '1', HAPPIER_E2E_FAKE_CLAUDE_SCENARIO: 'daemon-runtime-continuity',
      HAPPIER_E2E_FAKE_CLAUDE_RUNTIME_CONTINUITY_RELEASE_FILE: releaseFilePath,
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1', HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE: 'auto',
    };
    daemon = await startTestDaemon({ testDir, happyHomeDir: daemonHomeDir, env });
    const spawned = await daemonControlPostJson<{ success: boolean; sessionId?: string }>({
      port: daemon.state.httpPort, path: '/spawn-session', controlToken: daemon.state.controlToken,
      body: { directory: workspaceDir, terminal: { mode: 'plain' },
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, environmentVariables: env },
    });
    expect(spawned.data.success, JSON.stringify(spawned.data)).toBe(true);
    const sessionId = spawned.data.sessionId;
    if (!sessionId) throw new Error('Missing spawned Session');
    const sessionAccess = {
      baseUrl, token: auth.token, sessionId, machineKeys: [auth.accountMachineKey],
      accountEncryptionMaterials: [{ type: 'legacy', secret: auth.accountSigningSeed }] as const,
    };
    const sessionContent = await readDecryptedSessionMetadataV2(sessionAccess);
    if (!sessionContent.selectedSecret || !sessionContent.selectedUsesDataKeyVariant) {
      throw new Error('Expected the spawned Session to have its own content key');
    }
    const target = {
      baseUrl, token: auth.token, sessionId, secret: sessionContent.selectedSecret, encryptionVariant: 'dataKey' as const,
    };
    const hold = `DAEMON_RUNTIME_CONTINUITY_HOLD_${randomUUID()}`;
    await enqueueSessionPromptForScenario({ ...target, text: hold });
    await waitForFakeClaudeRuntimeContinuityEffect({ logPath, promptMarker: hold });

    const selection = { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: 'opus' };
    const armed = SessionModelTransitionResultV1Schema.parse(await callSessionScopedRpc({ ...target,
      method: SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION, payload: { v: 1, selection, applyTiming: 'next_prompt' } }));
    expect(armed).toMatchObject({ ok: true, status: 'armed', requestedSelection: selection });
    // This is the same destination owner reached by the mounted composer test.
    expect(resolveSessionComposerSendDestination({ route: 'sessionAgent', armedContinuation: null,
      armedContinuationLocalId: null, armedRoute: { turnActive: true, modelOnly: true }, hasMessage: true,
      machineId: 'spawned-machine', pendingTransitionOutcome: 'settled' })).toEqual({ kind: 'sessionAgent' });

    const localId = randomUUID();
    const text = `ARMED_MODEL_QUEUED_DELIVERED_${randomUUID()}`;
    const ciphertext = encryptDataKeyBase64({ role: 'user', content: { type: 'text', text }, localId,
      meta: { source: 'ui', sentFrom: 'e2e' } }, target.secret);
    const admitted = await enqueuePendingQueueV2({ baseUrl, token: auth.token, sessionId, localId, ciphertext,
      requestedAction: { v: 1, kind: 'enqueue' } });
    expect(admitted.status).toBe(200);
    const queued = await listPendingQueueV2({ baseUrl, token: auth.token, sessionId });
    expect(queued.data.pending).toEqual(expect.arrayContaining([expect.objectContaining({ localId, status: 'queued' })]));
    expect((await readFakeClaudeRuntimeContinuityEvidence(logPath)).userPromptPreviews.some(prompt => prompt.includes(text))).toBe(false);
    await releaseFakeClaudeRuntimeContinuityTurn(releaseFilePath);
    // Applying the armed model can resume Claude in a fresh process with its own turn counter.
    const deliveredPrompt = await waitForFakeClaudeUserText(logPath, prompt => prompt.includes(text));
    await waitForAssistantMessageContaining({
      ...target, requiredSubstring: fakeClaudeEchoResponseText(deliveredPrompt), timeoutMs: 120_000,
    });
    await waitFor(async () => (await listPendingQueueV2({ baseUrl, token: auth.token, sessionId })).data.pending?.length === 0,
      { timeoutMs: 60_000 });
    expect((await readFakeClaudeRuntimeContinuityEvidence(logPath)).userPromptPreviews.filter(prompt => prompt.includes(text))).toHaveLength(1);
    const metadata = await fetchSessionMetadataV2(sessionAccess);
    expect(metadata).toMatchObject({ sessionModelsV1: {
      currentModelId: selection.modelId, activeSelectionV1: { selection },
    } });
  });
});
