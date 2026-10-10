import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AccountSettingsSchema, ProviderBoundModelRefSchema, readBackendTargetRefV2, type ConnectedServiceBindingsV2 } from '@happier-dev/protocol';
import type { AgentRuntime, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';

import { VoiceAgentManager } from '@/agent/voice/agent/VoiceAgentManager';
import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import type { ExecutionRunManagerStartParams, ExecutionRunState } from './executionRunTypes';
import { ensureExecutionRun } from './ensureExecutionRun';
import { createNativeAgentSessionInteractionHostRuntime } from './nativeAgentExecutionRun';
import { createVoiceSessionContextLease } from './testkit/nativeSessionContext';
import { ExecutionRunHostBridge } from './ExecutionRunHostBridge';
import { reloadConfiguration } from '@/configuration';

describe('ExecutionRunHostBridge ensure-or-start response', () => {
    it('preserves the complete created response when the accepted Run stops during transcript publication', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'happier-ensure-start-response-'));
        vi.stubEnv('HAPPIER_HOME_DIR', directory);
        vi.stubEnv('HAPPIER_PUBLIC_RELEASE_CHANNEL', undefined);
        vi.stubEnv('HAPPIER_RELEASE_RING', undefined);
        vi.stubEnv('HAPPIER_RELEASE_CHANNEL', undefined);
        reloadConfiguration();
        let bridge!: ExecutionRunHostBridge;
        let publishedCallId: string | undefined;
        try {
            bridge = new ExecutionRunHostBridge({
                parentProvider: 'codex', cwd: directory, happyHomeDir: directory,
                // The Session transcript transport exposes creation before native
                // provisioning; a user can cancel this accepted Run at that boundary.
                sendAcp: async (_provider, message) => {
                    if (message.type !== 'tool-call' || message.name !== 'SubAgentRun') return;
                    publishedCallId = message.callId;
                    const accepted = bridge.listPublic()[0];
                    if (!accepted) throw new Error('Expected the accepted Run before transcript publication');
                    expect(await bridge.stop(accepted.runId)).toEqual({ ok: true });
                },
            });
            const start = {
                sessionId: 'parent-session', intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                modelId: 'selected-model', modelSelection: null, connectedServices: null,
                permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
                sessionConfigOptionOverrides: { v: 1, updatedAt: 1, overrides: {
                    reasoning_effort: { updatedAt: 1, value: 'high' },
                } },
            } satisfies ExecutionRunManagerStartParams;
            const created = await bridge.ensureOrStart({ start });
            if (!created.ok) throw new Error('Expected creation to return its accepted response');
            const retained = bridge.get(created.runId);
            expect(retained).toMatchObject({ status: 'cancelled', callId: publishedCallId });
            if (!retained || !publishedCallId) throw new Error('Expected the retained and published creation identities');
            expect(created).toEqual({
                ok: true, created: true, runId: retained.runId, callId: publishedCallId, sidechainId: retained.sidechainId,
                requestedConfiguration: { modelId: 'selected-model', reasoningEffort: 'high' },
                resolvedSelection: { source: 'explicit', modelId: 'selected-model', connectedServices: null },
            });
            // A retained identity keeps ensure semantics even with start params:
            // it cannot create a replacement for a stopped Run.
            expect(await bridge.ensureOrStart({ runId: ` ${created.runId} `, start })).toMatchObject({
                ok: false, errorCode: 'execution_run_not_allowed',
            });
            expect(bridge.listPublic()).toHaveLength(1);
        } finally {
            await bridge?.dispose();
            vi.unstubAllEnvs();
            reloadConfiguration();
            rmSync(directory, { recursive: true, force: true });
        }
    });
});

