import { expect, it } from 'vitest';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext, PluginClientActionUi } from '@happier-dev/plugin-sdk/actions';
import { PLUGIN_ACTION_INPUT_SCHEMAS } from '@happier-dev/protocol';
import { PluginUiSelectActionInputRequestV1Schema } from '@happier-dev/protocol/plugins/ui';
import {
    INTERNAL_TASK_SOURCE_V1, internalTaskLocalRefV1, TRIAGE_DEFAULT_FIX_ACTION_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
} from '@happier-dev/triage-protocol/v1';
import { createTriageRunConfiguredActionHandler } from '../actions/configuredActionRun.js';
import { TriageRunConfiguredActionInputV1Schema } from '../actions/configuredActionRunProtocol.js';
import { testkitLocator, testkitSnapshot, testkitViewer } from '../corpus/testkit/observations.test-support.js';
import type { TriageActionV1 } from '../settings/actions.js';
import { createTriageEntrySessionStartController, type TriageStartHostV1 } from './entrySessionStartController.js';
import { testkitConfiguredInstance, testkitTriageActionId } from './testkit/entrySessionTestkit.test-support.js';
import { readTriageRecentSessionsV1 } from './entryStartChoices.js';

it('native Send delivers an unbound Task into the chosen workspace while preserving repository and workspace refusals', async () => {
    const entryRef = { source: INTERNAL_TASK_SOURCE_V1,
        ...internalTaskLocalRefV1('db4dac1b-d60f-42f0-980f-54a1a19d6627', 'account-a') };
    const instance = { ...testkitConfiguredInstance(), instance: {
        source: entryRef.source, sourceInstanceId: '469228ab-360b-45c2-8b89-9b7ce0505797',
    } };
    const selected = { entryRef, sourceInstanceId: instance.instance.sourceInstanceId };
    const session = { serverId: 'server-a', sessionId: 'session-a' };
    const repository = { kind: 'github', deployment: 'https://github.com', repository: 'happier-dev/triage-qa-sandbox' } as const;
    const acceptedWorkspace = { checkout: { serverId: session.serverId, workspaceId: 'workspace-a', machineId: 'machine-a', rootPath: '/workspaces/qa' }, repository };
    const action = { actionId: TRIAGE_DEFAULT_FIX_ACTION_ID_V1, label: 'Fix', enabled: true, appliesTo: ['issue'],
        profileId: null, workspaceMode: 'repository',
        target: { kind: 'agent', promptInvocationId: null, seededFallbackInstruction: 'Repair this issue.', delivery: 'compose' },
    } as const satisfies TriageActionV1;
    const request = { action, entryRef, sourceInstance: instance.instance,
        display: { locator: testkitLocator(), scopeLabel: 'Personal tasks' }, presentation: { label: 'Task context' },
        workflowSubject: 'issue' as const };
    const protocol = { id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1, version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1 };
    const handler = createTriageRunConfiguredActionHandler();

    // Candidate reads and delivery must agree on the same workspace admission.
    const pickerHost = {
        executeAction: async (_ref: unknown, input: { cursor?: string }) => input.cursor === 'next' ? ({ sessions: [
            { id: 'eligible', serverId: session.serverId, updatedAt: 1 },
        ], hasNext: false }) : ({ sessions: [
            { id: 'wrong-repository', serverId: session.serverId, updatedAt: 2 },
            { id: 'workspace-less', serverId: session.serverId, updatedAt: 3 },
        ], hasNext: true, nextCursor: 'next' }),
        readSession: async (id: string) => ({ sessionId: id, serverId: session.serverId,
            ...(id === 'workspace-less' ? {} : { acceptedWorkspace: id === 'eligible' ? acceptedWorkspace
                : { ...acceptedWorkspace, repository: { ...repository, repository: 'another/repository' } } }) }),
    };
    for (const bound of [false, true]) {
        const recipients = await readTriageRecentSessionsV1(pickerHost as unknown as TriageStartHostV1, true,
            { eligibility: { action, ...(bound ? { repository } : {}) }, allPages: true });
        expect(recipients).toMatchObject({ status: 'ready', items: bound
            ? [{ id: 'eligible' }] : [{ id: 'wrong-repository' }, { id: 'eligible' }] });
        if (recipients.status === 'ready') expect(recipients.items).toHaveLength(bound ? 1 : 2);
    }

    // Only host RPC transports are substituted. Native operand construction,
    // registered handler, workspace admission, orchestration and delivery are real.
    for (const mode of ['native', 'prepared'] as const) {
        for (const scenario of ['unbound', 'matching', 'mismatch', 'workspaceMissing', 'noInstruction'] as const) {
            const sent: JsonValue[] = [];
            const host = {
                version: () => ({ methods: [] }),
                context: async () => ({ targetedContributions: {
                    target: { pluginId: 'happier.triage', immutableGenerationId: 'triage-1' },
                    points: [{ pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, protocols: [{ protocol, contributions: [{
                        contributor: { pluginId: entryRef.source.pluginId, contributionId: entryRef.source.localId, immutableGenerationId: 'source-1' },
                        protocol, descriptor: { v: 1, purpose: 'triage-source', displayName: 'Happier tasks',
                            kinds: [{ id: 'task', displayName: 'Task', workflowSubject: 'issue' }] }, operations: [], surfaces: [],
                    }] }] }],
                } }),
                readSession: async () => ({ ...session,
                    ...(scenario === 'workspaceMissing' ? {} : { acceptedWorkspace }) }),
                selectActionInput: async (payload: unknown) => {
                    const parsed = PluginUiSelectActionInputRequestV1Schema.parse(payload);
                    expect(parsed).toMatchObject({ sessionCandidates: [session] });
                    return { kind: 'sessionAddress', session };
                },
                executeAction: async (ref: unknown, input: JsonValue) => {
                    const id = testkitTriageActionId(ref);
                    if (id === 'session.list') return { sessions: [{ id: session.sessionId, serverId: session.serverId, updatedAt: 1 }], hasNext: false };
                    if (id === 'sessions/run-configured-v1') return await handler(TriageRunConfiguredActionInputV1Schema.parse(input), context);
                    if (id === 'actions/read-v1') {
                        const { seededFallbackInstruction: _instruction, ...instructionless } = action.target;
                        return { v: 1, availability: 'parsed', revision: '1', actions: [scenario === 'noInstruction'
                            ? { ...action, target: instructionless } : action] };
                    }
                    if (id === 'entries/reobserve-v1') return { kind: 'observed', entryRef, observation: {
                        sourceInstanceId: selected.sourceInstanceId, observedAtMs: 1,
                        outcome: { kind: 'present', locator: testkitLocator(), snapshot: testkitSnapshot({ title: 'Send this Task' }), viewer: testkitViewer(),
                            ...(scenario === 'matching' ? { repository } : scenario === 'mismatch'
                                ? { repository: { ...repository, repository: 'another/repository' } } : {}) },
                    } };
                    if (id === 'entries/read-detail-v1') return { kind: 'read', instance, linkedSessions: [] };
                    if (id === 'sessions/link-entry-v1') return { v: 1, status: 'linked' };
                    if (id === 'session.message.send') {
                        PLUGIN_ACTION_INPUT_SCHEMAS['session.message.send'].parse(input);
                        sent.push(input);
                        return { status: 'accepted', localId: 'native-task-input' };
                    }
                    throw new Error(`Unexpected host RPC ${id}`);
                },
            };
            const context = { ui: host, signal: new AbortController().signal,
                sessionTargetsV1: { targets: [session] } } as unknown as PluginAccountActionContext & { ui: PluginClientActionUi };
            const owner = createTriageEntrySessionStartController(host as unknown as TriageStartHostV1);
            try {
                const result = mode === 'native' ? await owner.getSnapshot().startInSession(request, session)
                    : await (async () => {
                        const find = scenario === 'unbound' || scenario === 'matching';
                        const prepared = await owner.getSnapshot().prepareAction(find ? {
                            ...request, destinationChoice: 'existingSession', ...(scenario === 'matching' ? { repository } : {}),
                        } : request, { signal: context.signal }, find ? undefined : session);
                        expect(prepared).not.toBeNull();
                        return await handler(TriageRunConfiguredActionInputV1Schema.parse(prepared?.input), context);
                    })();
                if (scenario === 'noInstruction') {
                    expect(result).toMatchObject({ handoff: { kind: 'unavailable', reason: 'configuredActionUnavailable' } });
                    expect(sent).toEqual([]);
                } else if (scenario === 'mismatch' || scenario === 'workspaceMissing') {
                    expect(result, `${mode}/${scenario}`).toMatchObject({ handoff: scenario === 'mismatch'
                        ? { kind: 'unavailable', reason: 'repositoryMismatch' }
                        : { kind: 'unavailable', reason: 'targetUnavailable', detail: { reason: 'existing_session_workspace_missing' } } });
                    expect(sent).toEqual([]);
                } else {
                    expect(result, `${mode}/${scenario}: ${JSON.stringify(result ?? owner.getSnapshot().phase)}`).toMatchObject({ handoff: { kind: 'sendResult', session,
                        result: { status: 'accepted' } } });
                    expect(sent).toHaveLength(1);
                    expect(sent[0]).toMatchObject({ sessionId: session.sessionId, message: 'Repair this issue.' });
                    expect(JSON.stringify(sent[0])).toContain(entryRef.entryId);
                }
            } finally { owner.dispose(); }
        }
    }
});
