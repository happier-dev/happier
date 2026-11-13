import { describe, expect, it } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import type { ActionSessionAddressV1 } from '@happier-dev/plugin-sdk/sessions';
import type { ComposerTransactionV1 } from '@happier-dev/plugin-sdk/ui';
import { PLUGIN_ACTION_INPUT_SCHEMAS, type ActionExecutorDeps } from '@happier-dev/protocol';
import { resolveActionSessionTargets } from '@happier-dev/protocol/actions/executor/sessionTargets';
import { TRIAGE_ACCOUNT_ACTIONS } from '../accountDefinition.js';
import { ActionSessionAddressV1Schema } from '@happier-dev/plugin-sdk/sessions';
import { TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1 } from '@happier-dev/triage-protocol/v1';
import { createTriageRunConfiguredActionHandler } from '../actions/configuredActionRun.js';
import { TRIAGE_RUN_CONFIGURED_ACTION_LOCAL_ID_V1, TriageRunConfiguredActionInputV1Schema,
    type TriageRunConfiguredActionInputV1 } from '../actions/configuredActionRunProtocol.js';
import { testkitEntryRef, testkitLocator, testkitSnapshot, testkitViewer } from '../corpus/testkit/observations.test-support.js';
import { testkitConfiguredInstance, testkitTriageActionId } from './testkit/entrySessionTestkit.test-support.js';
import { createTriageEntrySessionStartController, type TriageEntrySessionStartRequestV1,
    type TriageStartHostV1 } from './entrySessionStartController.js';
import { describeTriageEntrySessionPhaseV1 } from '../ui/header/sessionStartOutcome.js';