describe('Voice execution-run resume launch custody', () => {
    it.each([null, {
        v: 2, bindingsByServiceId: { 'openai-codex': { source: 'connected', selection: 'profile', profileId: 'original-account' } },
    }] satisfies (ConnectedServiceBindingsV2 | null)[])('rehydrates the original credential selection %j and distinct role models', async (connectedServices) => {
        const backendTarget = { kind: 'builtInAgent' as const, agentId: 'codex' };
        const chatModelSelection = ProviderBoundModelRefSchema.parse({ agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: 'original-chat-provider', modelId: 'chat-model' });
        const commitModelSelection = ProviderBoundModelRefSchema.parse({ ...chatModelSelection, providerConnectionId: 'original-commit-provider', modelId: 'commit-model' });
        const commitConnectedServices: ConnectedServiceBindingsV2 = { v: 2, bindingsByServiceId: {
            'happier.agent.codex/openai-codex': { source: 'connected', selection: 'group', groupId: 'original-commit-pool' },
        } };
        const run: ExecutionRunState = {
            runId: 'voice-resume', callId: 'call', sidechainId: 'sidechain', sessionId: 'parent', depth: 0,
            intent: 'voice_agent', backendTarget, backendId: 'codex', instructions: '', permissionMode: 'read_only',
            retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming', status: 'cancelled', startedAtMs: 1,
            launch: {
                connectedServicesSelection: connectedServices, modelId: 'chat-model', modelSelection: chatModelSelection,
                teamCredentialModel: {
                    kind: 'team_credential_provider_model', resourceId: 'original-team-resource', teamId: 'original-team',
                    expectedResourceRevision: 8, agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'chat-model', deliveryMode: 'brokered',
                },
                sessionConfigOptionOverrides: { v: 1, updatedAt: 1, overrides: { reasoning_effort: { updatedAt: 1, value: 'high' } } },
                cwd: '/original-workspace', acpSessionModeId: 'plan',
                secretReferenceOverlay: { v: 1, bindings: { API_KEY: { ref: 'happier:shared-secret:v1:original', revision: 7 } } },
            },
            resumeHandle: { kind: 'voice_agent_sessions.v1', backendTarget: readBackendTargetRefV2(backendTarget), chatProviderSessionId: 'vendor-chat', commitProviderSessionId: 'vendor-commit' },
            voiceAgentConfig: {
                chatModelId: 'chat-model', commitModelId: 'commit-model', chatModelSelection, commitModelSelection,
                commitConnectedServices,
                commitIsolation: true, permissionIntent: 'read-only', idleTtlSeconds: 60, initialContext: '',
                initialContextMode: 'bootstrap', verbosity: 'short', disabledActionIds: [], transcript: { persistenceMode: 'ephemeral', epoch: 1 },
            },
        };
        const seen: Parameters<Parameters<typeof ensureExecutionRun>[0]['createRuntime']>[0][] = [];
        const providerIdentityPublications: Array<() => void> = [];
        const runs = new Map([[run.runId, run]]);
        const voiceAgentManager = new VoiceAgentManager({
            createRuntime: () => { throw new Error('Resume must use its launch-bound factory'); },
            onResumeHandleChanged(voiceAgentId, resumeHandle) {
                const current = runs.get(voiceAgentId);
                if (current?.status === 'running') runs.set(voiceAgentId, { ...current, resumeHandle });
            },
        });
        try {
            const result = await ensureExecutionRun({
                runId: run.runId, params: { resume: true }, runs, controllers: new Map<string, ExecutionRunController>(),
                budgetRegistry: null, voiceAgentManager,
                createRuntime(options) {
                    seen.push(options);
                    // The genuine Agent launch boundary selects native or the exact
                    // original account. An omitted selection would use a changed default.
                    expect(Object.hasOwn(options, 'connectedServices')).toBe(true);
                    expect(options.connectedServices).toEqual(options.modelId === 'commit-model' ? commitConnectedServices : connectedServices);
                    const runtime: AgentRuntime = { sessions: { async open(request) {
                        expect(request).toMatchObject({ kind: 'resume', providerSessionId: options.modelId === 'chat-model' ? 'vendor-chat' : 'vendor-commit' });
                        let listener: ((event: AgentSessionRuntimeEvent) => void) | null = null;
                        providerIdentityPublications.push(() => listener?.({
                            kind: 'provider-session-id', providerSessionId: options.modelId === 'chat-model' ? 'vendor-chat' : 'vendor-commit',
                            sequence: 1, sessionId: 'session-parent', emittedAtMs: 1,
                        }));
                        return { watch(next) { listener = next; return { dispose() { listener = null; } }; }, async send() { return { status: 'admitted' as const }; }, async dispose() {} };
                    } } };
                    return createNativeAgentSessionInteractionHostRuntime({
                        runtime,
                        lease: { pluginId: 'acme.voice', pluginVersion: '1.0.0', agentId: 'acme.voice/agents/default', localAgentId: 'default', occurrenceId: options.controllerOccurrenceId, isCurrent: () => true },
                        options: {
                            ...options,
                            accountSettings: options.accountSettings ? AccountSettingsSchema.parse(options.accountSettings) : options.accountSettings,
                            cwd: options.start?.cwd ?? '/repo', runId: run.runId, scope: 'session_owned',
                        },
                        sessionCapabilities: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: false },
                        createSessionContext: ({ services, signal }) => createVoiceSessionContextLease({ services, signal, async dispose() {} }),
                    });
                },
                sendAcp: async () => {}, parentProvider: 'codex', streamedTranscriptSession: null, getNowMs: () => 2,
                writeActivityMarker: async () => {
                    // Resume pauses at persistence; real delayed native evidence
                    // replaces its immutable checkpoint under the same controller.
                    for (const publish of providerIdentityPublications) publish();
                    await Promise.resolve();
                },
            });
            expect(result).toEqual({ ok: true });
            expect(runs.get(run.runId)).toMatchObject({ status: 'running', resumeHandle: run.resumeHandle });
            expect(seen.map((options) => options.modelSelection)).toEqual([chatModelSelection, commitModelSelection]);
            expect(seen.map((options) => options.modelId)).toEqual(['chat-model', 'commit-model']);
            for (const options of seen) {
                expect(options.sessionConfigOptionOverrides).toEqual(run.launch?.sessionConfigOptionOverrides);
                expect(options.teamCredentialModel).toEqual(run.launch?.teamCredentialModel);
                expect(options).toMatchObject({ secretReferenceOverlay: run.launch?.secretReferenceOverlay, start: { cwd: '/original-workspace', acpSessionModeId: 'plan', intent: 'voice_agent' } });
            }
        } finally { await voiceAgentManager.dispose(); }
    });
});
