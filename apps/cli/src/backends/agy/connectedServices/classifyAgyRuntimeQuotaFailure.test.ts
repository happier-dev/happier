import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildUsageLimitIssueFingerprint, type SessionRuntimeIssueV1 } from '@happier-dev/protocol';
import { createSessionTurnLifecycle } from '@/agent/runtime/session/turn/lifecycle';
import { AGENTS_CORE } from '@happier-dev/agents';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { createTestAcpRuntime } from '@/testkit/backends/acpRuntime';
import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createBasicSessionClientWithOverrides } from '@/testkit/backends/sessionFixtures';
import { classifyAgyAssistantTurnFailure, classifyAgyRuntimeQuotaFailure } from './classifyAgyRuntimeQuotaFailure';
import { getSessionUsageLimitRecoveryControlAdapter } from '@/backends/catalog';
import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { agent } from '../index';
import { resetConnectedServiceRuntimeAuthFailureReportDedupeForTests } from '@/daemon/connectedServices/runtimeAuth/reportConnectedServiceRuntimeAuthFailureToDaemon';

const daemonBoundary = vi.hoisted(() => ({ notify: vi.fn(), outboxRoot: '' }));
vi.mock('@/daemon/controlClient', () => ({ notifyDaemonConnectedServiceRuntimeAuthFailure: daemonBoundary.notify }));
// Keep daemon transport and its filesystem outbox scoped to disposable test boundaries.
vi.mock('@/configuration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configuration')>();
  return { ...actual, configuration: Object.create(actual.configuration, { activeServerDir: { get: () => daemonBoundary.outboxRoot } }) };
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); resetConnectedServiceRuntimeAuthFailureReportDedupeForTests(); daemonBoundary.notify.mockReset(); });

