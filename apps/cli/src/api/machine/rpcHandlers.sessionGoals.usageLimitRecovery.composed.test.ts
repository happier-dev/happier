import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import { expect, it, onTestFinished, vi } from 'vitest';
import { FeaturesResponseSchema, type SessionRuntimeIssueV1, type SessionUsageLimitRecoveryV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { buildUsageLimitIssueFingerprint } from '@happier-dev/protocol/sessions/state/valueSchemas/usageLimitRecovery';

import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { applyRegisteredSessionStateFieldMutationToMetadata } from '@/api/session/client/transport/mutations/applyRegisteredSessionStateFieldMutation';
import { createRecoveryIntentFileStore } from '@/daemon/connectedServices/recoveryScheduler/recoveryIntentFileStore';
import { createInactiveUsageLimitRecoveryCheckOwner } from '@/daemon/connectedServices/usageLimitRecovery/inactiveUsageLimitRecoveryCheckOwner';
import { resolveInactiveUsageLimitRecoverySchedulerResult } from '@/daemon/connectedServices/usageLimitRecovery/resolveInactiveUsageLimitRecoverySchedulerResult';
import { UsageLimitRecoveryScheduler } from '@/daemon/connectedServices/usageLimitRecovery/UsageLimitRecoveryScheduler';
import { buildRecoveryIntentFromUsageLimitIssue } from '@/session/usageLimitRecoveryControls/buildUsageLimitRecoveryIntent';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { installAxiosRequestMethodAdapter } from '@/testkit/http/axiosAdapter';

import { registerMachineSessionGoalRpcHandlers } from './rpcHandlers.sessionGoals';

it.each(['freshly armed', 'restored'])('settles %s inactive Machine checks through a public timing update and exact cancellation', async (entry) => {
  const sessionId = 'c123456789012345678901234';
  const machineId = 'machine-1';
  const credentials = { token: 'fixture-token', encryption: null } as const;
  const nowMs = 1_000;
  const resetAtMs = 60_000;
  const issue = {
    v: 1, scope: 'primary_session', status: 'failed', source: 'usage_limit', code: 'usage_limit',
    agentId: 'claude', agentTurnId: 'interrupted-turn', occurredAt: 100,
    usageLimit: { v: 1, resetAtMs: null, retryAfterMs: null, quotaScope: 'account', recoverability: 'wait' },
  } satisfies SessionRuntimeIssueV1;
  const issueFingerprint = buildUsageLimitIssueFingerprint(issue);
  const directory = await mkdtemp(join(tmpdir(), 'happier-inactive-usage-check-'));
  const store = createRecoveryIntentFileStore<SessionUsageLimitRecoveryV1>(join(directory, 'recovery.json'));
  const owner = createInactiveUsageLimitRecoveryCheckOwner();
  const scheduler = new UsageLimitRecoveryScheduler({
    nowMs: () => nowMs,
    store,
    recover: async (_intent, context) => resolveInactiveUsageLimitRecoverySchedulerResult({
      result: await owner.run(context.sessionId),
    }),
  });
  const holdBoundary = () => {
    const read = { started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
    onTestFinished(() => { read.release.resolve(); });
    return read;
  };
  onTestFinished(async () => {
    scheduler.dispose();
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });
  vi.spyOn(Date, 'now').mockReturnValue(nowMs);

  let holdNextCredentials: ReturnType<typeof holdBoundary> | null = null;
  let holdNextWrite: ReturnType<typeof holdBoundary> | null = null;
  let metadata = createTestMetadata({ machineId, flavor: 'claude' });
  const createSessionRow = () => createSessionRecordFixture({
    id: sessionId, encryptionMode: 'plain', latestTurnId: 'interrupted-turn', latestTurnStatus: 'failed',
    lastRuntimeIssue: issue, metadata: JSON.stringify(metadata),
  });
  vi.spyOn(axios, 'get').mockImplementation(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') {
      return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
    }
    if (path !== `/v2/sessions/${sessionId}`) throw new Error(`Unexpected Home read: ${path}`);
    return { status: 200, data: { session: createSessionRow() } };
  });
  installAxiosRequestMethodAdapter();

  const machine = new RpcHandlerManager({ scopePrefix: machineId, encryptionMode: 'plain', logger: () => {} });
  const { probeInactiveUsageLimitRecovery } = registerMachineSessionGoalRpcHandlers({
    rpcHandlerManager: machine,
    deps: {
      currentMachineId: machineId,
      readStoredCredentials: async () => {
        const read = holdNextCredentials;
        holdNextCredentials = null;
        if (read) {
          read.started.resolve();
          await read.release.promise;
        }
        return credentials;
      },
      isUsageLimitRecoveryEnabled: () => true,
      stageUsageLimitRecoveryMutation: async ({ mutation, rawSession }) => {
        const write = holdNextWrite;
        holdNextWrite = null;
        if (write) {
          write.started.resolve();
          await write.release.promise;
        }
        const base = tryDecryptSessionOwnerMetadataView({ credentials, accountEncryptionMode: 'plain', rawSession });
        metadata = applyRegisteredSessionStateFieldMutationToMetadata(metadata, mutation, base ?? undefined);
      },
      scheduleInactiveSessionUsageLimitRecoveryCheck: (input) => owner.schedule({ ...input, scheduler }),
      readInactiveSessionUsageLimitRecovery: ({ sessionId }) => scheduler.read(sessionId),
      cancelInactiveSessionUsageLimitRecoveryCheck: async (input) => {
        await owner.cancelExact({ ...input, scheduler });
      },
    },
  });

  if (entry === 'restored') {
    const recovery = buildRecoveryIntentFromUsageLimitIssue({ issue, resumePromptMode: 'off' });
    if (!recovery) throw new Error('Expected an observed usage-limit issue');
    metadata = { ...metadata, sessionUsageLimitRecoveryV1: recovery };
    const features = FeaturesResponseSchema.parse({
      features: { sessions: { enabled: true, usageLimitRecovery: { enabled: true } } }, capabilities: {},
    });
    await owner.restoreSessions({
      credentials, machineId, scheduler, sessions: [createSessionRow()],
      currentMachineHost: metadata.host, currentMachineHomeDir: metadata.homeDir ?? tmpdir(),
      isCurrent: () => true, getServerFeaturesSnapshot: () => ({ status: 'ready', features }),
      runCheckNow: probeInactiveUsageLimitRecovery,
    });
  } else {
    await expect(machine.invokeLocal(RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE, {
      sessionId, issueFingerprint, resumePromptMode: 'off',
    })).resolves.toMatchObject({ ok: true, status: 'waiting' });
  }
  const armed = scheduler.read(sessionId);
  expect(armed).toMatchObject({ status: 'waiting', issueFingerprint, resetAtMs: null });
  if (!armed) throw new Error('Expected an armed recovery');
  await expect(scheduler.checkNow({ sessionId })).resolves.toEqual({ status: 'waiting' });

  // Home can observe more precise reset timing while the earlier daemon check is held at custody.
  metadata = { ...metadata, sessionUsageLimitRecoveryV1: { ...armed, status: 'armed' } };
  const oldWrite = holdNextWrite = holdBoundary();
  const olderCheck = scheduler.checkNow({ sessionId });
  try {
    await expect(Promise.race([
      oldWrite.started.promise.then(() => ({ status: 'persisting' })), olderCheck,
    ])).resolves.toEqual({ status: 'persisting' });
    metadata = { ...metadata, sessionUsageLimitRecoveryV1: { ...armed, resetAtMs, nextCheckAtMs: resetAtMs } };
    await expect(machine.invokeLocal(RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW, { sessionId })).resolves.toMatchObject({
      ok: true, status: 'waiting',
    });
  } finally {
    oldWrite.release.resolve();
    await olderCheck;
  }
  await expect(olderCheck).resolves.toEqual({ status: 'inactive' });
  expect(store.readAuthoritative(sessionId)).toMatchObject({ status: 'waiting', resetAtMs, nextCheckAtMs: resetAtMs });
  expect(metadata.sessionUsageLimitRecoveryV1).toMatchObject({ status: 'waiting', resetAtMs, nextCheckAtMs: resetAtMs });

  const nextRead = holdNextCredentials = holdBoundary();
  const nextCheck = scheduler.checkNow({ sessionId });
  try {
    await expect(Promise.race([
      nextRead.started.promise.then(() => ({ status: 'probing' })), nextCheck,
    ])).resolves.toEqual({ status: 'probing' });
    expect(store.readAuthoritative(sessionId)).toMatchObject({ status: 'checking' });
    await expect(machine.invokeLocal(RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL, {
      sessionId, issueFingerprint, armedAtMs: armed.armedAtMs,
    })).resolves.toMatchObject({ ok: true, status: 'cancelled' });
  } finally {
    nextRead.release.resolve();
    await nextCheck;
  }
  await expect(nextCheck).resolves.toEqual({ status: 'inactive' });
  expect(store.readAuthoritative(sessionId)).toMatchObject({ status: 'cancelled', nextCheckAtMs: null });
  expect(metadata.sessionUsageLimitRecoveryV1).toMatchObject({ status: 'cancelled', armedAtMs: armed.armedAtMs });
  expect(owner.hasRunner(sessionId)).toBe(false);
});
