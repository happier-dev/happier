import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { withToolTraceFile } from '@/testkit/logger/toolTraceFile';
import { accountSettingsParse } from '@happier-dev/protocol';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import type { AgentState } from '@/api/types';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import type { AgentInvocationTurnAdmissionWitness } from '@/plugins/runtime/invocation/services/types';
import { createProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/createHandler';
import { PluginAgentContributionV2Schema } from '@happier-dev/protocol/plugins/contributions/v2';
import type { AgentStateRequestCoverageOptions } from '@happier-dev/agents';
import { ServerBoundPermissionRpcHandlerManager } from '@/agent/permissions/testkit/serverBoundPermissionRpcHandlerManager';
import { createRunScopedExecutionPermissionHandler } from '@/agent/executionRuns/policy/runScopedExecutionPermissionHandler';
import { resolveExecutionRunPermissionInteractionMode } from '@/agent/executionRuns/policy/executionRunPermissionInteractionPolicy';
import { createNativeAgentSessionServices } from './nativeAgentSessionInteractions';
import { createClaudeNativeAgentSdkContext } from '../../../../../../../packages/plugins/claude/src/agent/runtime/nativeServices';
import { createClaudeNativePermissionEngine } from '../../../../../../../packages/plugins/claude/src/agent/permissions/nativePermissionEngine';
import { createClaudeUnifiedResumeChoiceStartupHandler } from '../../../../../../../packages/plugins/claude/src/agent/runtime/terminal/unified/resumeChoice/startup';
import { parseClaudeScreenState } from '../../../../../../../packages/plugins/claude/src/agent/runtime/terminal/unified/screenState';
import { createFakeControlPort } from '../../../../../../../packages/plugins/claude/src/agent/runtime/terminal/unified/tuiControls/fakeControlPort';
import { CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE } from '@happier-dev/protocol/agents/claude';

const TRUST_FOLDER_DIALOG = [
    'Accessing workspace:', '/tmp/new-project',
    'Quick safety check: Is this a project you created or one you trust?',
    '❯ 1. Yes, I trust this folder', '  2. No, exit',
].join('\n');
const IDLE_COMPOSER = ['──────────────────────────────', '❯ ', '──────────────────────────────'].join('\n');
const HIDDEN_TRUST_FOLDER_DIALOG = [
    'Accessing workspace:', '/tmp/new-project',
    'Quick safety check: Is this a project you created or one you trust?',
    '❯ No, exit', '  Yes, I trust this folder',
    'Enter to confirm · Esc to cancel',
].join('\n');
const NEXT_DIALOG = [
    'Allow external CLAUDE.md file imports?',
    '❯ No, disable external imports', '  Yes, allow external imports',
    'Enter to confirm · Esc to cancel',
].join('\n');

function createFixture(runPermissionMode?: string, trace = false, requestCoverage?: AgentStateRequestCoverageOptions) {
    let state: AgentState = { requests: {}, completedRequests: {} };
    let stateWrites = 0;
    let stateWriteBarrier: Promise<void> | null = null;
    const sessionId = 'native-startup-question';
    const rpcHandlerManager = new ServerBoundPermissionRpcHandlerManager(sessionId);
    // AgentState persistence and authenticated RPC ingress are the system boundaries.
    const persistence = {
        getAgentStateSnapshot: () => state, getMetadataSnapshot: () => null,
        updateAgentState: async (update: (previous: AgentState) => AgentState) => {
            if (stateWriteBarrier) await stateWriteBarrier;
            state = update(state);
            stateWrites += 1;
        },
        updateAgentStateRequestSettlement: async (update: (previous: AgentState) => AgentState) => {
            await persistence.updateAgentState(update);
        },
    } satisfies Pick<ApiSessionClient, 'getAgentStateSnapshot' | 'getMetadataSnapshot'
        | 'updateAgentState' | 'updateAgentStateRequestSettlement'>;
    const session = createMutableApiSessionClientFixture({ sessionId, overrides: persistence });
    vi.spyOn(session.rpcHandlerManager, 'registerHandler').mockImplementation(
        rpcHandlerManager.registerHandler.bind(rpcHandlerManager),
    );
    const permissions = createProviderEnforcedPermissionHandler({ session, logPrefix: '[StartupQuestion]', requestCoverage,
        ...(trace ? { toolTrace: () => ({ protocol: 'codex' as const, provider: 'custom' }) } : {}) });
    const occurrence = new AbortController();
    let witness: AgentInvocationTurnAdmissionWitness | null = null;
    const runScope = runPermissionMode ? createRunScopedExecutionPermissionHandler({
        runId: 'trust-child', controllerOccurrenceId: 'trust-child-occurrence', handler: permissions,
        toolPolicy: { permissionMode: runPermissionMode, backendId: 'claude' },
        readInteractionMode: () => resolveExecutionRunPermissionInteractionMode({
            intent: 'delegate', runClass: 'bounded', ioMode: 'request_response', retentionPolicy: 'ephemeral',
            permissionMode: runPermissionMode, parentSessionId: sessionId, interactionTargetAvailable: true,
            backendCapabilities: { canRespondToPermission: true, canSurfaceParentSessionPrompt: true,
                runtimeKind: 'native_agent_session', backendId: 'claude' },
        }),
    }) : null;
    const services = createNativeAgentSessionServices({
        permissionHandler: runScope?.handler ?? permissions, pluginId: 'happier.agent.claude', contributionId: 'claude', runtimeId: 'claude',
        sessionId, occurrenceId: 'claude-occurrence', signal: occurrence.signal, isCurrent: () => !occurrence.signal.aborted,
        credentials: { token: 'fixture-token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
        sourceCustody: { kind: 'managed', immutableGenerationId: 'fixture-generation', installSource: 'npm' },
        readActiveTurnAdmissionWitness: () => witness,
    });
    // The native context is the public plugin boundary; all exercised host services are real.
    const context = { services: { ...services, exec: {}, logger: { debug() {}, info() {}, warn() {}, error() {} } },
        session: { id: sessionId, services: {} },
    } as unknown as AgentSessionRuntimeContext;
    return { sessionId, permissions, occurrence, services, context, native: createClaudeNativeAgentSdkContext(context),
        state: () => state,
        stateWrites: () => stateWrites,
        setWitness: (next: AgentInvocationTurnAdmissionWitness | null) => { witness = next; },
        pauseStateWrites: () => {
            let release!: () => void;
            stateWriteBarrier = new Promise<void>(resolve => { release = resolve; });
            return () => { stateWriteBarrier = null; release(); };
        },
        answer: async (input: unknown) => {
            const answer = rpcHandlerManager.handlers.get('session.user_action.answer');
            if (!answer) throw new Error('Expected user-action RPC');
            return await answer(input);
        },
    };
}

describe('native startup question permission composition', () => {
    it('suppresses a retried native request using the selected contributed Agent declaration', async () => {
        const declaration = PluginAgentContributionV2Schema.parse({
            id: 'custom', title: { key: 'fixture.custom', fallback: 'Custom' },
            runtime: { kind: 'custom' }, primary: 'sessions',
            capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
            requestCoverage: { equivalentSources: ['custom_native_dialog'], equivalentCompletedStatuses: ['canceled'],
                equivalentCompletedReasons: ['Native dialog stopped'] },
        });
        const fixture = createFixture(undefined, false, declaration.requestCoverage);
        await fixture.permissions.abortPendingRequestsAndFlush('fixture initialization');
        const input = { questions: [{ question: 'Proceed?' }] };
        fixture.state().completedRequests!.original = { tool: 'AskUserQuestion', arguments: input,
            owner: { kind: 'plugin', pluginId: 'happier.agent.claude', runtimeId: 'claude' },
            source: 'custom_native_dialog', status: 'canceled', reason: 'Native dialog stopped', completedAt: Date.now() };
        const writesBeforeRequest = fixture.stateWrites();
        const pending = fixture.services.sessions.current!.permissions.requestDecision({
            requestId: 'custom-retry', toolName: 'AskUserQuestion', source: 'custom_native_dialog', input,
        }).catch(() => null);
        try {
            await vi.waitFor(() => expect(fixture.stateWrites()).toBeGreaterThan(writesBeforeRequest));
            expect(fixture.state().requests?.['custom-retry']).toBeUndefined();
            expect(fixture.state().completedRequests?.original?.status).toBe('canceled');
        } finally {
            fixture.occurrence.abort();
            await fixture.permissions.abortPendingRequestsAndFlush('test cleanup');
            await pending;
        }
    });
    it('carries producer trace facts through the public native permission service without private input', async () => {
        await withToolTraceFile('native-private-dialog-', async filePath => {
            const fixture = createFixture(undefined, true);
            const traceSummary = { kind: 'recognized', id: 'custom_dialog', itemCount: 1, optionCount: 2 };
            const pending = fixture.services.sessions.current!.permissions.requestDecision({
                requestId: 'custom-private-dialog', toolName: 'AskUserQuestion', source: 'custom_native_dialog',
                input: { questions: [{ question: 'private-question', options: [{ label: 'private-option' }] }] },
                traceSummary,
            }).catch(() => null);
            try {
                await vi.waitFor(() => expect(fixture.state().requests?.['custom-private-dialog']).toBeDefined());
                const requestTrace = readFileSync(filePath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
                    .find(event => event.kind === 'permission-request');
                expect(requestTrace.payload.options.input).toEqual({ redacted: true, ...traceSummary });
                expect(JSON.stringify(requestTrace)).not.toContain('private-question');
                expect(JSON.stringify(requestTrace)).not.toContain('private-option');
            } finally {
                fixture.occurrence.abort();
                await fixture.permissions.abortPendingRequestsAndFlush('test cleanup');
                await pending;
            }
        });
    });
    beforeEach(() => {
        resetActiveAccountSettingsSnapshotForTests();
        setActiveAccountSettingsSnapshot({ scopeKey: 'startup-question-test', source: 'network', settingsVersion: 1,
            settings: accountSettingsParse({}), rawSettings: {}, settingsSecretsReadKeys: [], loadedAtMs: 1,
            promptLibraryCatalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] },
        });
    });
    afterEach(() => resetActiveAccountSettingsSnapshotForTests());
    it('applies one child trust answer through the hidden native chooser before retiring the question', async () => {
        const fixture = createFixture('read-only');
        const focusedTrust = HIDDEN_TRUST_FOLDER_DIALOG
            .replace('❯ No, exit', '  No, exit')
            .replace('  Yes, I trust this folder', '❯ Yes, I trust this folder');
        const port = createFakeControlPort({ captures: [HIDDEN_TRUST_FOLDER_DIALOG, focusedTrust, IDLE_COMPOSER] });
        const startup = createClaudeUnifiedResumeChoiceStartupHandler({ ctx: fixture.native, sessionId: fixture.sessionId,
            port, settleMs: 0, wait: async () => undefined,
        });
        try {
            expect(await startup.handle(parseClaudeScreenState(HIDDEN_TRUST_FOLDER_DIALOG))).toBe('waiting_for_user');
            await vi.waitFor(() => expect(Object.keys(fixture.state().requests ?? {})).toHaveLength(1));
            const requestId = Object.keys(fixture.state().requests ?? {})[0]!;
            await expect(fixture.answer({ id: requestId, approved: true,
                answers: { claudeUnifiedTerminalTrustFolder: ['trust_once'] },
            })).resolves.toBeUndefined();
            expect(port.sentLiteral).toEqual([]);
            expect(port.sentKeys).toEqual(['ArrowDown', 'Enter']);
            expect(fixture.state().requests?.[requestId]).toBeUndefined();
            expect(fixture.state().completedRequests?.[requestId]).toMatchObject({ status: 'approved' });
        } finally {
            fixture.occurrence.abort();
            await startup.dispose();
            await fixture.permissions.abortPendingRequestsAndFlush('test cleanup');
        }
    });
    it.each(['read-only', 'default'])('publishes a child workspace trust question through the Run policy in %s mode', async (mode) => {
        const fixture = createFixture(mode);
        if (mode === 'read-only') fixture.setWitness({ inputId: 'child-input', turnId: 'child-turn',
            userMessageSeq: 1, userMessageSeqs: [1], causalPermissionAuthority: {
                kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'read-only',
            },
        });
        const port = createFakeControlPort({ captures: [TRUST_FOLDER_DIALOG, IDLE_COMPOSER] });
        const startup = createClaudeUnifiedResumeChoiceStartupHandler({ ctx: fixture.native, sessionId: fixture.sessionId,
            port, settleMs: 0, wait: async () => undefined,
        });
        try {
            expect(await startup.handle(parseClaudeScreenState(TRUST_FOLDER_DIALOG))).toBe('waiting_for_user');
            await vi.waitFor(() => expect(Object.keys(fixture.state().requests ?? {})).toHaveLength(1));
            const [requestId, request] = Object.entries(fixture.state().requests ?? {})[0]!;
            expect(request).toMatchObject({ tool: 'AskUserQuestion',
                source: CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE,
                arguments: { happierDialog: { dialogId: 'trust_folder' } },
            });
            expect(requestId).toContain('execution-run:trust-child:trust-child-occurrence:');
            expect(port.sentLiteral).toEqual([]);
            await fixture.answer({ id: requestId, approved: true,
                answers: { claudeUnifiedTerminalTrustFolder: ['trust_once'] },
            });
            await vi.waitFor(() => expect(fixture.state().requests?.[requestId]).toBeUndefined());
            expect(port.sentLiteral).toEqual(['1']);
            expect(fixture.state().completedRequests?.[requestId]).toMatchObject({ status: 'approved' });
            for (const toolName of ['Bash', 'Edit']) {
                await expect(fixture.services.sessions.current?.permissions.requestDecision({
                    requestId: `unadmitted-${toolName}`, toolName,
                    source: CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE,
                    input: { happierDialog: { dialogId: 'trust_folder' } },
                })).resolves.toEqual({ decision: 'denied' });
            }
        } finally {
            fixture.occurrence.abort();
            await startup.dispose();
            await fixture.permissions.abortPendingRequestsAndFlush('test cleanup');
        }
    });

    it('publishes untrusted-folder startup in the app and applies the exact answer before RPC success', async () => {
        const fixture = createFixture();
        let finishApplication!: () => void;
        const application = new Promise<void>(resolve => { finishApplication = resolve; });
        let applying = false;
        const port = createFakeControlPort({ captures: [TRUST_FOLDER_DIALOG, IDLE_COMPOSER],
            onSendLiteralText: async () => { applying = true; await application; },
        });
        const startup = createClaudeUnifiedResumeChoiceStartupHandler({ ctx: fixture.native, sessionId: fixture.sessionId,
            port, settleMs: 0, wait: async () => undefined,
        });
        try {
            expect(await startup.handle(parseClaudeScreenState(TRUST_FOLDER_DIALOG))).toBe('waiting_for_user');
            await vi.waitFor(() => expect(Object.keys(fixture.state().requests ?? {})).toHaveLength(1));
            const [requestId, request] = Object.entries(fixture.state().requests ?? {})[0]!;
            expect(request).toMatchObject({ tool: 'AskUserQuestion', source: CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE,
                arguments: { happierDialog: { dialogId: 'trust_folder' }, questions: [expect.objectContaining({
                    options: expect.arrayContaining([expect.objectContaining({ choice: 'always_trust_happier_workspaces',
                        settingMutation: { settingId: 'claudeUnifiedTerminalWorkspaceTrust', value: 'always_trust_happier_workspaces' },
                    })]),
                })] },
            });
            expect(port.sentLiteral).toEqual([]);
            await fixture.permissions.cancelByPluginTurn('happier.agent.claude', 'previous-turn', 'turn completed');
            expect(fixture.state().requests?.[requestId]).toBeDefined();
            let answered = false;
            const answering = fixture.answer({ id: requestId, approved: true,
                answers: { claudeUnifiedTerminalTrustFolder: ['trust_once'] },
            }).then(result => { answered = true; return result; });
            await vi.waitFor(() => expect(applying).toBe(true));
            expect(answered).toBe(false);
            expect(fixture.state().requests?.[requestId]).toBeDefined();
            finishApplication();
            await expect(answering).resolves.toBeUndefined();
            expect(port.sentLiteral).toEqual(['1']);
            await vi.waitFor(() => expect(fixture.state().requests?.[requestId]).toBeUndefined());
        } finally {
            finishApplication();
            fixture.occurrence.abort();
            await startup.dispose();
            await fixture.permissions.abortPendingRequestsAndFlush('test cleanup');
        }
    });

    it('settles an applied trust answer before retiring it for the next native dialog', async () => {
        const fixture = createFixture();
        let finishApplication!: () => void;
        const application = new Promise<void>(resolve => { finishApplication = resolve; });
        let applying = false;
        const port = createFakeControlPort({ captures: [TRUST_FOLDER_DIALOG, NEXT_DIALOG],
            onSendLiteralText: async () => { applying = true; await application; },
        });
        const startup = createClaudeUnifiedResumeChoiceStartupHandler({ ctx: fixture.native, sessionId: fixture.sessionId,
            port, settleMs: 0, wait: async () => undefined,
        });
        try {
            await startup.handle(parseClaudeScreenState(TRUST_FOLDER_DIALOG));
            await vi.waitFor(() => expect(Object.keys(fixture.state().requests ?? {})).toHaveLength(1));
            const requestId = Object.keys(fixture.state().requests ?? {})[0]!;
            const answering = fixture.answer({ id: requestId, approved: true,
                answers: { claudeUnifiedTerminalTrustFolder: ['trust_once'] },
            });
            await vi.waitFor(() => expect(applying).toBe(true));
            // Native has already advanced while the terminal write/verification ACK is in flight.
            const next = startup.handle(parseClaudeScreenState(NEXT_DIALOG));
            finishApplication();
            await expect(answering).resolves.toBeUndefined();
            await expect(next).resolves.toBe('waiting_for_user');
            await startup.handle(parseClaudeScreenState(NEXT_DIALOG));
            expect(fixture.state().completedRequests?.[requestId]).toMatchObject({ status: 'approved' });
            await vi.waitFor(() => expect(Object.keys(fixture.state().requests ?? {})).toHaveLength(1));
            expect(fixture.state().requests?.[requestId]).toBeUndefined();
            expect(port.sentLiteral).toEqual(['1']);
        } finally {
            finishApplication();
            fixture.occurrence.abort();
            await startup.dispose();
            await fixture.permissions.abortPendingRequestsAndFlush('test cleanup');
        }
    });

    it('keeps screen observation responsive when an in-flight answer application fails', async () => {
        const fixture = createFixture();
        let rejectApplication!: (error: Error) => void;
        const application = new Promise<void>((_, reject) => { rejectApplication = reject; });
        let applying = false;
        const port = createFakeControlPort({ captures: [TRUST_FOLDER_DIALOG, NEXT_DIALOG],
            onSendLiteralText: async () => { applying = true; await application; },
        });
        const startup = createClaudeUnifiedResumeChoiceStartupHandler({ ctx: fixture.native, sessionId: fixture.sessionId,
            port, settleMs: 0, wait: async () => undefined,
        });
        try {
            await startup.handle(parseClaudeScreenState(TRUST_FOLDER_DIALOG));
            await vi.waitFor(() => expect(Object.keys(fixture.state().requests ?? {})).toHaveLength(1));
            const requestId = Object.keys(fixture.state().requests ?? {})[0]!;
            const answer = fixture.answer({ id: requestId, approved: true,
                answers: { claudeUnifiedTerminalTrustFolder: ['trust_once'] },
            }).catch(error => error);
            await vi.waitFor(() => expect(applying).toBe(true));
            let observed = false;
            const observation = startup.handle(parseClaudeScreenState(NEXT_DIALOG)).then(result => {
                observed = true;
                return result;
            });
            rejectApplication(new Error('terminal acknowledgement failed'));
            await expect(answer).resolves.toMatchObject({ message: 'terminal acknowledgement failed' });
            await vi.waitFor(() => expect(observed).toBe(true));
            await expect(observation).resolves.toBe('waiting_for_user');
            await startup.handle(parseClaudeScreenState(NEXT_DIALOG));
            await vi.waitFor(() => expect(fixture.state().requests?.[requestId]).toBeUndefined());
        } finally {
            rejectApplication(new Error('test cleanup'));
            fixture.occurrence.abort();
            await startup.dispose();
            await fixture.permissions.abortPendingRequestsAndFlush('test cleanup');
        }
    });

    it('does not apply a retired trust request while its durable cancellation is pending', async () => {
        const fixture = createFixture();
        const port = createFakeControlPort({ captures: [TRUST_FOLDER_DIALOG, IDLE_COMPOSER] });
        const startup = createClaudeUnifiedResumeChoiceStartupHandler({ ctx: fixture.native, sessionId: fixture.sessionId,
            port, settleMs: 0, wait: async () => undefined,
        });
        let releaseWrites: () => void = () => undefined;
        try {
            await startup.handle(parseClaudeScreenState(TRUST_FOLDER_DIALOG));
            await vi.waitFor(() => expect(Object.keys(fixture.state().requests ?? {})).toHaveLength(1));
            const requestId = Object.keys(fixture.state().requests ?? {})[0]!;
            // The real AgentState persistence boundary can remain pending after the
            // native occurrence retires; the app still shows its outstanding row.
            releaseWrites = fixture.pauseStateWrites();
            fixture.occurrence.abort();
            expect(fixture.state().requests?.[requestId]).toBeDefined();
            const answering = fixture.answer({ id: requestId, approved: true,
                answers: { claudeUnifiedTerminalTrustFolder: ['trust_once'] },
            });
            expect(port.sentLiteral).toEqual([]);
            releaseWrites();
            await expect(answering).resolves.toMatchObject({ ok: false, errorCode: 'permission_request_not_found' });
            expect(port.sentLiteral).toEqual([]);
            await vi.waitFor(() => expect(fixture.state().completedRequests?.[requestId]).toMatchObject({ status: 'canceled' }));
        } finally {
            releaseWrites();
            fixture.occurrence.abort();
            await startup.dispose();
            await fixture.permissions.abortPendingRequestsAndFlush('test cleanup');
        }
    });

    it('keeps a failed terminal application pending and cancels startup questions with their occurrence', async () => {
        const fixture = createFixture();
        const port = createFakeControlPort({ captures: [TRUST_FOLDER_DIALOG],
            onSendLiteralText: async () => { throw new Error('terminal write refused'); },
        });
        const startup = createClaudeUnifiedResumeChoiceStartupHandler({ ctx: fixture.native, sessionId: fixture.sessionId,
            port, settleMs: 0, wait: async () => undefined,
        });
        try {
            await startup.handle(parseClaudeScreenState(TRUST_FOLDER_DIALOG));
            await vi.waitFor(() => expect(Object.keys(fixture.state().requests ?? {})).toHaveLength(1));
            const requestId = Object.keys(fixture.state().requests ?? {})[0]!;
            await expect(fixture.answer({ id: requestId, approved: true,
                answers: { claudeUnifiedTerminalTrustFolder: ['trust_once'] },
            })).rejects.toThrow('terminal write refused');
            expect(fixture.state().requests?.[requestId]).toBeDefined();
            fixture.occurrence.abort();
            await vi.waitFor(() => expect(Object.keys(fixture.state().requests ?? {})).toHaveLength(0));
            await startup.dispose();
            expect(port.sentLiteral).toEqual(['1']);
        } finally {
            fixture.occurrence.abort();
            await startup.dispose();
            await fixture.permissions.abortPendingRequestsAndFlush('test cleanup');
        }
    });

    it('injects causal authority into the rich seam while refusing executable operations without it', async () => {
        const fixture = createFixture();
        const scoped = fixture.services.sessions.current?.permissions;
        if (!scoped) throw new Error('Expected current Session permissions');
        fixture.permissions.setPermissionMode('yolo');
        try {
            for (const toolName of ['Bash', 'Edit', 'mcp__docs__mutate', 'ExitPlanMode']) {
                await expect(scoped.requestDecision({ toolName, requestId: toolName,
                    source: CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE,
                    input: { happierDialog: { dialogId: 'trust_folder' } },
                }))
                    .resolves.toEqual({ decision: 'denied' });
            }
            fixture.setWitness({ inputId: 'input-1', turnId: 'turn-1', userMessageSeq: 1, userMessageSeqs: [1],
                causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' },
            });
            const pending = scoped.requestDecision({ requestId: 'admitted-edit', toolName: 'Edit', input: { file_path: 'file.txt' } });
            await vi.waitFor(() => expect(fixture.state().requests?.['admitted-edit']).toMatchObject({ turnId: 'turn-1' }));
            await fixture.permissions.abortPendingRequestsAndFlush('test cleanup');
            await pending.catch(() => undefined);
        } finally {
            fixture.occurrence.abort();
            await fixture.permissions.abortPendingRequestsAndFlush('test cleanup');
        }
    });

    it('keeps ordinary native questions on their admitted turn and detaches the exact caller', async () => {
        const fixture = createFixture();
        const caller = new AbortController();
        fixture.setWitness({ inputId: 'input-question', turnId: 'turn-question', userMessageSeq: 1, userMessageSeqs: [1],
            causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' },
        });
        const pending = createClaudeNativePermissionEngine(fixture.context).canCallTool('AskUserQuestion', {
            questions: [{ header: 'Choice', question: 'Which option?', options: [{ label: 'One' }, { label: 'Two' }] }],
        }, { signal: caller.signal });
        try {
            await vi.waitFor(() => expect(Object.values(fixture.state().requests ?? {})).toMatchObject([{ turnId: 'turn-question' }]));
            caller.abort();
            await expect(pending).resolves.toMatchObject({ behavior: 'deny' });
            // A durable Session question outlives its detached caller and stays on its admitted turn.
            expect(Object.values(fixture.state().requests ?? {})).toMatchObject([{ turnId: 'turn-question' }]);
        } finally {
            fixture.occurrence.abort();
            await fixture.permissions.abortPendingRequestsAndFlush('test cleanup');
            await pending.catch(() => undefined);
        }
    });
});