const diagnostic = 'Usage Limit Reached\n\nYou have reached your current quota for this period.';
describe('Antigravity ACP quota diagnostic admission', () => {
  it('settles the failed turn and reports its exact selected pool tuple to daemon recovery', async () => {
    const outboxRoot = await mkdtemp(join(tmpdir(), 'agy-runtime-recovery-'));
    daemonBoundary.outboxRoot = outboxRoot;
    const reports: unknown[] = [];
    const sent: unknown[] = [];
    const failedIssues: SessionRuntimeIssueV1[] = [];
    const lifecycle = createSessionTurnLifecycle({ sessionId: 'agy-selected-recovery', enqueueSessionTurn: async (mutation) => {
      if (mutation.action === 'fail' && mutation.issue) failedIssues.push(mutation.issue);
    } });
    daemonBoundary.notify.mockImplementation(async (body: unknown) => {
      expect(failedIssues.length).toBeGreaterThan(0);
      reports.push(body);
      return { ok: true, result: { status: 'recovery_superseded', reason: 'source_tuple_mismatch', serviceId: 'antigravity' } };
    });
    const backend = createFakeAcpRuntimeBackend();
    const runtime = createTestAcpRuntime({ provider: 'agy', directory: '/tmp', happierSessionId: 'agy-selected-recovery',
      processEnv: { HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{ kind: 'group', serviceId: 'antigravity', groupId: 'selected-pool', activeProfileId: 'selected-profile', fallbackProfileId: 'fallback', generation: 7, credentialRevision: 'csr_abcdefghijklmnopqrstuv' }]) },
      session: createBasicSessionClientWithOverrides({ sessionTurnLifecycle: lifecycle, sendAgentMessage: (provider, body) => { sent.push(body); void lifecycle.observeAcpLifecycleMarker({ provider, body }).pendingWrite; } }),
      messageBuffer: new MessageBuffer(), mcpServers: {}, permissionHandler: createApprovedPermissionHandler(), onThinkingChange: () => {}, ensureBackend: async () => backend,
      hooks: await agent.getAcpRuntimeTurnHooks() });
    try {
      await runtime.startOrLoad({ resumeId: null });
      for (let occurrence = 0; occurrence < 2; occurrence += 1) {
        runtime.beginTurn();
        backend.emit({ type: 'model-output', textDelta: diagnostic });
        const error = await runtime.sendPrompt('continue').then(() => null, (error: unknown) => error);
        await runtime.failTurn(error);
        await runtime.flushTurn();
      }
      await expect.poll(() => reports.length).toBe(2);
      expect(reports.map((report) => (report as { classification: { runtimeIssueFingerprint?: string } }).classification.runtimeIssueFingerprint).sort())
        .toEqual(failedIssues.map((issue) => buildUsageLimitIssueFingerprint(issue)).sort());
      expect(reports).toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: 'agy-selected-recovery', classification: expect.objectContaining({ serviceId: 'antigravity', profileId: 'selected-profile', groupId: 'selected-pool', groupGeneration: 7, credentialRevision: 'csr_abcdefghijklmnopqrstuv' }) })]));
      expect(sent).toContainEqual(expect.objectContaining({ type: 'turn_failed', issue: expect.objectContaining({ usageLimit: expect.objectContaining({ connectedService: expect.objectContaining({ profileId: 'selected-profile', groupId: 'selected-pool' }) }) }) }));
    } finally {
      await runtime.reset();
      await rm(outboxRoot, { recursive: true, force: true });
    }
  });
  it('exposes recovery controls for the provider whose registered adapter handles the diagnostic', async () => {
    expect(AGENTS_CORE.agy.sessionCapabilities.usageLimitRecovery?.checkNow).toBe('supported');
    expect(await getSessionUsageLimitRecoveryControlAdapter('agy')).not.toBeNull();
  });
  it('admits the exact 1.3.0 diagnostic and preserves selected account provenance', () => {
    expect(classifyAgyRuntimeQuotaFailure({ target: { agentId: 'agy' }, error: new Error(diagnostic), selection: { serviceId: 'antigravity', profileId: 'selected', groupId: 'pool', generation: 4 } })).toMatchObject({ kind: 'usage_limit', serviceId: 'antigravity', profileId: 'selected', groupId: 'pool', source: 'stable_provider_message', resetsAtMs: null });
  });
  it.each(['The diagnostic says: '+diagnostic, '```\n'+diagnostic+'\n```', '> '+diagnostic, 'Usage Limit Reached is a phrase we should handle.', 'I cannot help with that request.', diagnostic+' Here is how to fix the code.'])('ignores ordinary discussion or refusal: %s', text => {
    expect(classifyAgyAssistantTurnFailure({ text })).toBeNull();
  });
  it.each(['none', 'tool', 'text'] as const)('admits the terminal diagnostic and retains prior output (prior segment: %s)', async priorSegment => {
    const backend = createFakeAcpRuntimeBackend();
    const sent: unknown[] = [];
    const committed: unknown[] = [];
    const runtime = createTestAcpRuntime({ provider: 'agy', directory: '/tmp', session: createBasicSessionClientWithOverrides({
      sendAgentMessage: (_provider, body) => { sent.push(body); },
      sendAgentMessageCommitted: async (_provider, body) => { committed.push(body); },
    }), messageBuffer: new MessageBuffer(), mcpServers: {}, permissionHandler: createApprovedPermissionHandler(), onThinkingChange: () => {}, ensureBackend: async () => backend,
      hooks: { classifyAssistantTurnFailure: classifyAgyAssistantTurnFailure } });
    await runtime.startOrLoad({ resumeId: null });
    runtime.beginTurn();
    if (priorSegment !== 'none') {
      backend.emit({ type: 'model-output', textDelta: 'I will inspect the repository.' });
    }
    if (priorSegment === 'tool') {
      backend.emit({ type: 'tool-call', toolName: 'read_file', args: { path: '/repo/file' }, callId: 'prior-tool' });
      backend.emit({ type: 'tool-result', toolName: 'read_file', result: 'contents', callId: 'prior-tool' });
    }
    if (priorSegment === 'text') {
      // server.py emits the complete quota diagnostic in one error-reporting chunk.
      backend.emit({ type: 'model-output', textDelta: diagnostic });
    } else {
      backend.emit({ type: 'model-output', textDelta: 'Usage Limit Rea' });
      backend.emit({ type: 'model-output', textDelta: diagnostic.slice('Usage Limit Rea'.length) });
    }
    const error = await runtime.sendPrompt('continue').then(() => null, (error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    await runtime.failTurn(error);
    await runtime.flushTurn();
    expect(JSON.stringify(committed)).toContain('Usage Limit Reached');
    expect(sent).toContainEqual(expect.objectContaining({ type: 'turn_failed', issue: expect.objectContaining({ source: 'usage_limit' }) }));
    expect(sent).not.toContainEqual(expect.objectContaining({ type: 'task_complete' }));
  });
  it.each(['completed', 'refused'] as const)('keeps ordinary %s completion and user quota quotations out of recovery', async kind => {
    const backend = createFakeAcpRuntimeBackend({ waitForResponseComplete: async () => kind === 'completed'
      ? { kind: 'completed', stopReason: 'end_turn' }
      : { kind: 'refused', stopReason: 'refusal' } });
    const runtime = createTestAcpRuntime({ provider: 'agy', directory: '/tmp', session: createBasicSessionClientWithOverrides(),
      messageBuffer: new MessageBuffer(), mcpServers: {}, permissionHandler: createApprovedPermissionHandler(), onThinkingChange: () => {}, ensureBackend: async () => backend,
      hooks: { classifyAssistantTurnFailure: classifyAgyAssistantTurnFailure } });
    await runtime.startOrLoad({ resumeId: null });
    runtime.beginTurn();
    backend.emit({ type: 'event', name: 'user_message_chunk', payload: { text: diagnostic } });
    backend.emit({ type: 'model-output', textDelta: 'I can explain quota limits.' });
    await expect(runtime.sendPrompt('explain')).resolves.toBeUndefined();
    await runtime.flushTurn();
  });
  it('routes admitted quota evidence through the registered recovery adapter with the selected group', async () => {
    const adapter = await getSessionUsageLimitRecoveryControlAdapter('agy');
    const classification = classifyAgyRuntimeQuotaFailure({ target: { agentId: 'agy' }, error: diagnostic, selection: { groupId: 'selected-pool', profileId: 'selected-profile' } });
    const issue = classifyPrimarySessionRuntimeIssue({ provider: 'agy', cause: 'session_error', error: { runtimeAuthClassification: classification }, occurredAt: 1000 });
    const rawSession: RawSessionRecord = { id: 'agy-recovery', seq: 1, createdAt: 1000, updatedAt: 1000, active: false, activeAt: 1000,
      agentState: null, agentStateVersion: 1, dataEncryptionKey: null, path: '/repo', machineId: 'machine', metadata: '{}', metadataVersion: 1,
      encryptionMode: 'plain', latestTurnStatus: 'failed', lastRuntimeIssue: issue };
    const result = await adapter?.checkNow?.({ token: 'test-token', sessionId: rawSession.id, rawSession, metadata: {}, currentMachineId: 'machine', sessionMachineId: 'machine', cwd: '/repo', ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' }, mode: 'plain' });
    expect(result).toMatchObject({ ok: true, metadata: { sessionUsageLimitRecoveryV1: { maxAttempts: 3, selectedAuth: { kind: 'group', serviceId: 'antigravity', groupId: 'selected-pool', profileId: 'selected-profile' } } } });
  });
});
