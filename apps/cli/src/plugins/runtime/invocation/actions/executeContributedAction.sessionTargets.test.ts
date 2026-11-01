import { afterEach, describe, expect, it, vi } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { createActionExecutor, formatQualifiedPluginActionId, normalizeActionsSettingsV1, type ActionExecutorContext, type ActionExecutorDeps } from '@happier-dev/protocol';
import { ActionDiscoveryDefinitionSummaryV1Schema } from '@happier-dev/protocol/actions/actionDefinitionV1';
import { markSessionListQueryResultV1 } from '@happier-dev/protocol/sessions/awareness/action';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { projectSessionSummaryV1 } from '@happier-dev/protocol/sessions/control/listResult';
import { TargetActionApprovalRequestV1Schema, type TargetActionApprovalRequestV1 } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { admitTargetActionApprovalTransition } from '@happier-dev/protocol/approvals/targetActionApprovalRequestTransition';

import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { buildPluginProjectionV2 } from '@/plugins/projection/registry/projection/v2';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { tryAcquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createTargetActionCurrentIntentAdapter } from '@/session/actions/approvals/targetActionCurrentIntent';
import { createDaemonExternalActionContributedApprovalReplay } from '@/daemon/externalActions/createDaemonExternalActionContributedInvoker';
import { configuration } from '@/configuration';
import { createCommittedContributedActionDefinitionLister, createCommittedContributedActionInvoker, createCommittedContributedActionSchemaReader } from './createCommittedContributedActionDeps';
import type { TargetActionCurrentIntentRequest } from '../actionExecutor';

// Credential storage is an OS boundary; declarations, admission, SDK activation,
// committed registration, target resolution and handler validation remain real.
vi.mock('@/persistence', async original => ({ ...await original<typeof import('@/persistence')>(), readStoredCredentials: async () => null }));
afterEach(() => vi.unstubAllEnvs());

const pluginId = 'example.session-targets';
const action = { pluginId, localId: 'inspect' };
const qualifiedId = formatQualifiedPluginActionId(action);
const homeId = configuration.activeServerId;
const context: ActionExecutorContext = { surface: 'cli', serverId: homeId, serverIdentityId: 'srv_home',
    defaultSessionId: 'parent', defaultSessionMachineId: 'machine', authority: 'present_user',
    actionCaller: { kind: 'host' }, actionRequestId: 'external-target-test', actionsSettings: normalizeActionsSettingsV1({ v: 1 }) };

async function harness(durableApproval = false) {
    vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'never');
    vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', '');
    let workers = ['a'];
    const effects: unknown[] = [];
    const reads: string[] = [];
    const listReads: string[] = [];
    const approvals: TargetActionCurrentIntentRequest[] = [];
    let storedApproval: TargetActionApprovalRequestV1 | null = null;
    // Substitute only the Artifact persistence boundary. Real approval subject
    // construction, transition admission, decision and replay stay composed.
    const updateApproval = async ({ request }: { request: TargetActionApprovalRequestV1 }) => {
        if (!storedApproval) throw new Error('Missing fixture approval');
        const admission = admitTargetActionApprovalTransition(storedApproval, request);
        if (!admission.ok) return admission;
        storedApproval = TargetActionApprovalRequestV1Schema.parse(request);
        return { ok: true as const };
    };
    const durableIntent = createTargetActionCurrentIntentAdapter({
        create: async request => { storedApproval = TargetActionApprovalRequestV1Schema.parse(request); return { artifactId: 'external-target-approval' }; },
        read: async () => storedApproval, update: updateApproval,
    });
    // Authored JSON Schema `required` lists are mutable arrays in the SDK contract.
    const sessionIdSchema = () => ({ type: 'object' as const, properties: { sessionId: { type: 'string' as const } },
        required: ['sessionId'], additionalProperties: false });
    const declaration = { scopes: ['global'] as const, surfaces: ['cli', 'mcp', 'agent'] as const,
        sessionTarget: { field: 'sessionId', cardinality: 'one' } as const,
        inputSchema: sessionIdSchema(), resultSchema: sessionIdSchema(),
    };
    const plugin = definePlugin({ id: pluginId, version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
        actions: { inspect: { ...declaration, title: 'Inspect selected Session', dangerLevel: 'safe',
            run: async input => { effects.push(input); return input; },
        }, change: { ...declaration, title: 'Change selected Session', dangerLevel: 'writesLocal',
            confirmation: { title: 'Change selected Session', confirmLabel: 'Change' },
            run: async input => { effects.push(input); return input; },
        } },
    });
    const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ plugins: [{ manifest: plugin.manifest,
        files: { 'daemon.mjs': 'export function activate() {}' }, instantiateCommittedModule: () => ({ activate: plugin.activate }) }],
        async resolveContributes(happyHomeDir) { return createResolvedContributionRegistry(projectLoadedPluginContributes({
            loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external' })); },
        runtimeOptions: { resolveCurrentMachineId: () => 'machine',
            resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'srv_home', machineId: 'machine' }) },
    });
    const list = createCommittedContributedActionDefinitionLister({ tryAcquireRuntimeRegistryLease: () =>
        tryAcquireAuthoritativePluginRuntimeRegistryLease({ controller: fixture.controller }) });
    const deps: ActionExecutorDeps = { ...createUnavailableActionTransportDeps(),
        listContributedActionDefinitions: list, readContributedActionSchemas: createCommittedContributedActionSchemaReader(list),
        invokeContributedAction: createCommittedContributedActionInvoker({ acquireRuntimeRegistryLease: () => fixture.controller.acquireRuntimeRegistry(),
            requestCurrentIntent: async request => { approvals.push(request);
                if (durableApproval) return durableIntent(request);
                workers = ['replacement'];
                return { status: 'approved', fingerprint: request.fingerprint }; },
        }),
        resolveSessionReference: async request => { reads.push(request.actionId ?? 'missing-root');
            return { kind: 'unique', address: { serverId: homeId, sessionId: request.sessionId! } }; },
        sessionList: async ({ query }) => { listReads.push(query!.storage); return markSessionListQueryResultV1({
            sessions: ['parent', ...workers].map(id => projectSessionSummaryV1({
                row: { id, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
                    ...(id === 'parent' ? {} : { manager: { sessionId: query!.underSessionId! } }) },
                metadata: null, encryption: null,
            })),
            nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
        }); },
    };
    return { fixture, deps, list, effects, reads, listReads, approvals, updateApproval,
        readApproval: () => storedApproval,
        executor: createActionExecutor(deps), setWorkers: (ids: string[]) => { workers = ids; } };
}