function fixture(delivery: 'send' | 'compose' = 'send', rejected = false, uncertainOnce = false, dispatchFailure?: PluginError) {
    const entryRef = testkitEntryRef({ kindId: 'issue' });
    const request: TriageEntrySessionStartRequestV1 = {
        action: { actionId: 'ask', label: 'Ask', enabled: true, appliesTo: ['issue'], profileId: null,
            workspaceMode: 'reference_only', target: { kind: 'agent', promptInvocationId: null, delivery,
                ...(delivery === 'send' ? { seededFallbackInstruction: 'Investigate the issue.' } : {}) } },
        entryRef, display: { locator: testkitLocator(), scopeLabel: 'example/repository' },
        sourceInstance: { source: entryRef.source, sourceInstanceId: testkitConfiguredInstance().instance.sourceInstanceId },
        presentation: { label: 'Issue context' },
    };
    const operands: TriageRunConfiguredActionInputV1[] = [];
    const addresses: ActionSessionAddressV1[] = [];
    const sends: Array<{ input: ReturnType<typeof PLUGIN_ACTION_INPUT_SCHEMAS['session.message.send']['parse']>; options: unknown }> = [];
    const edits: ComposerTransactionV1[] = [];
    const unexpected: string[] = [];
    const boundaryErrors: unknown[] = [];
    let address: ActionSessionAddressV1 = { serverId: 'home-a', sessionId: 'same-session' };
    const protocol = { id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1, version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1 };
    const host = {
        context: async () => ({ targetedContributions: {
            target: { pluginId: 'happier.triage', immutableGenerationId: 'target-1' },
            points: [{ pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, protocols: [{ protocol, contributions: [{
                contributor: { pluginId: entryRef.source.pluginId, contributionId: entryRef.source.localId, immutableGenerationId: 'source-1' },
                protocol, descriptor: { v: 1, purpose: 'triage-source', displayName: 'Example source',
                    kinds: [{ id: 'issue', displayName: 'Issue', workflowSubject: 'issue' }] }, operations: [], surfaces: [],
            }] }] }],
        } }),
        readSession: async () => address,
        selectActionInput: async () => ({ kind: 'sessionAddress', session: address }),
        readComposer: async () => ({ status: 'ready', snapshot: { revision: 1,
            ref: { kind: 'session', sessionId: address.sessionId }, text: '', attachments: [],
            state: { editable: true }, capabilities: {} } }),
        applyComposer: async (_ref: unknown, transaction: ComposerTransactionV1) => { edits.push(transaction); return { status: 'applied' }; },
        executeAction: async (id: unknown, input: JsonValue, options?: unknown): Promise<unknown> => {
            const localId = testkitTriageActionId(id);
            if (localId === 'session.list') return { sessions: [{ id: address.sessionId, serverId: address.serverId, updatedAt: 1 }], hasNext: false };
            if (localId === TRIAGE_RUN_CONFIGURED_ACTION_LOCAL_ID_V1) {
                if (dispatchFailure) throw dispatchFailure;
                const operand = TriageRunConfiguredActionInputV1Schema.parse(input);
                operands.push(operand);
                const sessionChoice = operand.handoff.sessionChoice;
                if (sessionChoice.kind !== 'existing' || typeof sessionChoice.session !== 'string') throw new Error('Exact Session required');
                const selectedAddress = ActionSessionAddressV1Schema.parse(options && typeof options === 'object' && 'sessionAddress' in options ? options.sessionAddress : undefined);
                const declaration = TRIAGE_ACCOUNT_ACTIONS[TRIAGE_RUN_CONFIGURED_ACTION_LOCAL_ID_V1].sessionTarget;
                if (!declaration) throw new Error('Configured Action must declare its Session operand');
                // The authorized Home reference read is the only replaced admission boundary.
                const transport = { resolveSessionReference: async ({ sessionId, context }: Parameters<NonNullable<ActionExecutorDeps['resolveSessionReference']>>[0]) => {
                    const authorized = [{ serverId: 'home-a', sessionId: 'same-session' }, { serverId: 'home-b', sessionId: 'same-session' }]
                        .find(candidate => candidate.serverId === context.serverId && candidate.sessionId === sessionId);
                    return authorized ? { kind: 'unique' as const, address: authorized } : { kind: 'none' as const };
                } } satisfies Pick<ActionExecutorDeps, 'resolveSessionReference'>;
                const sessionTargetsV1 = await resolveActionSessionTargets(transport, {
                    actionId: 'action.invoke', declaration, input: operand,
                    context: { surface: 'ui', authority: 'account_automation', serverId: selectedAddress.serverId,
                        expectedSessionAddress: selectedAddress },
                });
                if (!sessionTargetsV1 || 'ok' in sessionTargetsV1) throw new PluginError({
                    code: sessionTargetsV1 && 'ok' in sessionTargetsV1 ? sessionTargetsV1.errorCode : 'session_target_unavailable',
                });
                address = selectedAddress;
                addresses.push(address);
                const context = { ui: host, signal: new AbortController().signal,
                    sessionTargetsV1 } as unknown as PluginAccountActionContext;
                try { return await createTriageRunConfiguredActionHandler()(input, context); }
                catch (error) { boundaryErrors.push(error); throw error; }
            }
            if (localId === 'actions/read-v1') return { v: 1, availability: 'parsed', revision: '1', actions: [request.action] };
            if (localId === 'entries/reobserve-v1') return { kind: 'observed', entryRef, observation: {
                sourceInstanceId: request.sourceInstance.sourceInstanceId, observedAtMs: 1,
                outcome: { kind: 'present', locator: testkitLocator(), snapshot: testkitSnapshot(), viewer: testkitViewer() },
            } };
            if (localId === 'entries/read-detail-v1') return { kind: 'read', instance: testkitConfiguredInstance(), linkedSessions: [] };
            if (localId === 'sessions/link-entry-v1') return { v: 1, status: 'linked' };
            if (id === 'session.message.send') {
                sends.push({ input: PLUGIN_ACTION_INPUT_SCHEMAS['session.message.send'].parse(input), options });
                if (uncertainOnce && sends.length === 1) throw new Error('Reply lost at transport');
                return rejected ? { status: 'rejected', code: 'session_input_cancelled' } : { status: 'accepted', localId: 'native-receipt' };
            }
            unexpected.push(String(id));
            throw new Error(`Unexpected Action ${String(id)}`);
        },
    };
    // Host UI/Action RPCs are the system boundary, not the internal configured handoff.
    const controller = createTriageEntrySessionStartController(host as unknown as TriageStartHostV1);
    return { controller, request, operands, addresses, sends, edits, unexpected, boundaryErrors, setAddress: (value: ActionSessionAddressV1) => { address = value; } };
}

