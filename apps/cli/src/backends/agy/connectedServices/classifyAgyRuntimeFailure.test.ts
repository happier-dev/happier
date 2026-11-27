import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildUsageLimitIssueFingerprint, type SessionRuntimeIssueV1 } from '@happier-dev/protocol';
import { createSessionTurnLifecycle } from '@/agent/runtime/session/turn/lifecycle';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { createTestAcpRuntime } from '@/testkit/backends/acpRuntime';
import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createBasicSessionClientWithOverrides } from '@/testkit/backends/sessionFixtures';
import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { resetConnectedServiceRuntimeAuthFailureReportDedupeForTests } from '@/daemon/connectedServices/runtimeAuth/reportConnectedServiceRuntimeAuthFailureToDaemon';
import { agent } from '../index';
import { createAgyConnectedServiceRuntimeAuthAdapter } from './createAgyConnectedServiceRuntimeAuthAdapter';
import { classifyAgyAssistantTurnFailure } from './classifyAgyRuntimeFailure';

const daemonBoundary = vi.hoisted(() => ({ notify: vi.fn(), outboxRoot: '' }));
vi.mock('@/daemon/controlClient', () => ({ notifyDaemonConnectedServiceRuntimeAuthFailure: daemonBoundary.notify }));
// Keep daemon transport and its filesystem outbox scoped to disposable test boundaries.
vi.mock('@/configuration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configuration')>();
  return { ...actual, configuration: Object.create(actual.configuration, { activeServerDir: { get: () => daemonBoundary.outboxRoot } }) };
});
afterEach(() => { vi.restoreAllMocks(); resetConnectedServiceRuntimeAuthFailureReportDedupeForTests(); daemonBoundary.notify.mockReset(); });

// Observed `agy acp` 1.5.18 rendering of a failed turn: one assistant chunk, then stopReason end_turn.
const OBSERVED_API_KEY_FAILURE = '\n⚠ agent executor error: generating and executing: Error 400, Message: API key not valid. Please pass a valid API key., Status: INVALID_ARGUMENT, Details: [map[@type:type.googleapis.com/google.rpc.ErrorInfo domain:googleapis.com metadata:map[service:generativelanguage.googleapis.com] reason:API_KEY_INVALID]]\n';
const QUOTA_FAILURE = '\n⚠ agent executor error: You have exhausted your quota on this model.\n';
const selection = { serviceId: 'antigravity', profileId: 'selected-profile', groupId: 'selected-pool', generation: 7 };

function classify(error: unknown) {
  return createAgyConnectedServiceRuntimeAuthAdapter().classifyRuntimeAuthFailure({ target: { agentId: 'agy' }, error, selection });
}