describe('external authored Action SessionTarget parity', () => {
    it('advertises the authored operand through strict discovery and the same read-only inspection front door', async () => {
        const h = await harness();
        try {
            const projection = PluginProjectionV2Schema.parse(buildPluginProjectionV2({ registry: h.fixture.registry.contributes, generation: 1 }));
            expect(projection.actionsById[`${pluginId}/inspect`])
                .toMatchObject({ sessionTarget: { field: 'sessionId', cardinality: 'one' } });
            expect(h.list().find(definition => definition.id === qualifiedId))
                .toMatchObject({ sessionTarget: { field: 'sessionId', cardinality: 'one' } });
            const discovery = await h.executor.execute('action.spec.search', { query: qualifiedId }, context);
            expect(discovery).toMatchObject({ ok: true, result: { actionSpecs: expect.arrayContaining([expect.objectContaining({ id: qualifiedId })]) } });
            if (!discovery.ok) throw new Error('Expected discovery');
            const result = discovery.result as { actionSpecs: unknown[] };
            expect(result.actionSpecs.map(value => ActionDiscoveryDefinitionSummaryV1Schema.parse(value)).find(definition => definition.id === qualifiedId))
                .toMatchObject({ sessionTarget: { field: 'sessionId', cardinality: 'one' } });
            expect(await h.executor.execute('action.spec.get', { id: qualifiedId }, context))
                .toMatchObject({ ok: true, result: { actionSpec: { sessionTarget: { field: 'sessionId', cardinality: 'one' } } } });
            expect(await h.executor.execute('session.targets.resolve', { actionId: qualifiedId, target: { selector: 'workers' } }, context))
                .toMatchObject({ ok: true, result: { coverage: 'complete', addresses: [{ serverId: homeId, sessionId: 'a' }] } });
            expect(h.effects).toEqual([]);
        } finally { await h.fixture.dispose(); }
    });

    it('resolves selectors before the real exact-string input parser and preserves exact ids', async () => {
        const h = await harness();
        try {
            for (const [target, expected] of [[{ selector: 'self' }, 'parent'], [{ selector: 'workers' }, 'a'], ['exact', 'exact']] as const) {
                expect(await h.executor.execute('action.invoke', { action, input: { sessionId: target } }, context))
                    .toEqual({ ok: true, result: { sessionId: expected } });
            }
            expect(h.effects).toEqual([{ sessionId: 'parent' }, { sessionId: 'a' }, { sessionId: 'exact' }]);
            expect(h.reads).toHaveLength(2);
            expect(h.listReads.sort()).toEqual(['active', 'archived']);
            expect(h.reads.every(root => root === 'action.invoke')).toBe(true);
        } finally { await h.fixture.dispose(); }
    });

    it('refuses cardinality and foreign-root selectors before entering the external handler', async () => {
        const h = await harness();
        try {
            h.setWorkers(['a', 'b']);
            expect(await h.executor.execute('action.invoke', { action, input: { sessionId: { selector: 'workers' } } }, context))
                .toMatchObject({ ok: false, errorCode: 'session_target_cardinality_mismatch' });
            const caller = { kind: 'session', sessionId: 'parent', starterDepth: 0, turnDepth: 0 } as const;
            const restricted: ActionExecutorContext = { ...context, surface: 'agent', authority: 'account_automation', sessionListAccess: 'current_session', actionCaller: caller,
                agentStartContext: { caller, baseline: { machineId: 'machine', directory: '/repo' }, roles: {},
                    ledSubtreeSessionIds: [], workDepthLimit: 4, callerPermissionCeiling: 'default' } };
            expect(await h.executor.execute('action.invoke', { action, input: { sessionId: { selector: 'self', of: 'outside' } } }, restricted))
                .toMatchObject({ ok: false, errorCode: 'session_target_unavailable' });
            expect(h.effects).toEqual([]);
            h.setWorkers(['a']);
            expect(await h.executor.execute('action.invoke', { action, input: { sessionId: { selector: 'workers' } } }, restricted))
                .toEqual({ ok: true, result: { sessionId: 'a' } });
            expect(await h.executor.execute('action.invoke', { action, input: { sessionId: 'a' } }, restricted))
                .toEqual({ ok: true, result: { sessionId: 'a' } });
            expect(await h.executor.execute('action.invoke', { action: { pluginId, localId: 'change' }, input: { sessionId: { selector: 'workers' } } }, restricted))
                .toMatchObject({ ok: false });
            expect(h.approvals).toEqual([]);
        } finally { await h.fixture.dispose(); }
    });

    it('retains the concrete target in contributed approval custody when membership changes during review', async () => {
        const h = await harness();
        try {
            expect(await h.executor.execute('action.invoke', { action: { pluginId, localId: 'change' }, input: { sessionId: { selector: 'workers' } } }, context))
                .toEqual({ ok: true, result: { sessionId: 'a' } });
            expect(h.approvals).toHaveLength(1);
            expect(h.approvals[0]).toMatchObject({ action: { input: { sessionId: 'a' } },
                replayPlacement: { machineId: 'machine', defaultSessionId: 'parent' },
                executionOriginV1: { actionId: 'action.invoke', requestId: context.actionRequestId } });
            expect(h.effects).toEqual([{ sessionId: 'a' }]);
            expect(h.listReads.sort()).toEqual(['active', 'archived']);
        } finally { await h.fixture.dispose(); }
    });

    it('keeps an Account-readable matching result outside the restricted caller subtree out of the handler', async () => {
        const h = await harness();
        try {
            const caller = { kind: 'session', sessionId: 'parent', starterDepth: 0, turnDepth: 0 } as const;
            const restricted: ActionExecutorContext = { ...context, surface: 'agent', authority: 'account_automation', sessionListAccess: 'current_session', actionCaller: caller,
                agentStartContext: { caller, baseline: { machineId: 'machine', directory: '/repo' }, roles: {},
                    ledSubtreeSessionIds: [], workDepthLimit: 4, callerPermissionCeiling: 'default' } };
            const executor = createActionExecutor({ ...h.deps, sessionFollowPreview: async () => ({ coverage: 'complete', matchCount: 1,
                matches: [{ serverId: homeId, source: { kind: 'session', sessionId: 'outside' } }], unavailable: [], overlaps: [] }) });
            expect(await executor.execute('action.invoke', { action, input: { sessionId: {
                selector: 'matching', filter: normalizeSessionListFilterV1({}),
            } } }, restricted)).toMatchObject({ ok: false });
            expect(h.effects).toEqual([]);
        } finally { await h.fixture.dispose(); }
    });

    it('replays a real retained approval against the concrete selection after worker membership changes', async () => {
        const h = await harness(true);
        try {
            const created = await h.executor.execute('action.invoke', { action: { pluginId, localId: 'change' }, input: { sessionId: { selector: 'workers' } } }, context);
            expect(created, JSON.stringify(created))
                .toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'external-target-approval' } });
            expect(h.readApproval()).toMatchObject({ status: 'open', input: { sessionId: 'a' } });
            expect(h.effects).toEqual([]);
            h.setWorkers(['replacement']);
            const replay = createDaemonExternalActionContributedApprovalReplay({
                credentials: { token: 'external-target-fixture', encryption: null },
                // Current Home/credential identity is an external authority port.
                isApprovalExecutionOriginCurrent: async ({ origin }) => origin.serverId === context.serverId,
                acquireRuntimeRegistryLease: () => h.fixture.controller.acquireRuntimeRegistry(),
                targetActionApprovals: { targetActionApprovalsGet: async () => h.readApproval(), targetActionApprovalsUpdate: h.updateApproval },
            });
            const executor = createActionExecutor({ ...h.deps, targetActionApprovalReplay: replay });
            expect(await executor.execute('approval.request.decide', { artifactId: 'external-target-approval', decision: 'approve' }, context))
                .toMatchObject({ ok: true });
            expect(h.readApproval()).toMatchObject({ status: 'executed', input: { sessionId: 'a' }, execution: { ok: true } });
            expect(h.effects).toEqual([{ sessionId: 'a' }]);
            expect(h.listReads.sort()).toEqual(['active', 'archived']);
        } finally { await h.fixture.dispose(); }
    });

});