describe('entry existing Session handoff', () => {
    it('retains the dispatch refusal and request identity for the existing failure presenter', async () => {
        const f = fixture('send', false, false, new PluginError({ code: 'target_unavailable',
            diagnostics: [{ code: 'daemon_forward_not_ok' }], details: { requestId: 'send-request' } }));
        await f.controller.getSnapshot().startInSession(f.request, { serverId: 'home-a', sessionId: 'same-session' });
        expect(f.controller.getSnapshot().phase).toMatchObject({ kind: 'unavailable',
            failure: { codes: ['target_unavailable', 'daemon_forward_not_ok'], requestId: 'send-request' } });
        expect(f.sends).toEqual([]);
    });

    it('keeps equal Session ids on two Homes distinct and returns native receipts', async () => {
        const f = fixture();
        for (const serverId of ['home-a', 'home-b']) {
            const session = { serverId, sessionId: 'same-session' };
            const result = await f.controller.getSnapshot().startInSession(f.request, session);
            expect(f.boundaryErrors).toEqual([]);
            expect(result).toMatchObject({
                handoff: { kind: 'sendResult', session, result: { status: 'accepted', localId: 'native-receipt' } },
            });
        }
        expect(f.sends.map(send => send.options)).toEqual([
            expect.objectContaining({ sessionAddress: { serverId: 'home-a', sessionId: 'same-session' } }),
            expect.objectContaining({ sessionAddress: { serverId: 'home-b', sessionId: 'same-session' } }),
        ]);
        expect(f.unexpected).toEqual([]);
    });

    it('refuses an existing Session outside the authorized corpus before the configured handler sends', async () => {
        const f = fixture();
        await f.controller.getSnapshot().startInSession(f.request, { serverId: 'unavailable-home', sessionId: 'same-session' });
        expect(f.controller.getSnapshot().phase).toMatchObject({ kind: 'unavailable',
            failure: { codes: ['session_target_unavailable'] } });
        expect(f.sends).toEqual([]);
        expect(f.edits).toEqual([]);
    });

    it('Find refuses an instructionless compose action rather than inventing a Fix instruction for Send', async () => {
        const f = fixture('compose');
        const session = { serverId: 'home-b', sessionId: 'same-session' };
        f.setAddress(session);
        f.controller.getSnapshot().start({ ...f.request, destinationChoice: 'existingSession' });
        const settled = await f.controller.waitForSettled();
        expect(settled.phase).toMatchObject({ kind: 'handoffSettled', result: {
            handoff: { kind: 'unavailable', reason: 'configuredActionUnavailable' },
        } });
        expect(f.operands[0]?.handoff).toMatchObject({ task: 'investigate', delivery: 'send',
            agentChoice: { kind: 'configured' }, sessionChoice: { kind: 'existing', session: session.sessionId } });
        expect(f.addresses).toEqual([session]);
        expect(f.edits).toEqual([]);
        expect(f.sends).toEqual([]);
        expect(f.unexpected).toEqual([]);
    });

    it('keeps native refusal visible in the existing phase notice', async () => {
        const f = fixture('send', true);
        const result = await f.controller.getSnapshot().startInSession(f.request, { serverId: 'home-b', sessionId: 'same-session' });
        expect(result?.handoff).toMatchObject({ kind: 'sendResult', result: { status: 'rejected', code: 'session_input_cancelled' } });
        expect(describeTriageEntrySessionPhaseV1(f.controller.getSnapshot().phase)?.tone).toBe('warning');
    });

    it('echoes canonical recovery after an uncertain send instead of minting a second delivery', async () => {
        const f = fixture('send', false, true);
        const session = { serverId: 'home-b', sessionId: 'same-session' };
        const first = await f.controller.getSnapshot().startInSession(f.request, session);
        expect(first?.handoff).toMatchObject({ kind: 'uncertain', phase: 'send', session });
        expect(describeTriageEntrySessionPhaseV1(f.controller.getSnapshot().phase)?.tone).toBe('warning');
        expect((await f.controller.getSnapshot().startInSession(f.request, session))?.handoff)
            .toMatchObject({ kind: 'sendResult', result: { status: 'accepted' } });
        expect(f.operands[1]?.resumeStart).toEqual(first?.recovery);
        expect(f.sends[1]?.input).toEqual(f.sends[0]?.input);
    });

    it('does not reuse uncertain recovery for an equal Session id on another Home', async () => {
        const f = fixture('send', false, true);
        await f.controller.getSnapshot().startInSession(f.request, { serverId: 'home-a', sessionId: 'same-session' });
        const session = { serverId: 'home-b', sessionId: 'same-session' };
        expect((await f.controller.getSnapshot().startInSession(f.request, session))?.handoff)
            .toMatchObject({ kind: 'sendResult', session, result: { status: 'accepted' } });
        expect(f.operands[1]?.resumeStart).toBeUndefined();
    });
});
