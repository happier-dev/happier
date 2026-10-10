import { describe, expect, it, vi } from 'vitest';
import {
    ApiTokenGrantV1Schema,
    AutomationRunCauseSchema,
    StrictJsonValueSchema,
    createActionExecutor,
    normalizeActionsSettingsV1,
    type ActionExecutorContext,
    type ActionExecutorDeps,
} from '@happier-dev/protocol';
import { NO_TEAM_CAPABILITIES_V1 } from '@happier-dev/protocol/teams';
import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';

import { createBrowserDaemonRuntimeActionExecutor } from '@/daemon/browser/actions/runtimeActionExecutor';
import { createBrowserDaemonControlBroker } from '@/daemon/browser/control/broker';
import { createBrowserDaemonControlRoutes } from '@/daemon/browser/control/routes';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';

import {
    createPluginInvocationActionsService,
    type ContributedActionInvocationResult,
    type InvokeContributedAction,
} from './actions';
import { createPluginActionCallerMaterializationFixture } from './actionCaller.testkit';
import { createProductionPluginInvocationServiceOwners } from './production';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { createCommittedContributedActionInvoker } from '../actions/createCommittedContributedActionDeps';
import { createTargetActionInvocationRegistry } from '../targetActionRegistry';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { ResolvedActionContribution } from '@/plugins/projection/registry/types';
import { createWorkflowAccountRunActionOwner, type WorkflowAccountRunActionDeps } from '@happier-dev/protocol/actions';
import {
    WorkflowRunSummaryV1Schema,
    WorkflowRunStartRequestV1Schema,
    openWorkflowAcceptedSnapshotStoredEnvelopeV1,
    parseWorkflowStoredContentEnvelopeV1,
} from '@happier-dev/protocol';

type TestActionExecutorOverrides = Partial<Pick<
    ActionExecutorDeps,
    'pluginPermissionGrantAction'
    | 'sessionPermissionRespond'
    | 'sessionUserActionAnswer'
    | 'pluginWebhookAction'
    | 'sessionList'
>>;

function createActionExecutorForTest(overrides: TestActionExecutorOverrides = {}) {
    const deps: ActionExecutorDeps = {
        executionRunStart: async () => ({}),
        executionRunList: async () => ({}),
        executionRunGet: async () => ({}),
        detachedExecutionRunSend: async () => ({}),
        executionRunStop: async () => ({}),
        executionRunAction: async () => ({}),
        executionRunWait: async () => ({}),
        sessionOpen: async () => ({}),
        sessionFork: async () => ({}),
        sessionRollback: async () => ({}),
        sessionSpawnNew: async () => ({}),
        pathsListRecent: async () => ({ items: [] }),
        machinesList: async () => ({ items: [] }),
        serversList: async () => ({ items: [] }),
        reviewEnginesList: async () => ({ items: [] }),
        agentsBackendsList: async () => ({ items: [] }),
        agentsModelsList: async () => ({ items: [] }),
        sessionSendMessage: async () => ({}),
        sessionModeSet: async () => ({}),
        sessionModesList: async () => ({ items: [] }),
        sessionTargetPrimarySet: async () => ({}),
        sessionTargetTrackedSet: async () => ({
            ok: true as const,
            status: 'ok' as const,
            sessionIds: [],
            sessionAddresses: [],
            sessions: [],
        }),
        sessionList: async () => ({ sessions: [] }),
        sessionActivityGet: async () => ({}),
        sessionRecentMessagesGet: async () => ({}),
        daemonMemorySearch: async () => ({ v: 1, ok: true, hits: [] }),
        daemonMemoryGetWindow: async () => ({ v: 1, snippets: [], citations: [] }),
        daemonMemoryEnsureUpToDate: async () => ({}),
        resetGlobalVoiceAgent: async () => {},
        isActionApprovalRequired: () => false,
        ...overrides,
    };
    return createActionExecutor(deps);
}

function createPermissionActionExecutor(
    pluginPermissionGrantAction: NonNullable<ActionExecutorDeps['pluginPermissionGrantAction']>,
) {
    return createActionExecutorForTest({ pluginPermissionGrantAction });
}

/**
 * The host stamps a closed `ActionCaller` union; only the plugin arm carries a
 * plugin id. Narrowing here keeps the assertion discriminating: a caller
 * stamped as any other kind reads as `null` instead of silently matching.
 */
function readPluginCallerId(context: ActionExecutorContext | undefined): string | null {
    const caller = context?.actionCaller;
    return caller?.kind === 'plugin' ? caller.pluginId : null;
}

