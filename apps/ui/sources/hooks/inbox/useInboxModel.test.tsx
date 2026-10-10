import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPlainAccountEncryptionCurrentnessFixture, createSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization/keys';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { FeaturesResponseSchema, compilePluginJsonSchema, encodePluginCollectionLogicalValueV1, isValidPluginJsonSchemaValue,
    normalizePluginAccountCollectionContractV1, PluginAccountCollectionContributionV1Schema } from '@happier-dev/protocol';
import { ConversationBindingV1Schema } from '@happier-dev/channels-protocol/v1';
import { replacePluginAccountAvailabilityProjection } from '@/sync/domains/plugins/availability/projection';
import { resetActivePluginCollectionChanges } from '@/sync/api/plugins/data/pluginCollectionChangeWatch';
import { recordAccountStoredContentServerRequirements } from '@/sync/http/accountStoredContentCompatibility';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions';
import { invokeMountedWorkRead } from '@/sync/ops/actions/mountedWorkReadAction';
import { deleteServerFeaturesSnapshot, primeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { createAutomationRunFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { WorkflowRunListPage } from '@/sync/domains/workflows/workflowRunListActions';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { useSessionManagedWorkflowRuns, type SessionManagedWorkflowRunsState } from '@/components/sessions/workState/useSessionManagedWorkflowRuns';
import { projectWork, resolveWorkReadPresentation } from '@/components/sessions/work/workProjection';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { createUsageNoticeArtifactFixture, usageNoticeFixture } from '@/dev/testkit/fixtures/usageNoticeFixtures';

import { InboxModelProvider, useInboxModel, type InboxModel } from './useInboxModel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The Inbox model groups by work root over the real classifier and the real workflow window.
 * Boundaries: the Run-list Action (network) and the Action front door (host executor).
 */
const listRuns = vi.hoisted(() => vi.fn<(params: { filter?: Record<string, unknown> }) => Promise<WorkflowRunListPage>>());
const executed = vi.hoisted(() => [] as Array<{ actionId: string; input: unknown }>);
const automationBoundary = vi.hoisted(() => ({ request: vi.fn() }));
const collectionBoundary = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope', () => ({
    captureServerRequestAuthorityForServerAccountScope: async ({ scope }: { scope: import('@/sync/domains/scope/serverAccountScope').ServerAccountScope }) => ({
        scope, context: { token: 'account-token' }, request: collectionBoundary.request,
    }),
}));
vi.mock('@/sync/http/client', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/http/client')>(), serverFetch: automationBoundary.request,
}));
let appliedSnapshot: typeof import('@/sync/domains/server/serverRuntime')['getActiveServerSnapshot'];
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({
    createFrontDoorActionExecute: () => async (actionId: string, input: unknown) => {
        if (actionId === 'workflow.run.list') return { ok: true, result: await listRuns(input as { filter?: Record<string, unknown> }) };
        executed.push({ actionId, input });
        return { ok: true, result: {} };
    },
}));
vi.mock('@/hooks/server/useFriendsEnabled', () => ({ useFriendsEnabled: () => false }));
vi.mock('@/hooks/server/useFriendsIdentityReadiness', () => ({ useFriendsIdentityReadiness: () => ({ isReady: false }) }));

function page(runs: ReturnType<typeof createWorkflowRunSummaryFixture>[]): WorkflowRunListPage {
    return { runs, metadataByRunId: {}, nextCursor: undefined };
}

let model: InboxModel | null = null;
const readExecutor = createActionExecutor({ appShellAction: invokeMountedWorkRead } as unknown as ActionExecutorDeps);
function readInbox(accountId = 'account-a') {
    return readExecutor.execute('inbox.get', {}, { surface: 'agent', authority: 'account_automation',
        serverId: appliedSnapshot().serverId, runtimeAccountId: accountId });
}
function Probe(): null {
    model = useInboxModel();
    return null;
}

async function renderModel() {
    const screen = await renderScreen(<InboxModelProvider><Probe /></InboxModelProvider>);
    await act(async () => {});
    return screen;
}