describe('Antigravity native turn-failure classification', () => {
  it.each([
    ['You have exhausted your quota on this model.', { kind: 'usage_limit', limitCategory: 'usage_limit' }],
    ['Error 429, Message: Resource has been exhausted (e.g. check quota)., Status: RESOURCE_EXHAUSTED', { kind: 'usage_limit', limitCategory: 'usage_limit' }],
    ["Your organization's prepaid balance is insufficient. Contact your administrator to add funds.", { kind: 'plan', limitCategory: 'plan_invalid' }],
    ['Verification required. Please complete verification in your browser to continue. https://accounts.google.com/verify?x=1', { kind: 'validation', action: { kind: 'open_url', url: 'https://accounts.google.com/verify?x=1' } }],
    ['Your account is blocked due to a Terms of Service violation. Submit an appeal: https://support.google.com/appeal.', { kind: 'account_disabled', action: { kind: 'open_url', url: 'https://support.google.com/appeal' } }],
    [OBSERVED_API_KEY_FAILURE, { kind: 'auth_expired', limitCategory: 'auth_invalid' }],
  ])('classifies %j with the selected account tuple', (message, expected) => {
    expect(classify(new Error(message))).toMatchObject({
      ...expected, serviceId: 'antigravity', profileId: 'selected-profile', groupId: 'selected-pool', groupGeneration: 7,
    });
  });

  it('classifies the observed individual-quota message as a usage limit with its reset time', () => {
    // Observed live (agy acp, 2026-11-27): the final assistant line of a turn that ended with end_turn.
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const classification = classify(new Error('Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 142h7m6s.'));
    expect(classification).toMatchObject({
      kind: 'usage_limit', limitCategory: 'usage_limit', serviceId: 'antigravity', profileId: 'selected-profile', groupId: 'selected-pool',
      resetsAtMs: 1_000_000 + ((142 * 60 + 7) * 60 + 6) * 1000,
    });
  });

  it('fails the turn on the bare verification line agy acp prints without a link', () => {
    // Observed live (agy acp 1.5.x, 2026-11-27, new account): the whole turn reply was "\n⚠ Verification required\n".
    const failure = classifyAgyAssistantTurnFailure({ text: '\n⚠ Verification required\n', processEnv: {} });
    expect((failure as { runtimeAuthClassification?: unknown } | null)?.runtimeAuthClassification).toMatchObject({
      kind: 'validation', limitCategory: 'validation_failed', serviceId: 'antigravity',
    });
  });

  it('keeps unrelated provider errors unclassified', () => {
    expect(classify(new Error('failed to construct executor: plan model not specified; you must specify a valid model'))).toBeNull();
  });

  it('surfaces the appeal link of a Terms of Service block as the issue action', () => {
    const classification = classify('Your account is blocked due to a Terms of Service violation. https://support.google.com/appeal');
    const issue = classifyPrimarySessionRuntimeIssue({ provider: 'agy', cause: 'session_error', error: { runtimeAuthClassification: classification }, occurredAt: 1 });
    expect(issue).toMatchObject({ source: 'provider_status_error', usageLimit: { action: { kind: 'open_url', url: 'https://support.google.com/appeal' } } });
  });

  it('fails the turn on a native failure chunk and reports the selected account to daemon recovery', async () => {
    const outboxRoot = await mkdtemp(join(tmpdir(), 'agy-runtime-recovery-'));
    daemonBoundary.outboxRoot = outboxRoot;
    const reports: unknown[] = [];
    const sent: unknown[] = [];
    const failedIssues: SessionRuntimeIssueV1[] = [];
    const lifecycle = createSessionTurnLifecycle({ sessionId: 'agy-selected-recovery', enqueueSessionTurn: async (mutation) => {
      if (mutation.action === 'fail' && mutation.issue) failedIssues.push(mutation.issue);
    } });
    daemonBoundary.notify.mockImplementation(async (body: unknown) => {
      reports.push(body);
      return { ok: true, result: { status: 'recovery_superseded', reason: 'source_tuple_mismatch', serviceId: 'antigravity' } };
    });
    const backend = createFakeAcpRuntimeBackend();
    const runtime = createTestAcpRuntime({ provider: 'agy', directory: '/tmp', happierSessionId: 'agy-selected-recovery',
      processEnv: { HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{ kind: 'group', serviceId: 'antigravity', groupId: 'selected-pool', activeProfileId: 'selected-profile', fallbackProfileId: 'fallback', generation: 7, credentialRevision: 'csr_abcdefghijklmnopqrstuv' }]) },
      session: createBasicSessionClientWithOverrides({ sessionTurnLifecycle: lifecycle, sendAgentMessage: (provider, body) => { sent.push(body); void lifecycle.observeAcpLifecycleMarker({ provider, body }).pendingWrite; } }),
      messageBuffer: new MessageBuffer(), mcpServers: {}, permissionHandler: createApprovedPermissionHandler(), onThinkingChange: () => {}, ensureBackend: async () => backend,
      hooks: await agent.getAcpRuntimeTurnHooks?.() });
    try {
      await runtime.startOrLoad({ resumeId: null });
      runtime.beginTurn();
      backend.emit({ type: 'model-output', textDelta: 'I will inspect the repository.' });
      backend.emit({ type: 'model-output', textDelta: QUOTA_FAILURE });
      const error = await runtime.sendPrompt('continue').then(() => null, (failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      await runtime.failTurn(error);
      await runtime.flushTurn();
      await expect.poll(() => reports.length).toBe(1);
      expect(reports[0]).toMatchObject({ sessionId: 'agy-selected-recovery', classification: {
        kind: 'usage_limit', serviceId: 'antigravity', profileId: 'selected-profile', groupId: 'selected-pool', groupGeneration: 7,
        credentialRevision: 'csr_abcdefghijklmnopqrstuv',
        runtimeIssueFingerprint: buildUsageLimitIssueFingerprint(failedIssues[0]!),
      } });
      expect(sent).toContainEqual(expect.objectContaining({ type: 'turn_failed', issue: expect.objectContaining({ source: 'usage_limit' }) }));
    } finally {
      await runtime.reset();
      await rm(outboxRoot, { recursive: true, force: true });
    }
  });

  it.each([
    ['a quoted quota message', 'The CLI says: You have exhausted your quota on this model.'],
    ['a warning sign followed by more answer text', '⚠ You have exhausted your quota on this model.\nHere is how to fix the code.'],
    ['an unrelated failure chunk', '\n⚠ failed to construct executor: plan model not specified; you must specify a valid model\n'],
  ])('completes an ordinary turn for %s', async (_label, text) => {
    const backend = createFakeAcpRuntimeBackend();
    const runtime = createTestAcpRuntime({ provider: 'agy', directory: '/tmp', session: createBasicSessionClientWithOverrides(),
      messageBuffer: new MessageBuffer(), mcpServers: {}, permissionHandler: createApprovedPermissionHandler(), onThinkingChange: () => {}, ensureBackend: async () => backend,
      hooks: await agent.getAcpRuntimeTurnHooks?.() });
    await runtime.startOrLoad({ resumeId: null });
    runtime.beginTurn();
    backend.emit({ type: 'model-output', textDelta: text });
    await expect(runtime.sendPrompt('explain')).resolves.toBeUndefined();
    await runtime.flushTurn();
  });
});