describe('plugin invocation ActionsService', () => {
    it.each([
        { name: 'autonomous background', initiatingActionCaller: undefined, startedBy: 'trigger' },
        { name: 'host', initiatingActionCaller: { kind: 'host' }, startedBy: 'user' },
        { name: 'Session agent', initiatingActionCaller: { kind: 'session', sessionId: 'session-origin', starterDepth: 1, turnDepth: 2 }, startedBy: 'agent' },
        { name: 'nested host', initiatingActionCaller: { kind: 'plugin', pluginId: 'acme.outer', initiatingCaller: { kind: 'host' } }, startedBy: 'user' },
        { name: 'nested Session agent', initiatingActionCaller: { kind: 'plugin', pluginId: 'acme.outer', initiatingCaller: { kind: 'session', sessionId: 'session-origin', starterDepth: 1, turnDepth: 2 } }, startedBy: 'agent' },
        { name: 'manual automation', initiatingActionCaller: { kind: 'automationRun', runId: 'automation-run', automationId: 'automation-1', cause: { kind: 'manual', invokedAt: 1 } }, startedBy: 'user' },
        { name: 'scheduled automation overrides host', initiatingActionCaller: { kind: 'host' },
            transportStartedBy: 'user',
            automationCaller: { kind: 'automationRun', runId: 'automation-run', automationId: 'automation-1',
                cause: AutomationRunCauseSchema.parse({ kind: 'trigger', triggerId: 'trigger-1', triggerRevision: 1, triggerKind: 'schedule',
                    occurrenceKey: 'A'.repeat(43), occurredAt: 1, evidence: { scheduledFor: 1 } }) }, startedBy: 'trigger' },
        { name: 'Workflow', initiatingActionCaller: { kind: 'workflowRun', runId: 'workflow-origin', authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' } }, startedBy: 'agent' },
        { name: 'committed host', initiatingActionCaller: { kind: 'host' }, startedBy: 'user', viaCommitted: true },
        { name: 'committed Session agent', initiatingActionCaller: { kind: 'session', sessionId: 'session-origin', starterDepth: 1, turnDepth: 2 }, startedBy: 'agent', viaCommitted: true },
        { name: 'committed Workflow', initiatingActionCaller: { kind: 'workflowRun', runId: 'workflow-origin', authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' } }, startedBy: 'agent', viaCommitted: true },
    ] as const)('freezes $name starter through the real host Actions service without changing plugin authority', async (scenario) => {
        const runId = '99999999-9999-4999-8999-999999999999';
        let acceptedEnvelope: string | undefined;
        const run = WorkflowRunSummaryV1Schema.parse({ id: runId, sourceArtifactId: null,
            ownerAccountId: 'account-1', visibleTeamId: null, origin: { kind: 'direct' }, state: 'queued', revision: 0,
            machineId: 'machine-1', workflowCustodyState: 'pending', originDeliveryAckRevision: null,
            availability: { pause: true, resumeBoundary: false, restoreWorkspace: false, cancel: true, inspectExecution: false, disabledReasons: [] },
            createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
        const deps: WorkflowAccountRunActionDeps = {
            resolveAccountId: async () => 'account-1',
            storage: { execute: async operation => {
                if (operation.operation === 'get') throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
                if (operation.operation !== 'admit') throw new Error('unexpected_storage_operation');
                acceptedEnvelope = String(operation.acceptedEnvelope);
                return { kind: 'created', run };
            } },
            definitions: { get: async () => { throw new Error('inline_definition_only'); } },
            resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
            normalizeAbsolutePath: directory => directory.startsWith('/') ? directory : null,
            randomBytes: () => { throw new Error('plain_account_does_not_need_keys'); },
            prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } } }),
            resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true } }),
        };
        const owner = createWorkflowAccountRunActionOwner(deps);
        const seed = Object.assign({
            plugin: { id: 'acme.background', version: '1.0.0' },
            contribution: { id: 'job', qualifiedId: 'acme.background/backgroundServices/job' },
            occurrenceId: 'background-1', sourceCustody: { kind: 'development' as const, registeredRootId: 'background-root' },
            surface: 'background' as const, signal: new AbortController().signal, isOccurrenceCurrent: () => true,
        }, scenario.initiatingActionCaller === undefined ? {} : { initiatingActionCaller: scenario.initiatingActionCaller },
        'transportStartedBy' in scenario ? { startedBy: scenario.transportStartedBy } : {},
        'automationCaller' in scenario ? { caller: scenario.automationCaller } : {});
        const actionExecutor = {
            // The daemon's Account host supplies target and permission authority; storage above is the external boundary.
            execute: async (actionId, input, context) => {
                if (actionId !== 'workflow.run.start') throw new Error('unexpected_host_action');
                const result = await owner.execute({ actionId, input: WorkflowRunStartRequestV1Schema.parse(input),
                    context: { ...context, callerPermissionMode: 'default',
                        externalActionTarget: { kind: 'machine', machineId: 'machine-1', project: { machineId: 'machine-1', directory: '/repo' } } } });
                return { ok: true, result };
            },
        } satisfies import('./actions').PluginActionsHostExecutor;
        let runtime: ResolvedExecutablePluginRuntimeRegistry | undefined;
        // Loading/acquiring the process registry is the system boundary; the committed dispatcher remains real.
        const invoke = createCommittedContributedActionInvoker({ acquireRuntimeRegistryLease: async () => {
            if (!runtime) throw new Error('runtime_registry_not_loaded');
            return { registry: runtime, source: 'ephemeral', durableRevision: -1, release: async () => {} };
        } });
        const invokeContributedAction: InvokeContributedAction = async request => {
            const result = await invoke({ action: request.action, input: request.input,
                context: { surface: request.surface, actionCaller: request.initiatingActionCaller,
                    defaultSessionId: request.sessionId }, signal: request.signal });
            return result.ok
                ? { status: 'executed', value: StrictJsonValueSchema.parse(result.result) }
                : { status: 'failed', code: result.errorCode, message: result.error };
        };
        const service = createPluginInvocationActionsService({ seed, actionExecutor, invokeContributedAction });
        const startInput = { runId, source: { kind: 'inline' as const, definition: {
            version: 1 as const, blocks: [{ kind: 'wait', id: 'wait', document: { text: 'Review', references: [], attachments: [] } }],
        } } };
        if (!('viaCommitted' in scenario)) {
            await service.execute('workflow.run.start', startInput);
            const opened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
            binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId },
            envelope: parseWorkflowStoredContentEnvelopeV1(acceptedEnvelope) });
            expect(opened).toMatchObject({ kind: 'available', content: {
            startedBy: scenario.startedBy,
            authorization: { principal: { kind: 'plugin', pluginId: 'acme.background', contributionLocalId: 'job',
                sourceCustody: { kind: 'development', registeredRootId: 'background-root' } } },
            } });
            return;
        }
        const services = createProductionPluginInvocationServiceOwners({ actionExecutor, invokeContributedAction });
        const targetOccurrenceId = createPluginRuntimeOccurrenceId('acme.background');
        const targetActionInvocations = createTargetActionInvocationRegistry({
            actions: [{ pluginId: 'acme.background', pluginVersion: '1.0.0', occurrenceId: targetOccurrenceId,
                sourceCustody: { kind: 'development', registeredRootId: 'background-root' }, localId: 'start',
                definition: { id: 'start', dangerLevel: 'safe', scopes: ['global'], surfaces: ['cli'], inputSchema: { type: 'object' }, resultSchema: {} },
                handler: async (_input, context) => {
                    expect(Object.prototype.hasOwnProperty.call(context, 'initiatingActionCaller')).toBe(false);
                    await context.services.actions.execute('workflow.run.start', startInput);
                    return null;
                },
            }],
            resolveAuthorizationFacts: target => ({ generation: { targetGeneration: target.occurrenceId,
                desiredGeneration: target.occurrenceId, appliedGeneration: target.occurrenceId },
                resourceSelections: [], scopedGrants: [], operatingSystemAuthorization: [] }),
            createServices: services.createServices, resolveHostBinding: services.resolveHostBinding,
            readCurrentPluginOccurrenceId: pluginId => pluginId === 'acme.background' ? targetOccurrenceId : null,
        });
        // The process registry lookup/lease is the system boundary; target admission and service construction remain real.
        const contribution = { pluginId: 'acme.background', definition: { id: 'start', surfaces: { cli: true } } } as unknown as ResolvedActionContribution;
        runtime = { contributes: { actionsById: new Map([['acme.background/start', contribution]]) }, targetActionInvocations } as unknown as ResolvedExecutablePluginRuntimeRegistry;
        const admittedContext = { surface: 'cli' as const, actionCaller: scenario.initiatingActionCaller };
        const admitted = await invoke({ action: { pluginId: 'acme.background', localId: 'start' }, input: {}, context: admittedContext });
        expect(admitted, JSON.stringify(admitted)).toMatchObject({ ok: true });
        const nested = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
            binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId },
            envelope: parseWorkflowStoredContentEnvelopeV1(acceptedEnvelope) });
        expect(nested).toMatchObject({ kind: 'available', content: { startedBy: scenario.startedBy,
            authorization: { principal: { kind: 'plugin', pluginId: 'acme.background', contributionLocalId: 'start' } } } });
        targetActionInvocations.dispose();
        await services.dispose();
    });
    it('preserves host-private external PAT authority for a nested host Action', async () => {
        const execute = vi.fn().mockResolvedValue({
            ok: true,
            result: {
                id: 'team-1',
                name: 'Platform',
                description: null,
                logo: null,
                archivedAt: null,
                recovery: null,
                policy: {
                    v: 1,
                    sessionCreationPolicy: 'private_default',
                    externalSharingPolicy: 'allowed',
                    defaultSessionHistoryAccess: 'from_membership',
                    admissionMode: 'invite_only',
                    authenticationPolicy: null,
                    authenticationPolicyStatus: 'available',
                },
                viewerRole: 'owner',
                capabilities: NO_TEAM_CAPABILITIES_V1,
                admission: { historyChoice: { admin: 'choice', member: 'choice', guest: 'hidden' } },
                counts: null,
            },
        });
        const signExternalActionApprovalInput = vi.fn().mockReturnValue('machine-signature');
        const externalActionContext = {
            authority: 'account_automation' as const,
            serverId: 'home-profile-1',
            serverIdentityId: 'home-identity-1',
            actionRequestId: 'outer-request-1',
            externalActionCredential: {
                accountId: 'account-1', principalId: 'pat-principal-1', credentialId: 'pat-1',
                grant: ApiTokenGrantV1Schema.parse({
                    v: 1,
                    actions: { families: [], ids: ['teams.archive'] },
                    targets: null,
                    approve: false,
                    origins: [],
                    models: null,
                    permissionModes: null,
                    create: null,
                }),
            },
            externalActionExecutionAuthorization: { opaque: 'authorization' } as never,
            externalActionTarget: { kind: 'session' as const, sessionId: 'session-1' },
            signExternalActionApprovalInput,
        };
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'plugin.example', version: '1.0.0' },
                contribution: { id: 'action', qualifiedId: 'plugin.example/action' },
                occurrenceId: 'immutable-occurrenceId-1', sourceCustody: { kind: 'development', registeredRootId: 'fixture-root' },
                correlationId: 'plugin-call-1',
                surface: 'plugin',
                externalActionContext,
                resolveCurrentPluginMaterializationRef:
                    createPluginActionCallerMaterializationFixture('plugin.example')
                        .resolveCurrentPluginMaterializationRef,
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: { execute },
            invokeContributedAction: vi.fn(),
        });

        await service.execute('teams.archive', { v: 1, teamId: 'team-1' });

        expect(execute).toHaveBeenCalledWith(
            'teams.archive',
            { v: 1, teamId: 'team-1' },
            expect.objectContaining({
                ...externalActionContext,
                surface: 'plugin',
                authority: 'account_automation',
                actionCaller: expect.objectContaining({ kind: 'plugin', pluginId: 'plugin.example' }),
            }),
        );
    });
    it('returns a Lane 01 approval deferral as typed admitted data instead of rejecting it as a malformed Team result', async () => {
        const pluginId = 'acme.external-home-admin';
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: pluginId, version: '1.0.0' },
                resolveCurrentPluginMaterializationRef:
                    createPluginActionCallerMaterializationFixture(pluginId)
                        .resolveCurrentPluginMaterializationRef,
                contribution: { id: 'archive-team', qualifiedId: `${pluginId}/actions/archive-team` },
                occurrenceId: 'external-home-admin-occurrenceId', sourceCustody: { kind: 'development', registeredRootId: 'fixture-root' },
                correlationId: 'external-home-admin-archive',
                surface: 'background',
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: {
                execute: vi.fn(async () => ({
                    ok: true as const,
                    result: {
                        kind: 'approval_request_created' as const,
                        artifactId: 'approval-1',
                        actionId: 'teams.archive',
                    },
                })),
            },
            invokeContributedAction: vi.fn(),
        });

        await expect(service.execute('teams.archive', {
            v: 1,
            teamId: 'team-1',
        })).resolves.toEqual({
            kind: 'approval_request_created',
            artifactId: 'approval-1',
            actionId: 'teams.archive',
        });
    });

    it.each([
        'update_required',
        'outcome_unknown',
        'cancelled',
        'server_unreachable',
    ] as const)('preserves the typed Lane 01 %s settlement for plugin callers', async (errorCode) => {
        const pluginId = 'acme.external-home-admin';
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: pluginId, version: '1.0.0' },
                resolveCurrentPluginMaterializationRef:
                    createPluginActionCallerMaterializationFixture(pluginId)
                        .resolveCurrentPluginMaterializationRef,
                contribution: { id: 'archive-team', qualifiedId: `${pluginId}/actions/archive-team` },
                occurrenceId: 'external-home-admin-occurrenceId', sourceCustody: { kind: 'development', registeredRootId: 'fixture-root' },
                correlationId: `external-home-admin-${errorCode}`,
                surface: 'background',
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: {
                execute: vi.fn(async () => ({ ok: false as const, errorCode, error: errorCode })),
            },
            invokeContributedAction: vi.fn(),
        });

        await expect(service.execute('teams.archive', {
            v: 1,
            teamId: 'team-1',
        })).rejects.toMatchObject({ name: 'PluginError', code: errorCode });
    });

    it('gives bundled and trusted external installed plugins the same Lane 01 governance Action contract', async () => {
        const result = {
            id: 'team-1',
            name: 'Platform',
            description: null,
            logo: null,
            archivedAt: null,
            recovery: null,
            policy: {
                v: 1 as const,
                sessionCreationPolicy: 'private_default' as const,
                externalSharingPolicy: 'allowed' as const,
                defaultSessionHistoryAccess: 'from_membership' as const,
                admissionMode: 'invite_only' as const,
                authenticationPolicy: null,
                authenticationPolicyStatus: 'available' as const,
            },
            viewerRole: 'owner' as const,
            capabilities: NO_TEAM_CAPABILITIES_V1,
            admission: { historyChoice: { admin: 'choice' as const, member: 'choice' as const, guest: 'hidden' as const } },
            counts: null,
        };
        const execute = vi.fn(async (
            _actionId: string,
            _input: unknown,
            _context?: ActionExecutorContext,
        ) => ({ ok: true as const, result }));
        const createService = (pluginId: string) => createPluginInvocationActionsService({
            seed: {
                plugin: { id: pluginId, version: '1.0.0' },
                resolveCurrentPluginMaterializationRef:
                    createPluginActionCallerMaterializationFixture(pluginId)
                        .resolveCurrentPluginMaterializationRef,
                contribution: { id: 'team-admin', qualifiedId: `${pluginId}/actions/team-admin` },
                occurrenceId: `${pluginId}-immutable-occurrenceId`, sourceCustody: { kind: 'development', registeredRootId: 'fixture-root' },
                correlationId: `${pluginId}-lane01`,
                surface: 'background',
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: { execute },
            invokeContributedAction: vi.fn(),
        });
        const input = { v: 1 as const, teamId: 'team-1' };

        for (const pluginId of ['happier.builtin', 'acme.external-installed']) {
            await expect(createService(pluginId).execute('teams.archive', input)).resolves.toEqual(result);
        }
        expect(execute.mock.calls.map((call) => readPluginCallerId(call[2]))).toEqual([
            'happier.builtin',
            'acme.external-installed',
        ]);
        for (const call of execute.mock.calls) {
            expect(call[0]).toBe('teams.archive');
            expect(call[1]).toEqual(input);
            expect(call[2]).toMatchObject({ surface: 'plugin', authority: 'account_automation' });
        }
    });

    it('dispatches every bounded Lane 03 identity handoff through the trusted external-plugin Action ABI', async () => {
        const provider = {
            v: 1 as const,
            owner: { kind: 'team' as const, teamId: 'team-1' },
            id: 'provider-1',
            kind: 'oidc' as const,
            displayName: 'Company login',
            enabled: true,
            firstEnabledAt: 1,
            securityRevision: 2,
            revision: 3,
            config: {
                v: 1 as const,
                kind: 'oidc' as const,
                issuer: 'https://id.example.test',
                clientId: 'happier',
                clientAuthenticationMethod: 'client_secret_post' as const,
                scopes: 'openid profile email',
                httpTimeoutSeconds: 30,
                claims: { login: 'preferred_username', email: 'email', groups: 'groups' },
                allow: { usersAllowlist: [], emailDomains: [], groupsAny: [], groupsAll: [] },
                fetchUserInfo: true,
                storeRefreshToken: false,
                ui: { buttonColor: null, iconHint: 'oidc' },
            },
            secret: { configured: true, health: 'configured' as const },
            lastSuccessfulTest: { at: 10, testedSecurityRevision: 2, current: true },
            createdByAccountId: 'account-1',
            createdAt: 1,
            updatedAt: 10,
            teamConsumers: [],
        };
        const connection = {
            v: 1 as const,
            id: 'connection-1',
            teamId: 'team-1',
            provider: { id: 'provider-1', kind: 'oidc' as const, displayName: 'Company login' },
            externalReference: { v: 1 as const, kind: 'oidc' as const },
            settings: {
                v: 1 as const,
                kind: 'oidc' as const,
                allowedUsers: [],
                allowedEmailDomains: [],
                groupsAny: [],
                groupsAll: [],
            },
            enabled: true,
            firstEnabledAt: 1,
            revision: 3,
            state: 'connected' as const,
            allowedActions: ['teams.identity.connections.test.start'] as const,
            lastObservation: { v: 1 as const, kind: 'oidc' as const },
            lastSuccessfulTest: { at: 10, runtimeFingerprint: 'runtime-1', current: true },
            createdAt: 1,
            updatedAt: 10,
        };
        const cases = [
            {
                id: 'identity.providers.test.start' as const,
                input: { owner: { kind: 'team' as const, teamId: 'team-1' }, id: 'provider-1', expectedRevision: 3, expectedSecurityRevision: 2 },
                result: { authorizeUrl: 'https://id.example.test/authorize', attemptId: 'attempt-provider' },
            },
            {
                id: 'identity.providers.test.consume' as const,
                input: { owner: { kind: 'team' as const, teamId: 'team-1' }, id: 'provider-1', resultHandle: 'result-provider' },
                result: { provider, testedAt: 10, subjectPresent: true as const },
            },
            {
                id: 'teams.identity.connections.test.start' as const,
                input: { v: 1 as const, teamId: 'team-1', connectionId: 'connection-1', expectedRevision: 3 },
                result: { authorizeUrl: 'https://id.example.test/authorize', attemptId: 'attempt-connection' },
            },
            {
                id: 'teams.identity.connections.test.consume' as const,
                input: { v: 1 as const, teamId: 'team-1', connectionId: 'connection-1', resultHandle: 'result-connection' },
                result: { connection },
            },
            {
                id: 'teams.identity.workos.adminPortalLink.create' as const,
                input: { v: 1 as const, teamId: 'team-1', connectionId: 'connection-1', intent: 'sso' as const },
                result: { url: 'https://setup.workos.test/portal' },
            },
        ];
        const resultByActionId = new Map<string, unknown>(cases.map((entry) => [entry.id, entry.result]));
        const execute = vi.fn(async (
            actionId: string,
            _input: unknown,
            _context?: ActionExecutorContext,
        ) => ({
            ok: true as const,
            result: resultByActionId.get(actionId),
        }));
        const pluginId = 'acme.external-installed';
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: pluginId, version: '1.0.0' },
                resolveCurrentPluginMaterializationRef:
                    createPluginActionCallerMaterializationFixture(pluginId)
                        .resolveCurrentPluginMaterializationRef,
                contribution: { id: 'identity-admin', qualifiedId: `${pluginId}/actions/identity-admin` },
                occurrenceId: 'external-identity-occurrenceId', sourceCustody: { kind: 'development', registeredRootId: 'fixture-root' },
                correlationId: 'external-identity',
                surface: 'background',
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: { execute },
            invokeContributedAction: vi.fn(),
        });

        for (const entry of cases) {
            await expect(service.execute(entry.id, entry.input)).resolves.toEqual(entry.result);
        }
        expect(execute).toHaveBeenCalledTimes(cases.length);
        for (const call of execute.mock.calls) {
            expect(call[2]).toMatchObject({
                surface: 'plugin',
                authority: 'account_automation',
                actionCaller: { kind: 'plugin', pluginId, contributionLocalId: 'identity-admin' },
            });
        }
    });

    it('gives bundled and trusted external installed plugins the same public Team removal-preview Action', async () => {
        const result = {
            v: 1 as const,
            status: 'allowed' as const,
            sourceId: 'source-1',
            sourceLabel: 'Corporate directory',
            impact: {
                teamMembershipsRemoved: 2,
                groupMembershipsRemoved: 3,
                groupContributionsRemoved: 1,
                directoryCreatedGroupsRetained: 1,
                nativeMembershipsPreserved: 4,
                nativeGroupContributionsPreserved: 2,
            },
        };
        const execute = vi.fn(async (
            _actionId: string,
            _input: unknown,
            _context?: ActionExecutorContext,
        ) => ({ ok: true as const, result }));
        const createService = (pluginId: string) => createPluginInvocationActionsService({
            seed: {
                plugin: { id: pluginId, version: '1.0.0' },
                resolveCurrentPluginMaterializationRef:
                    createPluginActionCallerMaterializationFixture(pluginId)
                        .resolveCurrentPluginMaterializationRef,
                contribution: { id: 'admin', qualifiedId: `${pluginId}/actions/admin` },
                occurrenceId: `${pluginId}-immutable-occurrenceId`, sourceCustody: { kind: 'development', registeredRootId: 'fixture-root' },
                correlationId: `${pluginId}-preview`,
                surface: 'cli',
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: { execute },
            invokeContributedAction: vi.fn(),
        });
        const input = { v: 1 as const, teamId: 'team-1', sourceId: 'source-1' };

        await expect(createService('happier.builtin').execute(
            'teams.directory.sources.remove.preview', input,
        )).resolves.toEqual(result);
        await expect(createService('acme.external-installed').execute(
            'teams.directory.sources.remove.preview', input,
        )).resolves.toEqual(result);

        expect(execute).toHaveBeenCalledTimes(2);
        for (const call of execute.mock.calls) {
            expect(call[0]).toBe('teams.directory.sources.remove.preview');
            expect(call[1]).toEqual(input);
            expect(call[2]).toMatchObject({ surface: 'plugin', authority: 'account_automation' });
        }
        expect(execute.mock.calls.map((call) => readPluginCallerId(call[2]))).toEqual([
            'happier.builtin',
            'acme.external-installed',
        ]);
    });

    it('gives bundled and trusted external installed plugins the same redacted GitHub App listing Action', async () => {
        const result = { registrations: [], installations: [] };
        const execute = vi.fn(async (
            _actionId: string,
            _input: unknown,
            _context?: ActionExecutorContext,
        ) => ({ ok: true as const, result }));
        const createService = (pluginId: string) => createPluginInvocationActionsService({
            seed: {
                plugin: { id: pluginId, version: '1.0.0' },
                resolveCurrentPluginMaterializationRef:
                    createPluginActionCallerMaterializationFixture(pluginId)
                        .resolveCurrentPluginMaterializationRef,
                contribution: { id: 'identity-read', qualifiedId: `${pluginId}/actions/identity-read` },
                occurrenceId: `${pluginId}-immutable-occurrenceId`, sourceCustody: { kind: 'development', registeredRootId: 'fixture-root' },
                correlationId: `${pluginId}-github-app-list`,
                surface: 'background',
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: { execute },
            invokeContributedAction: vi.fn(),
        });
        const input = { owner: { kind: 'team' as const, teamId: 'team-1' } };

        for (const pluginId of ['happier.builtin', 'acme.external-installed']) {
            await expect(createService(pluginId).execute('identity.githubApps.list', input))
                .resolves.toEqual(result);
        }
        expect(execute.mock.calls.map((call) => readPluginCallerId(call[2]))).toEqual([
            'happier.builtin',
            'acme.external-installed',
        ]);
        for (const call of execute.mock.calls) {
            expect(call[0]).toBe('identity.githubApps.list');
            expect(call[1]).toEqual(input);
            expect(call[2]).toMatchObject({ surface: 'plugin', authority: 'account_automation' });
        }
    });

    it('gives bundled and trusted external installed plugins the same Lane 10 resource Actions', async () => {
        const resultByActionId = new Map<string, unknown>([
            // The canonical page schemas carry `nextCursor`, so the parity
            // expectation is the parsed page a plugin actually receives — not
            // a cursor-free shape the production parser would never produce.
            ['teams.credentials.list', { resources: [], viewer: { manageCredentials: false, offerOwnCredential: false }, nextCursor: null }],
            ['teams.credentials.sources.list', {
                candidates: [],
                supportedKinds: ['connected_account', 'connected_pool', 'provider_connection'],
                brokerPresentation: {
                    selectedTarget: null,
                    eligibleTargets: [],
                    selectedPool: null,
                    eligiblePools: [],
                },
            }],
            ['teams.credentials.entitled.list', { resources: [], nextCursor: null }],
            ['teams.credentials.externalKeys.list', { keys: [] }],
            ['secrets.shared.list', { resources: [] }],
        ]);
        const execute = vi.fn(async (
            actionId: string,
            _input: unknown,
            _context?: ActionExecutorContext,
        ) => ({
            ok: true as const,
            result: resultByActionId.get(actionId),
        }));
        const createService = (pluginId: string) => createPluginInvocationActionsService({
            seed: {
                plugin: { id: pluginId, version: '1.0.0' },
                resolveCurrentPluginMaterializationRef:
                    createPluginActionCallerMaterializationFixture(pluginId)
                        .resolveCurrentPluginMaterializationRef,
                contribution: { id: 'credential-consumer', qualifiedId: `${pluginId}/actions/credential-consumer` },
                occurrenceId: `${pluginId}-immutable-occurrenceId`, sourceCustody: { kind: 'development', registeredRootId: 'fixture-root' },
                correlationId: `${pluginId}-credentials`,
                surface: 'background',
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: { execute },
            invokeContributedAction: vi.fn(),
        });
        const cases = [
            ['teams.credentials.list', { teamId: 'team-1' }],
            ['teams.credentials.sources.list', { teamId: 'team-1' }],
            ['teams.credentials.entitled.list', { teamId: 'team-1' }],
            ['teams.credentials.externalKeys.list', { resourceId: 'resource-1' }],
            ['secrets.shared.list', {}],
        ] as const;

        for (const pluginId of ['happier.builtin', 'acme.external-installed']) {
            const service = createService(pluginId);
            for (const [actionId, input] of cases) {
                await expect(service.execute(actionId, input)).resolves.toEqual(resultByActionId.get(actionId));
            }
        }
        expect(execute).toHaveBeenCalledTimes(cases.length * 2);
        expect(execute.mock.calls.map((call) => readPluginCallerId(call[2]))).toEqual([
            ...Array(cases.length).fill('happier.builtin'),
            ...Array(cases.length).fill('acme.external-installed'),
        ]);
        for (const call of execute.mock.calls) {
            expect(call[2]).toMatchObject({ surface: 'plugin', authority: 'account_automation' });
        }
    });

    it('preserves Lane 10 approval deferral and typed failure for trusted external plugins', async () => {
        const pending = {
            kind: 'approval_request_created' as const,
            artifactId: 'approval-lane10-1',
            actionId: 'secrets.shared.update',
        };
        const baseSeed = {
            plugin: { id: 'acme.external-installed', version: '1.0.0' },
            resolveCurrentPluginMaterializationRef:
                createPluginActionCallerMaterializationFixture('acme.external-installed')
                    .resolveCurrentPluginMaterializationRef,
            contribution: {
                id: 'credential-consumer',
                qualifiedId: 'acme.external-installed/actions/credential-consumer',
            },
            occurrenceId: createPluginRuntimeOccurrenceId('acme.external-installed'),
            sourceCustody: { kind: 'development' as const, registeredRootId: 'fixture-root' },
            correlationId: 'lane10-approval',
            surface: 'background' as const,
            signal: new AbortController().signal,
            isOccurrenceCurrent: () => true,
        };
        const input = {
            resourceId: 'resource-1',
            expectedRevision: 3,
            displayName: 'Rotated API key',
            kind: 'apiKey' as const,
            storedContent: {
                t: 'plain' as const,
                v: { v: 1 as const, name: 'Rotated API key', kind: 'apiKey' as const, value: 'secret' },
            },
        };
        const deferred = createPluginInvocationActionsService({
            seed: baseSeed,
            actionExecutor: { execute: async () => ({ ok: true, result: pending }) },
            invokeContributedAction: vi.fn(),
        });
        await expect(deferred.execute('secrets.shared.update', input)).resolves.toEqual(pending);

        const changed = createPluginInvocationActionsService({
            seed: baseSeed,
            actionExecutor: {
                execute: async () => ({
                    ok: false,
                    errorCode: 'resource_changed',
                    error: 'The Saved Secret changed before this update.',
                    details: { expectedRevision: 3 },
                }),
            },
            invokeContributedAction: vi.fn(),
        });
        await expect(changed.execute('secrets.shared.update', input)).rejects.toMatchObject({
            name: 'PluginError',
            code: 'resource_changed',
            message: 'The Saved Secret changed before this update.',
        });
    });

    it('does not treat an exact retained turn as authority to list the ambient Account corpus', async () => {
        const sessionList = vi.fn(async () => ({ sessions: [{ id: 'private-account-session', active: false, presence: 'offline', updatedAt: 10 }], nextCursor: null }));
        const owners = createProductionPluginInvocationServiceOwners({
            actionExecutor: createActionExecutorForTest({ sessionList }),
            invokeContributedAction: vi.fn(),
        });
        const service = owners.createServices({
                plugin: { id: 'acme.agent', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('acme.agent').resolveCurrentPluginMaterializationRef,
                contribution: { id: 'agent', qualifiedId: 'acme.agent/agents/agent' },
                occurrenceId: 'occurrenceId-1',
                correlationId: 'retained-list-1',
                surface: 'agent',
                session: { id: 'session-1' },
                sessionListAccess: 'unavailable',
                signal: new AbortController().signal,
                readActiveTurnAdmissionWitness: () => ({
                    inputId: 'input-1', turnId: 'turn-1', userMessageSeq: 7, userMessageSeqs: [7],
                    callerPermissionMode: 'yolo',
                }),
                isOccurrenceCurrent: () => true,
            }, owners.createOrdinaryServiceBinding('occurrenceId-1', 'retained-current-global-actions')).actions;
        await expect(service.execute('session.list', {})).rejects.toMatchObject({ code: 'unsupported_action' });
        expect(sessionList).not.toHaveBeenCalled();
    });
    it('preserves strict execution-run start certainty in the public PluginError', async () => {
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.automations', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('acme.automations').resolveCurrentPluginMaterializationRef,
                occurrenceId: 'occurrenceId-1',
                correlationId: 'automation-run-1',
                surface: 'background',
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: {
                execute: vi.fn(async () => ({
                    ok: false as const,
                    errorCode: 'execution_run_target_unavailable',
                    error: 'execution_run_target_unavailable',
                    details: {
                        executionRunStart: { v: 1, runCreation: 'noRunCreated' },
                        secret: 'must-not-cross-the-plugin-boundary',
                    },
                })),
            },
            invokeContributedAction: vi.fn(),
        });

        const error = await service.execute('execution.run.start', {
            sessionId: null,
            intent: 'task',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            instructions: 'Summarize the occurrence.',
            permissionMode: 'read_only',
            retentionPolicy: 'ephemeral',
            runClass: 'bounded',
            ioMode: 'request_response',
        }).catch((caught: unknown) => caught);
        expect(error).toMatchObject({ code: 'execution_run_target_unavailable' });
        expect(error).toHaveProperty('details', {
            executionRunStart: { v: 1, runCreation: 'noRunCreated' },
        });
    });

    it('defaults malformed start evidence to outcome-unknown and drops non-start failure details', async () => {
        const materialization = createPluginActionCallerMaterializationFixture('acme.automations');
        const seed = {
            plugin: { id: 'acme.automations', version: '1.0.0' },
            resolveCurrentPluginMaterializationRef: materialization.resolveCurrentPluginMaterializationRef,
            occurrenceId: 'occurrenceId-1',
            surface: 'background' as const,
            signal: new AbortController().signal,
            isOccurrenceCurrent: () => true,
        };
        const malformedStart = createPluginInvocationActionsService({
            seed,
            actionExecutor: {
                execute: vi.fn(async () => ({
                    ok: false as const,
                    errorCode: 'execution_run_target_unavailable',
                    error: 'execution_run_target_unavailable',
                    details: { executionRunStart: { v: 2, runCreation: 'noRunCreated' } },
                })),
            },
            invokeContributedAction: vi.fn(),
        });

        await expect(malformedStart.execute('execution.run.start', {
            sessionId: null,
            intent: 'task',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            instructions: 'Summarize the occurrence.',
            permissionMode: 'read_only',
            retentionPolicy: 'ephemeral',
            runClass: 'bounded',
            ioMode: 'request_response',
        })).rejects.toMatchObject({
            code: 'execution_run_target_unavailable',
            details: { executionRunStart: { v: 1, runCreation: 'outcomeUnknown' } },
        });

        const nonStart = createPluginInvocationActionsService({
            seed,
            actionExecutor: {
                execute: vi.fn(async () => ({
                    ok: false as const,
                    errorCode: 'action_disabled',
                    error: 'action_disabled',
                    details: { secret: 'must-not-cross-the-plugin-boundary' },
                })),
            },
            invokeContributedAction: vi.fn(),
        });
        const error = await nonStart.execute('memory.search', {
            machineId: 'machine-1',
            query: { v: 1, query: 'x', scope: { type: 'global' }, mode: 'hints' },
        }).catch((caught: unknown) => caught);
        expect(error).toMatchObject({ code: 'action_disabled' });
        expect(error).not.toHaveProperty('details');
    });

    it('classifies plugin retirement before and after host start dispatch without granting retry authority', async () => {
        const startInput = {
            sessionId: null,
            intent: 'task',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            instructions: 'Summarize the occurrence.',
            permissionMode: 'read_only',
            retentionPolicy: 'ephemeral',
            runClass: 'bounded',
            ioMode: 'request_response',
        } as const;
        const materialization = createPluginActionCallerMaterializationFixture('acme.automations');
        const inactiveBeforeDispatch = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.automations', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: materialization.resolveCurrentPluginMaterializationRef,
                occurrenceId: 'occurrenceId-1',
                surface: 'background',
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => false,
            },
            actionExecutor: { execute: vi.fn() },
            invokeContributedAction: vi.fn(),
        });
        await expect(inactiveBeforeDispatch.execute('execution.run.start', startInput)).rejects.toMatchObject({
            code: 'plugin_action_generation_retired',
            details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
        });

        let currentnessChecks = 0;
        const inactiveAfterDispatch = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.automations', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: materialization.resolveCurrentPluginMaterializationRef,
                occurrenceId: 'occurrenceId-1',
                surface: 'background',
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => ++currentnessChecks < 3,
            },
            actionExecutor: {
                execute: vi.fn(async () => ({
                    ok: true as const,
                    result: { runId: 'run-1', callId: 'call-1', sidechainId: 'sidechain-1' },
                })),
            },
            invokeContributedAction: vi.fn(),
        });
        await expect(inactiveAfterDispatch.execute('execution.run.start', startInput)).rejects.toMatchObject({
            code: 'plugin_action_generation_retired',
            details: { executionRunStart: { v: 1, runCreation: 'outcomeUnknown' } },
        });
    });

    it('classifies plugin input rejection before dispatch and output rejection after dispatch', async () => {
        const materialization = createPluginActionCallerMaterializationFixture('acme.automations');
        const execute = vi.fn(async () => ({ ok: true as const, result: {} }));
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.automations', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: materialization.resolveCurrentPluginMaterializationRef,
                occurrenceId: 'occurrenceId-1',
                surface: 'background',
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: { execute },
            invokeContributedAction: vi.fn(),
        });

        await expect(Reflect.apply(service.execute, service, ['execution.run.start', {}])).rejects.toMatchObject({
            code: 'plugin_action_input_schema_invalid',
            details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
        });
        expect(execute).not.toHaveBeenCalled();

        await expect(service.execute('execution.run.start', {
            sessionId: null,
            intent: 'task',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            instructions: 'Summarize the occurrence.',
            permissionMode: 'read_only',
            retentionPolicy: 'ephemeral',
            runClass: 'bounded',
            ioMode: 'request_response',
        })).rejects.toMatchObject({
            code: 'plugin_action_result_schema_invalid',
            details: { executionRunStart: { v: 1, runCreation: 'outcomeUnknown' } },
        });
        expect(execute).toHaveBeenCalledOnce();
    });

    it('keeps present-user decisions gated on the plugin Actions seam', async () => {
        const sessionUserActionAnswer = vi.fn<NonNullable<ActionExecutorDeps['sessionUserActionAnswer']>>(
            async (_args) => ({ ok: true }),
        );
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.interactions', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('acme.interactions').resolveCurrentPluginMaterializationRef,
                occurrenceId: 'occurrenceId-1',
                correlationId: 'interaction-1',
                surface: 'ui',
                session: { id: 'session-bound' },
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: createActionExecutorForTest({
                sessionUserActionAnswer,
            }),
            invokeContributedAction: vi.fn(),
        });

        // The local present-user respond id is host-only: the ActionSpec excludes
        // it from the Plugin surface (pinned by the canonical ActionSpec owner),
        // so the plugin seam has no local permission-respond path at all. The
        // plugin-reachable decision path is the mediated remote permission
        // vertical reached through its own host-stamped owner.
        await expect(service.execute('session.user_action.answer', {
            requestId: 'question-1',
            answers: [{ question: 'Continue?', values: ['Yes'] }],
        })).rejects.toMatchObject({ code: 'present_user_required' });
        expect(sessionUserActionAnswer).not.toHaveBeenCalled();
    });

    // The daemon-side durable-push transfer repair reaches the generic webhook
    // endpoint through exactly this seam, so this composition — real plugin
    // ActionsService over the real canonical executor — is what decides whether
    // a plugin may observe or move an endpoint at all. Generic observation and
    // unrestricted retarget stay present-user administration and never reach
    // the canonical webhook owner from a plugin; the correspondence check and
    // the correspondence-gated target convergence are the two bounded
    // capabilities the plugin surface owns.
    it('keeps generic webhook endpoint observation and retarget outside plugin authority', async () => {
        const pluginWebhookAction = vi.fn<NonNullable<ActionExecutorDeps['pluginWebhookAction']>>(
            async () => ({
                kind: 'ready' as const,
                webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA',
                revision: 4,
            }),
        );
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'happier.channels', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('happier.channels').resolveCurrentPluginMaterializationRef,
                occurrenceId: 'occurrenceId-1',
                correlationId: 'connection-transfer-1',
                surface: 'background',
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: createActionExecutorForTest({ pluginWebhookAction }),
            invokeContributedAction: vi.fn(),
        });

        await expect(service.execute('plugin.webhook.endpoint.read', {
            webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA',
        })).rejects.toMatchObject({ code: 'present_user_required' });

        await expect(service.execute('plugin.webhook.endpoint.retarget', {
            webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA',
            expectedRevision: 4,
            targetMaterialization: {
                machineId: 'machine-2',
                materializationId: 'materialization-2',
                pluginId: 'happier.channels',
            },
            idempotencyKey: 'xfer.connection-1.5.webhook',
        })).rejects.toMatchObject({ code: 'present_user_required' });

        expect(pluginWebhookAction).not.toHaveBeenCalled();

        await expect(service.execute('plugin.webhook.endpoint.checkCorrespondence', {
            webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA',
            webhookContribution: { pluginId: 'happier.channels', localId: 'webhook' },
            targetMaterialization: {
                machineId: 'machine-2',
                materializationId: 'materialization-2',
                pluginId: 'happier.channels',
            },
            sourceInstanceId: 'channels.connection.connection-1',
            setup: { kind: 'accountEndpointV1', credential: 'serverGenerated' },
        })).resolves.toMatchObject({ kind: 'ready' });

        expect(pluginWebhookAction).toHaveBeenCalledOnce();
    });

    // The composed seam the durable-push transfer actually depends on: a
    // daemon-side Channels caller with no present user must be able to
    // converge the endpoint it already owns onto its committed desired
    // target, carrying the stamped caller through to the canonical webhook
    // owner and no endpoint revision of its own.
    it('admits correspondence-gated endpoint target convergence for a daemon-side plugin caller', async () => {
        const pluginWebhookAction = vi.fn<NonNullable<ActionExecutorDeps['pluginWebhookAction']>>(
            async () => ({
                kind: 'converged' as const,
                webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA',
                revision: 5,
                targetMaterialization: {
                    machineId: 'machine-2',
                    materializationId: 'materialization-2',
                    pluginId: 'happier.channels',
                },
                targetIntentEpoch: 5,
            }),
        );
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'happier.channels', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('happier.channels').resolveCurrentPluginMaterializationRef,
                occurrenceId: 'occurrenceId-1',
                correlationId: 'connection-transfer-2',
                surface: 'background',
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: createActionExecutorForTest({ pluginWebhookAction }),
            invokeContributedAction: vi.fn(),
        });

        await expect(service.execute('plugin.webhook.endpoint.convergeTarget', {
            webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA',
            webhookContribution: { pluginId: 'happier.channels', localId: 'webhook' },
            sourceInstanceId: 'channels.connection.connection-1',
            setup: { kind: 'accountEndpointV1', credential: 'serverGenerated' },
            desiredTargetMaterialization: {
                machineId: 'machine-2',
                materializationId: 'materialization-2',
                pluginId: 'happier.channels',
            },
            targetIntentEpoch: 5,
        })).resolves.toMatchObject({ kind: 'converged', revision: 5, targetIntentEpoch: 5 });

        expect(pluginWebhookAction).toHaveBeenCalledOnce();
        expect(pluginWebhookAction.mock.calls[0]?.[0]).toMatchObject({
            actionId: 'plugin.webhook.endpoint.convergeTarget',
            caller: { kind: 'plugin', pluginId: 'happier.channels' },
        });
    });

    it('reaches the canonical daemon browser owner with host-stamped identity and composed cancellation', async () => {
        const dispatchCommand = vi.fn(async (command: Readonly<{ commandId: string }>) => ({
            v: 1 as const,
            commandId: command.commandId,
            status: 'dispatched' as const,
            adapterKind: 'chromiumSidecar' as const,
            events: [],
        }));
        const broker = createBrowserDaemonControlBroker();
        broker.registerAdapter({
            adapterKind: 'chromiumSidecar',
            ownsView: ({ browserSessionId, viewId }) => (
                browserSessionId === 'browser-session-1' && viewId === 'view-1'
            ),
            supportsOpenView: () => false,
            dispatchCommand,
        });
        const canonicalBrowserExecute = createBrowserDaemonRuntimeActionExecutor({
            control: createBrowserDaemonControlRoutes({ broker }),
            featureGate: {
                isEnabled: () => true,
                refresh: async () => {},
            },
        });
        const runtimeActionExecute = vi.fn(canonicalBrowserExecute);
        const actionExecutor = createCliActionExecutor({
            token: 'token',
            sessionId: 'plugin-global',
            mode: 'plain',
            ctx: null,
            runtimeActionExecute,
            actionsSettingsProvider: {
                getActionsSettings: () => normalizeActionsSettingsV1({
                    v: 1,
                    actions: {},
                    approvalWaivedSurfaces: { 'browser.navigate': ['plugin'] },
                }),
            },
        } as Parameters<typeof createCliActionExecutor>[0] & Readonly<{
            runtimeActionExecute: typeof runtimeActionExecute;
        }>);
        const retirement = new AbortController();
        const caller = new AbortController();
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.browser', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('acme.browser').resolveCurrentPluginMaterializationRef,
                occurrenceId: 'occurrenceId-1',
                surface: 'cli',
                signal: retirement.signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor,
            invokeContributedAction: vi.fn(),
        });

        await expect(service.execute('browser.navigate', {
            kind: 'navigate',
            commandId: 'command-1',
            browserSessionId: 'browser-session-1',
            viewId: 'view-1',
            url: 'https://example.com',
        }, { signal: caller.signal })).resolves.toMatchObject({
            v: 1,
            commandId: 'command-1',
            status: 'dispatched',
        });

        expect(runtimeActionExecute).toHaveBeenCalledOnce();
        expect(runtimeActionExecute.mock.calls[0]?.[0].context).toMatchObject({
            surface: 'plugin',
            actionCaller: { kind: 'plugin', pluginId: 'acme.browser' },
        });
        const signal = runtimeActionExecute.mock.calls[0]?.[0].context.signal;
        expect(signal).toBeInstanceOf(AbortSignal);
        expect(signal).not.toBe(retirement.signal);
        expect(signal).not.toBe(caller.signal);
        expect(dispatchCommand).toHaveBeenCalledOnce();
    });

    it('binds host action execution to the plugin surface and host-stamped caller identity', async () => {
        const execute = vi.fn(async () => ({
            ok: true as const,
            result: { v: 1, ok: true as const, hits: [] },
        }));
        const retirement = new AbortController();
        const callerMaterialization = createPluginActionCallerMaterializationFixture('acme.memory');
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.memory', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef:
                    callerMaterialization.resolveCurrentPluginMaterializationRef,
                contribution: { id: 'search', qualifiedId: 'acme.memory/actions/search' },
                occurrenceId: 'memory-occurrence-a',
                sourceCustody: { kind: 'development', registeredRootId: 'memory-root' },
                correlationId: 'correlation-1',
                surface: 'cli',
                session: { id: 'session-1' },
                signal: retirement.signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: { execute },
            invokeContributedAction: vi.fn(),
        });

        await expect(service.execute('memory.search', {
            machineId: 'machine-1',
            query: {
                v: 1,
                query: 'architecture owner',
                scope: { type: 'global' },
                mode: 'hints',
            },
        })).resolves.toEqual({ v: 1, ok: true, hits: [] });

        expect(execute).toHaveBeenCalledWith(
            'memory.search',
            {
                machineId: 'machine-1',
                query: {
                    v: 1,
                    query: 'architecture owner',
                    scope: { type: 'global' },
                    mode: 'hints',
                },
            },
            expect.objectContaining({
                defaultSessionId: 'session-1',
                surface: 'plugin',
                authority: 'account_automation',
                actionCaller: {
                    kind: 'plugin',
                    pluginId: 'acme.memory',
                    contributionLocalId: 'search',
                    materialization: callerMaterialization.materialization,
                    occurrenceId: 'memory-occurrence-a',
                    sourceCustody: { kind: 'development', registeredRootId: 'memory-root' },
                },
                actionRequestId: 'correlation-1:memory.search:1',
                signal: retirement.signal,
            }),
        );
    });

    it('binds retained Agent Actions to the active turn authority and source Session', async () => {
        const execute = vi.fn(async () => ({
            ok: true as const,
            result: { sessions: [] },
        }));
        const causalPermissionAuthority = Object.freeze({
            kind: 'admittedSessionInputV1' as const,
            admittedPermissionCeiling: 'read-only',
        });
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.agent', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef:
                    createPluginActionCallerMaterializationFixture('acme.agent')
                        .resolveCurrentPluginMaterializationRef,
                contribution: { id: 'agent', qualifiedId: 'acme.agent/agents/agent' },
                occurrenceId: 'occurrenceId-1',
                correlationId: 'invocation-1',
                surface: 'agent',
                session: { id: 'session-1' },
                signal: new AbortController().signal,
                readActiveTurnAdmissionWitness: () => ({
                    inputId: 'input-1',
                    turnId: 'turn-1',
                    userMessageSeq: 7,
                    userMessageSeqs: [7],
                    causalPermissionAuthority,
                    callerPermissionMode: 'yolo',
                }),
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: { execute },
            invokeContributedAction: vi.fn(),
        });

        await expect(service.execute('session.list', {})).resolves.toEqual({ sessions: [] });
        expect(execute).toHaveBeenCalledWith(
            'session.list',
            {},
            expect.objectContaining({
                surface: 'agent',
                authority: 'account_automation',
                sessionListAccess: 'current_session',
                callerPermissionMode: 'yolo',
                causalPermissionAuthority,
                sessionInputSource: {
                    sourceSessionId: 'session-1',
                    sourceTurnId: 'turn-1',
                    via: 'action',
                },
            }),
        );
    });

    it('propagates the Agent active-turn admission witness through composed invocation services', async () => {
        // The composed services owner builds the actions seed explicitly. Dropping the
        // witness there silently strips the caller permission mode and causal authority
        // from every Agent-placed Action, so Run dispatch fails closed.
        const execute = vi.fn(async () => ({ ok: true as const, result: { sessions: [] } }));
        const causalPermissionAuthority = Object.freeze({
            kind: 'admittedSessionInputV1' as const,
            admittedPermissionCeiling: 'read-only',
        });
        const owners = createProductionPluginInvocationServiceOwners({
            actionExecutor: { execute },
            invokeContributedAction: vi.fn(),
        });
        const service = owners.createServices({
            plugin: { id: 'acme.agent', version: '1.0.0' },
            resolveCurrentPluginMaterializationRef:
                createPluginActionCallerMaterializationFixture('acme.agent')
                    .resolveCurrentPluginMaterializationRef,
            contribution: { id: 'agent', qualifiedId: 'acme.agent/agents/agent' },
            occurrenceId: 'occurrenceId-1',
            correlationId: 'invocation-1',
            surface: 'agent',
            session: { id: 'session-1' },
            signal: new AbortController().signal,
            readActiveTurnAdmissionWitness: () => ({
                inputId: 'input-1',
                turnId: 'turn-1',
                userMessageSeq: 7,
                userMessageSeqs: [7],
                causalPermissionAuthority,
                callerPermissionMode: 'yolo',
            }),
            isOccurrenceCurrent: () => true,
        }, owners.createOrdinaryServiceBinding('occurrenceId-1', 'composed-witness-actions')).actions;

        await expect(service.execute('session.list', {})).resolves.toEqual({ sessions: [] });
        expect(execute).toHaveBeenCalledWith(
            'session.list',
            {},
            expect.objectContaining({
                surface: 'agent',
                authority: 'account_automation',
                callerPermissionMode: 'yolo',
                causalPermissionAuthority,
                sessionInputSource: {
                    sourceSessionId: 'session-1',
                    sourceTurnId: 'turn-1',
                    via: 'action',
                },
            }),
        );
    });

    it('strictly validates the plugin-recipient result and reports executor failures as PluginError', async () => {
        const invalidResult = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.memory', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('acme.memory').resolveCurrentPluginMaterializationRef,
                occurrenceId: 'occurrenceId-1',
                surface: 'cli',
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: {
                execute: async () => ({ ok: true, result: { privateMemoryRows: [] } }),
            },
            invokeContributedAction: vi.fn(),
        });
        await expect(invalidResult.execute('memory.search', {
            machineId: 'machine-1',
            query: { v: 1, query: 'x', scope: { type: 'global' }, mode: 'hints' },
        })).rejects.toMatchObject({
            name: 'PluginError',
            code: 'plugin_action_result_schema_invalid',
        });

        const denied = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.memory', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('acme.memory').resolveCurrentPluginMaterializationRef,
                occurrenceId: 'occurrenceId-1',
                surface: 'cli',
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: {
                execute: async () => ({ ok: false, errorCode: 'action_disabled', error: 'action_disabled' }),
            },
            invokeContributedAction: vi.fn(),
        });
        await expect(denied.execute('memory.search', {
            machineId: 'machine-1',
            query: { v: 1, query: 'x', scope: { type: 'global' }, mode: 'hints' },
        })).rejects.toMatchObject({ code: 'action_disabled' });
    });

    it('rejects a semantic transcript result that is outside the plugin external-shareable projection', async () => {
        const execute = vi.fn(async () => ({
            ok: true as const,
            result: {
                ok: true as const,
                sessionId: 'session-1',
                items: [],
                nextCursor: null,
                hasMore: false,
                diagnostics: {
                    rawRowsScanned: 0,
                    pagesFetched: 0,
                    scanLimitReached: false,
                    payloadTruncations: 0,
                },
            },
        }));
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.channels', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('acme.channels').resolveCurrentPluginMaterializationRef,
                occurrenceId: 'occurrenceId-1',
                surface: 'background',
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: { execute },
            invokeContributedAction: vi.fn(),
        });

        await expect(service.execute('session.transcript.get', {
            sessionId: 'session-1',
            projection: 'externalShareableV1',
        })).rejects.toMatchObject({
            code: 'plugin_action_result_schema_invalid',
        });
        expect(execute).toHaveBeenCalledOnce();
    });

    it('forwards the host-private interception bypass only for hook-originated service seeds', async () => {
        const execute = vi.fn(async () => ({
            ok: true as const,
            result: { v: 1, ok: true as const, hits: [] },
        }));
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.hook', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('acme.hook').resolveCurrentPluginMaterializationRef,
                occurrenceId: 'occurrenceId-1',
                surface: 'background',
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
                bypassActionInterception: true,
            },
            actionExecutor: { execute },
            invokeContributedAction: vi.fn(),
        });

        await service.execute('memory.search', {
            machineId: 'machine-1',
            query: { v: 1, query: 'x', scope: { type: 'global' }, mode: 'hints' },
        });
        expect(execute).toHaveBeenCalledWith(
            'memory.search',
            expect.anything(),
            expect.objectContaining({ bypassActionInterception: true }),
        );
    });

    it('binds permission-request identity from the host seed instead of accepting plugin-authored identity', async () => {
        const pluginPermissionGrantAction: NonNullable<ActionExecutorDeps['pluginPermissionGrantAction']> = vi.fn(async () => ({
            ok: false as const,
            errorCode: 'test_stop_after_binding',
            error: 'test_stop_after_binding',
        }));
        const actionExecutor = createPermissionActionExecutor(pluginPermissionGrantAction);
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.caller', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('acme.caller').resolveCurrentPluginMaterializationRef,
                occurrenceId: 'occurrenceId-1',
                surface: 'ui',
                session: { id: 'session-7' },
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor,
            invokeContributedAction: vi.fn(),
        });

        await expect(Reflect.apply(service.execute, service, [
            'plugins.permissions.grants.request',
            {
                capability: 'reviews.comments.write.direct',
                targetScope: { kind: 'account' },
                subject: { kind: 'general' },
                reason: 'Publish approved review comments directly',
            },
        ])).rejects.toMatchObject({ code: 'test_stop_after_binding' });
        expect(pluginPermissionGrantAction).toHaveBeenCalledWith(expect.objectContaining({
            actionId: 'plugins.permissions.grants.request',
            input: expect.objectContaining({
                pluginId: 'acme.caller',
                requester: {
                    kind: 'plugin',
                    pluginId: 'acme.caller',
                    sessionId: 'session-7',
                },
            }),
            caller: expect.objectContaining({
                kind: 'plugin',
                pluginId: 'acme.caller',
                materialization: expect.objectContaining({
                    machineId: 'machine-1',
                    materializationId: 'materialization-acme-caller-current',
                }),
            }),
        }));
    });

    it('routes own-grant revoke through the real executor and keeps user decisions directional', async () => {
        const pluginPermissionGrantAction: NonNullable<ActionExecutorDeps['pluginPermissionGrantAction']> = vi.fn(async () => ({
            ok: false as const,
            errorCode: 'test_stop_after_binding',
            error: 'test_stop_after_binding',
        }));
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.caller', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('acme.caller').resolveCurrentPluginMaterializationRef,
                occurrenceId: 'occurrenceId-1',
                surface: 'ui',
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: createPermissionActionExecutor(pluginPermissionGrantAction),
            invokeContributedAction: vi.fn(),
        });

        await expect(service.execute('plugins.permissions.grants.revoke', {
            grantId: 'grant-1',
        })).rejects.toMatchObject({ code: 'test_stop_after_binding' });
        expect(pluginPermissionGrantAction).toHaveBeenCalledWith({
            actionId: 'plugins.permissions.grants.revoke',
            input: { grantId: 'grant-1' },
            caller: expect.objectContaining({
                kind: 'plugin',
                pluginId: 'acme.caller',
                materialization: expect.objectContaining({
                    machineId: 'machine-1',
                    materializationId: 'materialization-acme-caller-current',
                }),
            }),
            signal: expect.any(AbortSignal),
        });

        await expect(service.execute('plugins.permissions.grants.grant', {
            requestId: 'request-1',
        })).rejects.toMatchObject({ code: 'present_user_required' });
        expect(pluginPermissionGrantAction).toHaveBeenCalledTimes(1);
    });

    it('invokes an exact contributed action reference through the committed registry owner', async () => {
        const invokeContributedAction = vi.fn<InvokeContributedAction>(async () => ({
            status: 'executed' as const,
            value: { accepted: true },
        }));
        const signal = new AbortController().signal;
        const callerMaterialization = createPluginActionCallerMaterializationFixture('acme.caller', {
            materializationId: 'materialization-caller-current',
        });
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.caller', version: '1.0.0' },
                contribution: { id: 'caller', qualifiedId: 'acme.caller/actions/caller' },
                occurrenceId: 'caller-occurrence-1', sourceCustody: { kind: 'development', registeredRootId: 'caller-root' },
                surface: 'agent',
                resolveCurrentPluginMaterializationRef: callerMaterialization.resolveCurrentPluginMaterializationRef,
                session: { id: 'session-1' },
                signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: { execute: vi.fn() },
            invokeContributedAction,
        });

        await expect(service.execute(
            { pluginId: 'acme.target', localId: 'publish' },
            { title: 'Ready' },
        )).resolves.toEqual({ accepted: true });
        expect(invokeContributedAction).toHaveBeenCalledWith({
            action: { pluginId: 'acme.target', localId: 'publish' },
            input: { title: 'Ready' },
            surface: 'plugin',
            originSurface: 'agent',
            initiatingActionCaller: {
                kind: 'plugin', pluginId: 'acme.caller', contributionLocalId: 'caller',
                occurrenceId: 'caller-occurrence-1', sourceCustody: { kind: 'development', registeredRootId: 'caller-root' },
                materialization: callerMaterialization.materialization,
            },
            caller: {
                kind: 'plugin',
                pluginId: 'acme.caller',
                contribution: { id: 'caller', qualifiedId: 'acme.caller/actions/caller' },
                occurrenceId: 'caller-occurrence-1', sourceCustody: { kind: 'development', registeredRootId: 'caller-root' },
                materialization: callerMaterialization.materialization,
                originSurface: 'agent',
            },
            sessionId: 'session-1',
            signal,
        });
    });

    it('withholds a contributed result when the host-stamped caller materialization changes during dispatch', async () => {
        const initialCaller = createPluginActionCallerMaterializationFixture('acme.caller', {
            materializationId: 'materialization-caller-before',
        }).materialization;
        let currentCaller = initialCaller;
        const invokeContributedAction = vi.fn(async () => {
            currentCaller = createPluginActionCallerMaterializationFixture('acme.caller', {
                materializationId: 'materialization-caller-after',
            }).materialization;
            return {
                status: 'executed' as const,
                value: { accepted: true },
            };
        });
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.caller', version: '1.0.0' },
                contribution: { id: 'caller', qualifiedId: 'acme.caller/actions/caller' },
                occurrenceId: 'caller-occurrence-1', sourceCustody: { kind: 'development', registeredRootId: 'caller-root' },
                surface: 'agent',
                resolveCurrentPluginMaterializationRef: () => currentCaller,
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: { execute: vi.fn() },
            invokeContributedAction,
        });

        await expect(service.execute(
            { pluginId: 'acme.target', localId: 'publish' },
            { title: 'Ready' },
        )).rejects.toMatchObject({ code: 'plugin_action_caller_unavailable' });
        expect(invokeContributedAction).toHaveBeenCalledWith(expect.objectContaining({
            caller: expect.objectContaining({
                materialization: initialCaller,
            }),
        }));
    });

    it('reads only the canonical projected fields when reconstructing a contributed action failure', async () => {
        const cause = new Error('provider credential is secret');
        const original = new PluginError({
            code: 'fixture_provider_failed',
            message: 'provider credential is secret',
            retryable: true,
            details: { credential: 'secret' },
            remediation: { kind: 'openSettings', path: 'accounts/acme' },
            diagnostics: [{ code: 'fixture_diagnostic', severity: 'error', message: 'private' }],
        }, { cause });
        // Boundary fixture: a malformed richer result whose author vocabulary
        // sits at the top level instead of inside the canonical `data` payload.
        const richResult = Object.freeze({
            status: 'failed' as const,
            code: original.code,
            message: original.message,
            retryable: original.retryable,
            details: original.details,
            remediation: original.remediation,
            diagnostics: original.diagnostics,
            cause: original,
        });
        const callerMaterialization = createPluginActionCallerMaterializationFixture('acme.caller');
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.caller', version: '1.0.0' },
                contribution: { id: 'caller', qualifiedId: 'acme.caller/actions/caller' },
                occurrenceId: 'caller-occurrence-1', sourceCustody: { kind: 'development', registeredRootId: 'caller-root' },
                surface: 'agent',
                resolveCurrentPluginMaterializationRef: callerMaterialization.resolveCurrentPluginMaterializationRef,
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: { execute: vi.fn() },
            // Boundary fixture intentionally models a malformed richer result
            // that must not cross the generic service boundary.
            invokeContributedAction: vi.fn<InvokeContributedAction>(async () => richResult),
        });

        const received = await service.execute(
            { pluginId: 'acme.target', localId: 'publish' },
            { title: 'Ready' },
        ).catch((error: unknown) => error);

        expect(received).toBeInstanceOf(PluginError);
        expect(received).not.toBe(original);
        // `retryable` is a canonical projected field, so it crosses. The author
        // vocabulary is read only from the canonical `data` payload: a fixture
        // that hangs `details`/`remediation`/`diagnostics`/`cause` off the
        // result itself publishes nothing, and no error class is transported.
        expect(received).toMatchObject({
            code: 'fixture_provider_failed',
            message: 'provider credential is secret',
            retryable: true,
            details: undefined,
            remediation: undefined,
            diagnostics: undefined,
        });
        expect(Object.hasOwn(received as object, 'cause')).toBe(false);
        expect((received as PluginError).data).toEqual({
            name: 'PluginError',
            code: 'fixture_provider_failed',
            message: 'provider credential is secret',
            retryable: true,
        });
    });

    it('carries a target plugin canonical error retryable and data across a plugin-to-plugin failure', async () => {
        // Plugins are trusted code. A target's own published failure payload is
        // the failure its caller receives, not a bare taxonomy code.
        const target = new PluginError({
            code: 'fixture_provider_failed',
            message: 'provider rejected the publish',
            retryable: true,
            details: { field: 'title', attempted: 2 },
            remediation: { kind: 'openSettings', path: 'accounts/acme' },
            diagnostics: [{ code: 'fixture_diagnostic', severity: 'error', message: 'quota exhausted' }],
        });
        const callerMaterialization = createPluginActionCallerMaterializationFixture('acme.caller');
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.caller', version: '1.0.0' },
                contribution: { id: 'caller', qualifiedId: 'acme.caller/actions/caller' },
                occurrenceId: 'caller-occurrence-1', sourceCustody: { kind: 'development', registeredRootId: 'caller-root' },
                surface: 'agent',
                resolveCurrentPluginMaterializationRef: callerMaterialization.resolveCurrentPluginMaterializationRef,
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: { execute: vi.fn() },
            invokeContributedAction: vi.fn<InvokeContributedAction>(async () => Object.freeze({
                status: 'failed' as const,
                code: target.code,
                message: target.message,
                retryable: target.retryable,
                data: target.data as JsonValue,
            })),
        });

        const received = await service.execute(
            { pluginId: 'acme.target', localId: 'publish' },
            { title: 'Ready' },
        ).catch((error: unknown) => error);

        expect(received).toBeInstanceOf(PluginError);
        expect(received).not.toBe(target);
        expect(received).toMatchObject({
            code: 'fixture_provider_failed',
            message: 'provider rejected the publish',
            retryable: true,
            details: { field: 'title', attempted: 2 },
            remediation: { kind: 'openSettings', path: 'accounts/acme' },
            diagnostics: [{ code: 'fixture_diagnostic', severity: 'error', message: 'quota exhausted' }],
        });
        expect((received as PluginError).data).toEqual(target.data);
    });

    it('preserves only the generic proof that a contributed handler never began', async () => {
        const callerMaterialization = createPluginActionCallerMaterializationFixture('acme.caller');
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.caller', version: '1.0.0' },
                contribution: { id: 'caller', qualifiedId: 'acme.caller/actions/caller' },
                occurrenceId: 'caller-occurrence-1', sourceCustody: { kind: 'development', registeredRootId: 'caller-root' },
                surface: 'agent',
                resolveCurrentPluginMaterializationRef: callerMaterialization.resolveCurrentPluginMaterializationRef,
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: { execute: vi.fn() },
            invokeContributedAction: vi.fn<InvokeContributedAction>(async () => (
                Object.freeze({
                    status: 'unavailable' as const,
                    code: 'plugin_action_handler_missing',
                    message: 'No committed target handler exists',
                    actionHandlerInvocation: 'notStarted',
                } satisfies ContributedActionInvocationResult)
            )),
        });

        const received = await service.execute(
            { pluginId: 'acme.target', localId: 'publish' },
            { title: 'Ready' },
        ).catch((error: unknown) => error);

        expect(received).toMatchObject({
            name: 'PluginError',
            code: 'plugin_action_handler_missing',
            actionHandlerInvocation: 'notStarted',
            data: {
                actionHandlerInvocation: 'notStarted',
            },
        });
    });

    it('returns a host-stamped exact target execution origin only for the contributed-Action origin call', async () => {
        const executionOrigin = Object.freeze({
            serverIdentityId: 'srv_action_origin_fixture',
            materializationRef: Object.freeze({
                pluginId: 'acme.target',
                machineId: 'machine-target',
                materializationId: 'materialization-target-current',
            }),
        });
        const invokeContributedAction = vi.fn<InvokeContributedAction>(async () => ({
            status: 'executed' as const,
            value: { accepted: true },
            executionOrigin,
        }));
        const signal = new AbortController().signal;
        const callerMaterialization = createPluginActionCallerMaterializationFixture('acme.caller', {
            materializationId: 'materialization-caller-current',
        });
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.caller', version: '1.0.0' },
                contribution: { id: 'caller', qualifiedId: 'acme.caller/actions/caller' },
                occurrenceId: 'caller-occurrence-1', sourceCustody: { kind: 'development', registeredRootId: 'caller-root' },
                surface: 'agent',
                resolveCurrentPluginMaterializationRef: callerMaterialization.resolveCurrentPluginMaterializationRef,
                signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: { execute: vi.fn() },
            invokeContributedAction,
        });

        await expect(service.executeWithExecutionOrigin(
            { pluginId: 'acme.target', localId: 'publish' },
            { title: 'Ready' },
        )).resolves.toEqual({
            result: { accepted: true },
            executionOrigin,
        });
        expect(invokeContributedAction).toHaveBeenCalledWith(expect.objectContaining({
            action: { pluginId: 'acme.target', localId: 'publish' },
            input: { title: 'Ready' },
            surface: 'plugin',
            captureExecutionOrigin: true,
            caller: {
                kind: 'plugin',
                pluginId: 'acme.caller',
                contribution: { id: 'caller', qualifiedId: 'acme.caller/actions/caller' },
                occurrenceId: 'caller-occurrence-1', sourceCustody: { kind: 'development', registeredRootId: 'caller-root' },
                materialization: callerMaterialization.materialization,
                originSurface: 'agent',
            },
            signal,
        }));
        expect(invokeContributedAction.mock.calls[0]?.[0]).not.toHaveProperty('executionOrigin');

        await expect(service.execute(
            { pluginId: 'acme.target', localId: 'publish' },
            { title: 'Ready' },
        )).resolves.toEqual({ accepted: true });
        expect(invokeContributedAction.mock.calls[1]?.[0]).not.toHaveProperty('captureExecutionOrigin');
        expect(invokeContributedAction.mock.calls[1]?.[0]).not.toHaveProperty('executionOrigin');
    });

    it('rejects a malformed expected execution origin before contributed Action dispatch', async () => {
        const invokeContributedAction = vi.fn(async () => ({
            status: 'executed' as const,
            value: { accepted: true },
            executionOrigin: {
                serverIdentityId: 'srv_action_origin_fixture',
                materializationRef: {
                    pluginId: 'acme.target',
                    machineId: 'machine-target',
                    materializationId: 'materialization-target-current',
                },
            },
        }));
        const callerMaterialization = createPluginActionCallerMaterializationFixture('acme.caller');
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.caller', version: '1.0.0' },
                contribution: { id: 'caller', qualifiedId: 'acme.caller/actions/caller' },
                occurrenceId: 'occurrenceId-1',
                surface: 'agent',
                resolveCurrentPluginMaterializationRef: callerMaterialization.resolveCurrentPluginMaterializationRef,
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: { execute: vi.fn() },
            invokeContributedAction,
        });

        await expect(Reflect.apply(service.executeWithExecutionOrigin, service, [
            { pluginId: 'acme.target', localId: 'publish' },
            { title: 'Ready' },
            {
                expectedExecutionOrigin: {
                    serverIdentityId: 'not-a-server-identity',
                    materializationRef: {
                        pluginId: 'acme.target',
                        machineId: 'machine-target',
                        materializationId: 'materialization-target-current',
                    },
                },
            },
        ])).rejects.toMatchObject({
            code: 'plugin_action_execution_origin_invalid',
        });
        expect(invokeContributedAction).not.toHaveBeenCalled();
    });

    it('keeps a background contributed-action call on the target plugin surface', async () => {
        const invokeContributedAction = vi.fn(async () => ({
            status: 'executed' as const,
            value: { accepted: true },
        }));
        const signal = new AbortController().signal;
        const callerMaterialization = createPluginActionCallerMaterializationFixture('acme.background', {
            materializationId: 'materialization-background-current',
        });
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.background', version: '1.0.0' },
                contribution: {
                    id: 'gateway-supervisor',
                    qualifiedId: 'acme.background/backgroundServices/gateway-supervisor',
                },
                occurrenceId: 'background-occurrence-1', sourceCustody: { kind: 'development', registeredRootId: 'background-root' },
                surface: 'background',
                resolveCurrentPluginMaterializationRef: callerMaterialization.resolveCurrentPluginMaterializationRef,
                signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: { execute: vi.fn() },
            invokeContributedAction,
        });

        await expect(service.execute(
            { pluginId: 'acme.target', localId: 'publish' },
            { title: 'Ready' },
        )).resolves.toEqual({ accepted: true });
        expect(invokeContributedAction).toHaveBeenCalledWith({
            action: { pluginId: 'acme.target', localId: 'publish' },
            input: { title: 'Ready' },
            surface: 'plugin',
            originSurface: 'background',
            initiatingActionCaller: {
                kind: 'plugin', pluginId: 'acme.background', contributionLocalId: 'gateway-supervisor',
                occurrenceId: 'background-occurrence-1', sourceCustody: { kind: 'development', registeredRootId: 'background-root' },
                materialization: callerMaterialization.materialization,
            },
            caller: {
                kind: 'plugin',
                pluginId: 'acme.background',
                contribution: {
                    id: 'gateway-supervisor',
                    qualifiedId: 'acme.background/backgroundServices/gateway-supervisor',
                },
                occurrenceId: 'background-occurrence-1', sourceCustody: { kind: 'development', registeredRootId: 'background-root' },
                materialization: callerMaterialization.materialization,
                originSurface: 'background',
            },
            signal,
        });
    });

    it('fails closed instead of inventing caller authority when its own materialization is unavailable', async () => {
        const invokeContributedAction = vi.fn(async () => ({
            status: 'executed' as const,
            value: { accepted: true },
        }));
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.unbound', version: '1.0.0' },
                contribution: { id: 'caller', qualifiedId: 'acme.unbound/actions/caller' },
                occurrenceId: 'occurrenceId-1',
                surface: 'agent',
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: { execute: vi.fn() },
            invokeContributedAction,
        });

        await expect(service.execute(
            { pluginId: 'acme.target', localId: 'publish' },
            { title: 'Ready' },
        )).rejects.toMatchObject({ code: 'plugin_action_caller_unavailable' });
        expect(invokeContributedAction).not.toHaveBeenCalled();
    });

    it('fails closed for unknown and plugin-unavailable runtime action strings', async () => {
        const execute = vi.fn();
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.caller', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('acme.caller').resolveCurrentPluginMaterializationRef,
                occurrenceId: 'occurrenceId-1',
                surface: 'ui',
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: { execute },
            invokeContributedAction: vi.fn(),
        });

        await expect(Reflect.apply(service.execute, service, ['unknown.action', {}]))
            .rejects.toMatchObject({ code: 'plugin_action_unknown' });
        // This raw durable Start is known to the host Action registry but not
        // exposed on the Plugin surface. Runtime calls that bypass the SDK
        // type union must fail that generic surface admission before parsing
        // the raw RPC input schema.
        await expect(Reflect.apply(service.execute, service, ['sessions.external.takeover.start', {}]))
            .rejects.toMatchObject({ code: 'plugin_action_not_available' });
        expect(execute).not.toHaveBeenCalled();
    });

    it('exposes bounded Session-subagent reads to plugin callers and keeps lifecycle mutations internal', async () => {
        const subagentRef = {
            id: 'subagent-1',
            parentSessionId: 'session-bound',
            origin: 'agent' as const,
            kind: 'native' as const,
            agentRef: { agentId: 'codex' },
            status: 'pending' as const,
            createdAt: 123,
        };
        const execute = vi.fn(async (actionId: string, _input: unknown, _context: unknown) => {
            if (actionId === 'sessions.subagents.list') {
                return { ok: true as const, result: [subagentRef] };
            }
            if (actionId === 'sessions.subagents.get') {
                return { ok: true as const, result: subagentRef };
            }
            return { ok: true as const, result: { kind: 'snapshot' as const, subagents: [subagentRef] } };
        });
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.caller', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('acme.caller').resolveCurrentPluginMaterializationRef,
                occurrenceId: 'occurrenceId-1',
                surface: 'ui',
                session: { id: 'session-bound' },
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: { execute },
            invokeContributedAction: vi.fn(),
        });

        await expect(Reflect.apply(service.execute, service, ['sessions.subagents.list', {}]))
            .resolves.toEqual([subagentRef]);
        await expect(Reflect.apply(service.execute, service, ['sessions.subagents.get', { id: 'subagent-1' }]))
            .resolves.toEqual(subagentRef);
        await expect(Reflect.apply(service.execute, service, ['sessions.subagents.watch', {}]))
            .resolves.toEqual({ kind: 'snapshot', subagents: [subagentRef] });
        expect(execute).toHaveBeenCalledTimes(3);
        for (const call of execute.mock.calls) {
            expect(call[2]).toMatchObject({
                surface: 'plugin',
                authority: 'account_automation',
            });
        }

        const unavailableExecute = vi.fn();
        const guardedService = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.caller', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('acme.caller').resolveCurrentPluginMaterializationRef,
                occurrenceId: 'occurrenceId-1',
                surface: 'ui',
                session: { id: 'session-bound' },
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: { execute: unavailableExecute },
            invokeContributedAction: vi.fn(),
        });
        for (const actionId of [
            'sessions.subagents.upsert',
            'sessions.subagents.updateStatus',
            'sessions.subagents.complete',
        ] as const) {
            await expect(Reflect.apply(guardedService.execute, guardedService, [actionId, {}]))
                .rejects.toMatchObject({ code: 'plugin_action_not_available' });
        }

        expect(unavailableExecute).not.toHaveBeenCalled();
    });

    it('invokes an executor-backed runtime action through its exact canonical schemas', async () => {
        const execute = vi.fn(async () => ({
            ok: true as const,
            result: {
                v: 1 as const,
                commandId: 'command-1',
                status: 'dispatched' as const,
                adapterKind: 'chromiumSidecar' as const,
                events: [],
            },
        }));
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.browser', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('acme.browser').resolveCurrentPluginMaterializationRef,
                occurrenceId: 'occurrenceId-1',
                surface: 'ui',
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: { execute },
            invokeContributedAction: vi.fn(),
        });

        await expect(service.execute('browser.navigate', {
            kind: 'navigate',
            commandId: 'command-1',
            browserSessionId: 'browser-session-1',
            viewId: 'view-1',
            url: 'https://example.com',
        })).resolves.toMatchObject({ status: 'dispatched', commandId: 'command-1' });
        await expect(Reflect.apply(service.execute, service, ['browser.navigate', {
            kind: 'navigate',
            commandId: 'command-2',
            browserSessionId: 'browser-session-1',
            viewId: 'view-1',
        }])).rejects.toMatchObject({ code: 'plugin_action_input_schema_invalid' });
        expect(execute).toHaveBeenCalledTimes(1);
    });

    it('composes caller cancellation with occurrenceId retirement and rejects late publication', async () => {
        let current = true;
        const retirement = new AbortController();
        const caller = new AbortController();
        const execute = vi.fn(async (
            _actionId: unknown,
            _input: unknown,
            context?: Readonly<{ signal?: AbortSignal }>,
        ) => {
            expect(context?.signal).not.toBe(caller.signal);
            expect(context?.signal).not.toBe(retirement.signal);
            expect(context?.signal?.aborted).toBe(false);
            current = false;
            return { ok: true as const, result: { v: 1, ok: true as const, hits: [] } };
        });
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.memory', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('acme.memory').resolveCurrentPluginMaterializationRef,
                occurrenceId: 'occurrenceId-1',
                surface: 'cli',
                signal: retirement.signal,
                isOccurrenceCurrent: () => current,
            },
            actionExecutor: { execute },
            invokeContributedAction: vi.fn(),
        });

        await expect(service.execute('memory.search', {
            machineId: 'machine-1',
            query: { v: 1, query: 'x', scope: { type: 'global' }, mode: 'hints' },
        }, { signal: caller.signal })).rejects.toMatchObject({
            code: 'plugin_action_generation_retired',
        });
    });

    it('rechecks occurrenceId authority immediately before invoking the host Action executor', async () => {
        let currentnessReads = 0;
        const execute = vi.fn(async () => ({
            ok: true as const,
            result: { v: 1, ok: true as const, hits: [] },
        }));
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.memory', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('acme.memory').resolveCurrentPluginMaterializationRef,
                occurrenceId: 'occurrenceId-1',
                surface: 'agent',
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => {
                    currentnessReads += 1;
                    return currentnessReads === 1;
                },
            },
            actionExecutor: { execute },
            invokeContributedAction: vi.fn(),
        });

        await expect(service.execute('memory.search', {
            machineId: 'machine-1',
            query: {
                v: 1,
                query: 'witness race',
                scope: { type: 'global' },
                mode: 'hints',
            },
        })).rejects.toMatchObject({
            code: 'plugin_action_generation_retired',
        });
        expect(execute).not.toHaveBeenCalled();
    });
});