describe('useInboxModel work groups (ORC R-10)', () => {
    beforeEach(async () => {
        const runtime = await import('@/sync/domains/server/serverRuntime');
        appliedSnapshot = runtime.getActiveServerSnapshot;
        await runtime.upsertAndActivateServer({ serverUrl: 'http://inbox-home.test', name: 'Inbox Home' });
        publishAppliedActiveServerSnapshot(appliedSnapshot());
        (await import('@/components/workflows/library/workflowLibraryReads')).resetWorkflowLibraryReadsForTests();
        model = null;
        executed.length = 0;
        listRuns.mockReset();
        automationBoundary.request.mockReset();
        collectionBoundary.request.mockReset();
        automationBoundary.request.mockImplementation(async () => new Response(JSON.stringify({ runs: [], nextCursor: null }), { status: 200 }));
        const base = createRootLayoutFeaturesResponse();
        primeServerFeaturesSnapshot({ snapshot: { status: 'ready', features: FeaturesResponseSchema.parse({
            ...base, features: { ...base.features, workflows: { enabled: true }, automations: { ...base.features.automations, enabled: true } },
        }) } });
        storage.setState({
            settings: { ...storage.getState().settings, experiments: true, featureToggles: { ...storage.getState().settings.featureToggles, automations: true } },
            profileScope: { serverId: runtime.getActiveServerSnapshot().serverId, accountId: 'account-a' },
            friends: {},
            sessions: {},
            sessionListRowsByServerId: {},
            ordinarySessionListMembershipByServerId: {},
            artifacts: {},
            isDataReady: true,
            workflowRunsById: {},
            workflowRunListWindows: {},
            sessionOrganizationAttentionStandingsBySessionKey: {},
        } as never);
    });

    afterEach(async () => {
        standardCleanup();
        deleteServerFeaturesSnapshot();
        (await import('@/components/workflows/library/workflowLibraryReads')).resetWorkflowLibraryReadsForTests();
        (await import('@/sync/domains/scope/activeServerAccountScope')).retireActiveServerAccountScopeLifetime();
    });

    it('projects only current Account-owned readable open usage notices without creating Sessions', async () => {
        listRuns.mockResolvedValue(page([]));
        const notice = usageNoticeFixture;
        const owned = createUsageNoticeArtifactFixture();
        const rows: DecryptedArtifact[] = [owned,
            { ...owned, id: 'foreign', ownerAccountId: 'account-b' },
            { ...owned, id: 'shared', access: 'view' },
            { ...owned, id: 'published', publicAudience: 'retained' },
            { ...owned, id: 'unknown-audience', publicAudience: 'unknown' },
            createUsageNoticeArtifactFixture({ id: 'dismissed', header: { ...owned.header!, status: 'dismissed' }, body: undefined }),
            createUsageNoticeArtifactFixture({ id: 'invalid', header: { ...owned.header!, notice: { ...notice, evidence: {} } }, body: undefined }),
            createUsageNoticeArtifactFixture({ id: 'body-mismatch', body: JSON.stringify({ v: 1, notice: { ...notice, issueFingerprint: 'other' } }) }),
            createUsageNoticeArtifactFixture({ id: 'header-only', body: undefined }),
            { ...owned, id: 'locked', isDecrypted: false, title: null, header: null,
                rawHeader: null, body: undefined, sessions: undefined, draft: undefined,
                storageMode: 'e2ee', availability: { kind: 'locked', reason: 'decryption_failed' } },
        ];
        storage.setState({ artifacts: Object.fromEntries(rows.map(row => [row.id, row])) });

        await renderModel();

        expect(model).toMatchObject({ openUsageNotices: [{ artifact: owned, header: owned.header }],
            hasPrimaryAttention: true, showCaughtUp: false });
        expect(model?.workGroups).toEqual([]);
        expect(storage.getState().sessions).toEqual({});
        expect(await readInbox()).toMatchObject({ ok: true, result: { status: 'ready', usageNoticeIds: ['notice-owned'] } });

        await act(async () => { storage.setState({ artifacts: {
            ...storage.getState().artifacts,
            'header-only': createUsageNoticeArtifactFixture({ id: 'header-only' }),
        } }); });
        expect(model?.openUsageNotices.map(entry => entry.artifact.id)).toEqual(['notice-owned', 'header-only']);

        await act(async () => { storage.setState({ profileScope: {
            ...storage.getState().profileScope!, accountId: 'account-b',
        } }); });
        expect(model).toMatchObject({ openUsageNotices: [{ artifact: rows[1] }], hasPrimaryAttention: true });
        expect(await readInbox()).toMatchObject({ ok: true, result: { status: 'unavailable' } });
        expect(await readInbox('account-b')).toMatchObject({ ok: true, result: { status: 'ready', usageNoticeIds: ['foreign'] } });
    });

    it('retries an initially unreadable Work window through the same Action and distinguishes proven empty work', async () => {
        listRuns.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(page([]));
        let workRead: SessionManagedWorkflowRunsState | null = null;
        const projection = projectWork({
            sessionId: 'session-1', reportSessions: [], agentEntries: [], workflowHeadlineRuns: [], managedRuns: [],
            ownTriggerRunIds: new Set(), describeAgentStatus: (entry) => entry.status,
            describeProgress: ({ completed, total }) => `${completed} of ${total}`,
        });
        function WorkProbe() {
            workRead = useSessionManagedWorkflowRuns({ sessionId: 'session-1', serverId: appliedSnapshot().serverId });
            return null;
        }
        function currentRead(): SessionManagedWorkflowRunsState | null { return workRead; }
        await renderScreen(<WorkProbe />);
        await act(async () => {});
        const read = () => resolveWorkReadPresentation({ projection, managedRuns: workRead, transcriptLoaded: true });
        expect(read()).toEqual({ nothingYet: false, holdWorkingPlace: false, managedUnavailable: true });
        await act(async () => { currentRead()?.retry(); });
        expect(read()).toEqual({ nothingYet: true, holdWorkingPlace: false, managedUnavailable: false });
    });

    it('exposes a pre-session Automation failure with its exact Run route and removes it on the Account wake', async () => {
        listRuns.mockResolvedValue(page([]));
        automationBoundary.request.mockResolvedValueOnce(new Response(JSON.stringify({
            runs: [createAutomationRunFixture({ id: 'pre-session', state: 'failed', errorCode: 'machine_unavailable' })], nextCursor: null,
        }), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify({ runs: [], nextCursor: null }), { status: 200 }));
        await renderModel();
        expect(model?.automationAttentionItems).toEqual([expect.objectContaining({
            key: 'automation-run:pre-session', run: expect.objectContaining({ producedSessionId: null }),
            route: { pathname: '/automations/[id]/runs/[runId]', params: { id: 'automation-1', runId: 'pre-session' } },
        })]);
        expect(model?.hasPrimaryAttention).toBe(true);
        await act(async () => { publishHomeAccountChange(appliedSnapshot().serverId, ['automation:automation-1']); });
        expect(model?.automationAttentionItems).toEqual([]);
        expect(model?.showCaughtUp).toBe(true);
        expect(automationBoundary.request).toHaveBeenCalledTimes(2);
    });

    it('lists an off-page hold once as its own work root, and lets it recede when it leaves the window', async () => {
        listRuns
            .mockResolvedValueOnce(page([createWorkflowRunSummaryFixture({ id: 'run-held', state: 'interrupted' })]))
            .mockResolvedValueOnce(page([]));

        const screen = await renderModel();

        expect(model?.workGroups.map((group) => group.key)).toEqual(['run:run-held']);
        expect(model?.workGroups[0]?.items.map((item) => item.key)).toEqual(['run:run-held']);
        expect(model?.hasPrimaryAttention).toBe(true);
        expect(await readInbox()).toMatchObject({ ok: true, result: { status: 'ready', groups: [
            { key: model?.workGroups[0]?.key, root: { kind: 'run', runId: 'run-held' },
                items: [{ kind: 'workflow_run', key: model?.workGroups[0]?.items[0]?.key, runId: 'run-held' }] },
        ] } });
        expect(await readInbox('different-account')).toMatchObject({ ok: true, result: { status: 'unavailable' } });

        await act(async () => {
            publishHomeAccountChange(appliedSnapshot().serverId, ['workflow-run:run-held']);
        });
        await act(async () => {});

        expect(model?.workGroups).toEqual([]);
        await screen.unmount();
        expect(await readInbox()).toMatchObject({ ok: true, result: { status: 'unavailable' } });
    });

    it('reads a valid single-Home missing lead and refuses the real mixed-Home model rather than filtering it empty', async () => {
        listRuns.mockResolvedValue(page([]));
        const serverId = appliedSnapshot().serverId;
        const first = createSessionFixture({ id: 'child', serverId, reportsTo: { sessionId: 'unknown-lead' } });
        const foreign = createSessionFixture({ id: 'foreign', serverId: 'other-home' });
        const remindAt = Date.now() + 60_000;
        storage.setState({ sessions: { child: first }, sessionOrganizationAttentionStandingsBySessionKey: {
            [buildSessionOrganizationSessionKey(serverId, first.id)]: { sessionId: first.id, standing: true, remindAt, updatedAt: 1 },
        } });
        await renderModel();
        expect(model?.workGroups[0]?.root).toEqual({ kind: 'lead', sessionId: 'unknown-lead', session: null });
        expect(await readInbox()).toMatchObject({ ok: true, result: { status: 'ready', groups: [
            { key: 'lead:unknown-lead', root: { kind: 'lead', sessionId: 'unknown-lead' },
                items: [{ kind: 'snoozed', serverId, sessionId: first.id, remindAt }] },
        ] } });
        await act(async () => { storage.setState({ sessions: { child: first, foreign },
            sessionOrganizationAttentionStandingsBySessionKey: {
                ...storage.getState().sessionOrganizationAttentionStandingsBySessionKey,
                [buildSessionOrganizationSessionKey('other-home', foreign.id)]: { sessionId: foreign.id, standing: true, remindAt, updatedAt: 1 },
            } }); });
        expect(model?.workGroups.flatMap(group => group.items)).toHaveLength(2);
        expect(await readInbox()).toMatchObject({ ok: true, result: { status: 'unavailable' } });
    });

    it('projects retained Channel PR bindings into Landing and refreshes through the existing Account collection', async () => {
        listRuns.mockResolvedValue(page([]));
        const { PLUGIN_MANIFEST } = await import('@happier-dev/plugins-channels/manifest');
        const contribution = PLUGIN_MANIFEST.contributes?.accountCollections?.find(entry => entry.id === 'channel-state');
        const contract = normalizePluginAccountCollectionContractV1({ pluginId: 'happier.channels',
            contribution: PluginAccountCollectionContributionV1Schema.parse(contribution) });
        const validate = compilePluginJsonSchema(contract.schema);
        const binding = ConversationBindingV1Schema.parse({
            v: 1, id: 'binding-1', connectionId: 'connection-1', createdAt: 1, updatedAt: 1,
            endpoint: { kind: 'githubPullRequest', audience: 'shared', id: 'pr-1' },
            target: { kind: 'session', sessionId: 'session-1', pullRequestLink: { repository: 'acme/widgets', number: 1 },
                policy: { deliveryMode: 'repliesOnly', permissionCeiling: 'read-only', approvals: { kind: 'off' }, newSession: { kind: 'off' } } },
            allowedPrincipalIds: ['principal-1'], allowBotSenders: false, inputMode: 'directMentionsOnly', inboundDebounceMs: 0,
            linkPreviewPolicy: 'suppress', senderFeedback: 'off', authorityEpoch: 1, enabled: false, deletionState: 'none',
        });
        const { v, id, connectionId, createdAt, updatedAt, ...payload } = binding;
        const encoded = encodePluginCollectionLogicalValueV1({ contract,
            isValidLogicalValue: value => isValidPluginJsonSchemaValue(validate, value),
            value: { id, 'record-kind': 'binding', v, 'connection-id': connectionId, 'binding-id': id,
                'created-at': createdAt, 'updated-at': updatedAt, payload },
            encryptionMode: 'plain', material: null, randomBytes: length => new Uint8Array(length).fill(9),
        });
        if (encoded.status !== 'encoded') throw new Error(encoded.reason);
        let rows = [{ rowId: encoded.rowId, revision: 1, projection: encoded.projection, content: encoded.content }];
        collectionBoundary.request.mockImplementation(async (path: string) => new Response(JSON.stringify(
            path === '/v1/account/encryption/currentness' ? createPlainAccountEncryptionCurrentnessFixture()
                : path === '/v1/plugins/data/contract' ? { access: 'readOnly', contract }
                    : { rows, changeCursor: 18 },
        ), { status: 200 }));
        const scope = storage.getState().profileScope!;
        recordAccountStoredContentServerRequirements({ serverUrl: appliedSnapshot().serverUrl,
            requirements: { v: 1, minimumProtocolVersion: 2, currentProtocolVersion: 3,
                declarationTransport: 'http-header-and-socket-auth-v1' } });
        replacePluginAccountAvailabilityProjection({ scope, snapshot: {
            availabilityCursor: 7, materializations: [], snapshots: [], intentReads: [{ pluginId: contract.pluginId,
                response: { availabilityCursor: 7, packageAssets: [],
                    hostingCapability: { enabled: true, maxArtifactBytes: 1024, maxAccountBytes: 2048 },
                    intent: { pluginId: contract.pluginId, desiredVersion: null, enabled: true, offlineUiHosting: 'enabled',
                        writableCollections: [{ pluginId: contract.pluginId, collectionId: contract.collectionId,
                            schemaVersion: contract.schemaVersion, contractDigest: contract.contractDigest }], revision: 'intent-7' },
                    release: null, uiArtifacts: [] },
            }],
        } });
        const session = createSessionFixture({ id: 'session-1', serverId: scope.serverId, active: false, seq: 0 });
        storage.setState({ sessions: { [session.id]: session } });
        await renderModel();
        expect(model?.workGroups.flatMap(group => group.items).filter(item => item.kind === 'landing'))
            .toMatchObject([{ kind: 'landing', session, link: { sessionId: session.id, serverId: scope.serverId, number: 1 } }]);
        await act(async () => {
            rows = [];
            resetActivePluginCollectionChanges();
        });
        expect(model?.workGroups.flatMap(group => group.items).filter(item => item.kind === 'landing')).toEqual([]);
    });

    it('settles through the one attention Action and the read-state Action, in that order', async () => {
        listRuns.mockResolvedValue(page([]));
        await renderModel();

        await act(async () => {
            await model?.settle({ id: 'session-1', serverId: 'home-a' } as Session);
        });

        expect(executed).toEqual([
            { actionId: 'session.attention.set', input: { sessionId: 'session-1', standing: false } },
            { actionId: 'session.read_state.set', input: { sessionId: 'session-1', state: 'read' } },
        ]);
    });

    it('does not claim caught up after an initial workflow failure, and retries into grouped attention', async () => {
        listRuns.mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce(page([createWorkflowRunSummaryFixture({ id: 'run-held', state: 'interrupted' })]));
        await renderModel();

        expect(model?.workflowAttention.phase).toBe('failed');
        expect(model?.isLoading).toBe(false);
        expect(model?.showCaughtUp).toBe(false);
        expect(await readInbox()).toMatchObject({ ok: true, result: { status: 'unavailable' } });

        await act(async () => { model?.workflowAttention.retry(); });
        expect(model?.workflowAttention.phase).toBe('loaded');
        expect(model?.workGroups.map((group) => group.key)).toEqual(['run:run-held']);
    });

    it('waits for the first workflow read rather than showing caught up', async () => {
        listRuns.mockImplementation(() => new Promise(() => {}));
        await renderModel();

        expect(model?.workflowAttention.phase).toBe('loading');
        expect(model?.isLoading).toBe(true);
        expect(model?.showCaughtUp).toBe(false);
        expect(await readInbox()).toMatchObject({ ok: true, result: { status: 'loading' } });
    });

    it('keeps known groups during a failed workflow refresh and recovers on retry', async () => {
        listRuns.mockResolvedValueOnce(page([createWorkflowRunSummaryFixture({ id: 'run-held', state: 'interrupted' })]))
            .mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(page([]));
        await renderModel();
        const knownGroups = model?.workGroups;

        await act(async () => { model?.workflowAttention.retry(); });
        expect(model?.workflowAttention.refreshFailed).toBe(true);
        expect(model?.workGroups).toBe(knownGroups);
        expect(model?.showCaughtUp).toBe(false);

        await act(async () => { model?.workflowAttention.retry(); });
        expect(model?.workflowAttention.refreshFailed).toBe(false);
        expect(model?.showCaughtUp).toBe(true);
    });

    it('does not treat a failed refresh of a previously empty workflow list as caught up', async () => {
        listRuns.mockResolvedValueOnce(page([])).mockRejectedValueOnce(new Error('offline'));
        await renderModel();
        expect(model?.showCaughtUp).toBe(true);

        await act(async () => { model?.workflowAttention.retry(); });
        expect(model?.workflowAttention.refreshFailed).toBe(true);
        expect(model?.showCaughtUp).toBe(false);
    });

    it('snoozes with remindAt and clears it with null through the same Action', async () => {
        listRuns.mockResolvedValue(page([]));
        await renderModel();

        await act(async () => {
            await model?.setReminder({ id: 'session-1', serverId: 'home-a' } as Session, 9_000);
            await model?.setReminder({ id: 'session-1', serverId: 'home-a' } as Session, null);
        });

        expect(executed).toEqual([
            { actionId: 'session.attention.set', input: { sessionId: 'session-1', remindAt: 9_000 } },
            { actionId: 'session.attention.set', input: { sessionId: 'session-1', remindAt: null } },
        ]);
    });
});
