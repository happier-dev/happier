import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import {
    ApprovalRequestV1Schema,
    ApprovalRequestV2Schema} from '@happier-dev/protocol/approvals/approvalRequestV1';
import {
    buildApprovalRequestArtifactHeaderV1,
    buildTargetActionApprovalArtifactHeaderV1,
    type ApprovalArtifactHeaderV1,
} from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { TargetActionApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';

// Imported from their owning testkit modules, never the `@/dev/testkit` barrel:
// the harness installs its network boundaries with `vi.doMock`, which only
// reaches modules imported afterwards (see `installHomeGovernanceBoundaries`).
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { teamSummaryFixture } from '@/dev/testkit/fixtures/teamFixtures';
import {
    createHomeGovernanceHarness,
    installHomeGovernanceBoundaries,
    waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { buildDiscussionRequesterApprovalArtifact } from '@/dev/testkit/fixtures/discussionRequesterApprovalArtifact';

/**
 * The exact-Home approval reader over real saved Homes and their stateful
 * Artifact stores.
 *
 * Home resolution (portable identity → this device's local profile), the scoped
 * Account context, the Artifact codec and the Home's own rows are all real; only
 * the network and the device credential store are replaced. An approval is
 * either created by the product's present-user front door or stored through the
 * Home's Artifact route the way any client of that route can — never injected
 * into an internal store.
 */

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
// Load the real reader/executor after boundary registration, before timed cases.
// Cold transformation of their module graphs is not the approval contract.
await import('@/sync/ops/actions/defaultActionExecutor');
const { useApprovalArtifact } = await import('./useApprovalArtifact');

const ACCOUNT_ID = 'account-1';
// Real published identities: the profile owner ignores a malformed one, so a
// fixture outside this shape would silently model a Home that published none.
const HOME_IDENTITY = 'srv_home-b';
const OTHER_IDENTITY = 'srv_other-home';

/**
 * One saved, signed-in Home, with this device's live Account scope established
 * the way the sync owner does it for the active Home (`activateAccountSettingsScope`),
 * naming the Home by its scope id — its published identity when it has one.
 */
async function addHome(serverIdentityId: string | null, url = 'https://approval-home-b.example'): Promise<string> {
    const serverId = await harness.addHome({
        name: 'Home B',
        serverUrl: url,
        accountId: ACCOUNT_ID,
        teamsEnabled: true,
        ...(serverIdentityId ? { serverIdentityId } : {}),
    });
    const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
    const { storage } = await import('@/sync/domains/state/storage');
    const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: ACCOUNT_ID };
    await storage.getState().activateSettingsScope(scope, []);
    storage.getState().activateProfileScope(scope, []);
    return serverId;
}

type Reader = Awaited<ReturnType<typeof renderReader>>;

/** Waits for the reader's settled answer, reporting what it last showed and asked. */
async function settle(hook: Reader, artifactId: string, assertion: (state: ReturnType<Reader['getCurrent']>) => void) {
    await vi.waitFor(() => {
        const state = hook.getCurrent();
        const observed = JSON.stringify({
            artifactId: state.artifact?.id ?? null,
            error: state.error,
            invalid: state.invalidArtifact,
            homeUnavailable: state.homeUnavailable,
            loading: state.isLoading,
            reads: harness.requestsFor(`/v1/artifacts/${artifactId}`).map((entry) => entry.serverId),
        });
        try {
            assertion(state);
        } catch (cause) {
            throw new Error(`${observed}: ${String(cause)}`);
        }
    }, { timeout: 20_000 });
}

/** A stored present-user approval, as retained by a client before opening its detail reader. */
async function openPresentUserApproval(serverId: string, options?: Readonly<{ omitPortableIdentity: boolean }>): Promise<string> {
    await harness.requireUiApproval(serverId, 'teams.update');
    const { getServerProfileById, resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
    const serverIdentityId = options?.omitPortableIdentity ? null : getServerProfileById(serverId)?.serverIdentityId;
    // The reader contract starts at retained custody. Use its existing real
    // Artifact route instead of requiring this HTTP fixture to implement the
    // separate Team Action ingress just to arrange a readable approval.
    const request = ApprovalRequestV2Schema.parse({
        v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
        createdBy: { surface: 'system' }, requestedSurface: 'ui',
        executionOriginV1: { v: 1, authority: 'present_user', surface: 'ui', caller: { kind: 'host' },
            serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: ACCOUNT_ID,
            ...(serverIdentityId ? { serverIdentityId } : {}),
            actionId: 'teams.update', requestId: 'rename-1' },
        actionId: 'teams.update',
        actionArgs: { v: 1, teamId: 'team-1', name: 'Renamed' },
        summary: 'Rename Team',
    });
    return await storeApproval(serverId, buildApprovalRequestArtifactHeaderV1(request), request);
}

/** Stores one approval row through the Home's Artifact route, as its creator would. */
async function storeApproval(serverId: string, header: ApprovalArtifactHeaderV1, body: unknown): Promise<string> {
    const { captureActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const context = await captureActionAccountContext(serverId, new AbortController().signal);
    try {
        return await context.createArtifact(header, JSON.stringify(body));
    } finally {
        context.dispose();
    }
}

/** An approval a Home signed for an external API invocation: it records the Home's portable identity. */
function homeSignedRequest(serverId: string, serverIdentityId: string) {
    return ApprovalRequestV2Schema.parse({
        v: 2,
        status: 'open',
        createdAtMs: 1,
        updatedAtMs: 1,
        createdBy: { surface: 'system' },
        requestedSurface: 'api',
        executionOriginV1: {
            v: 1,
            authority: 'account_automation',
            surface: 'api',
            caller: { kind: 'host' },
            serverId,
            serverIdentityId,
            accountId: ACCOUNT_ID,
            principalId: 'principal-1',
            credentialId: 'credential-1',
            actionId: 'session.title.set',
            requestId: 'request-1',
        },
        actionId: 'session.title.set',
        actionArgs: { sessionId: 'session-1', title: 'Updated title' },
        summary: 'Set session title',
    });
}

async function renderReader(artifactId: string, serverId: string | null) {
    return await renderHook(() => useApprovalArtifact({ artifactId, serverId }));
}

/**
 * Puts this Artifact id into the device's active-Home Artifact store the way the
 * product does: an unscoped reader (no Home named) reads it through the active
 * Home and records the row in the one Artifact store.
 */
async function primeActiveHomeArtifactRow(artifactId: string): Promise<number> {
    const active = await renderReader(artifactId, null);
    await settle(active, artifactId, (state) => expect(state.artifact?.id).toBe(artifactId));
    const { storage } = await import('@/sync/domains/state/storage');
    expect(storage.getState().artifacts[artifactId]?.id).toBe(artifactId);
    await active.unmount();
    return harness.requestsFor(`/v1/artifacts/${artifactId}`).length;
}

describe('useApprovalArtifact', () => {
    beforeEach(async () => {
        standardCleanup();
        await harness.reset();
    });

    afterEach(() => standardCleanup());

    it('exposes typed shared-check skips and the Bot holder from its existing Artifact read', async () => {
        const serverId = await addHome(HOME_IDENTITY);
        // Account labels consume the Home the runtime actually applied, not a saved selection alone.
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const stored = buildDiscussionRequesterApprovalArtifact({ serverId, serverIdentityId: HOME_IDENTITY,
            executionAccountId: 'bot-holder', requesterAccountId: ACCOUNT_ID,
            settle: request => ({ ...request, automaticChecks: { phase: 'consent', humanApprovalRequired: true,
                subjects: [], selectionStatus: 'ready', selected: [], consents: [], runs: [], results: [],
                notices: ['machineRequired', 'actorConsentUnavailableForRequester', 'futureReason'].map((reason, index) => ({
                    code: 'action_automation_skipped', reason, automationId: 'shared', triggerId: `check-${index}`, workflowId: 'workflow',
                })),
            } }),
        });
        const { storage } = await import('@/sync/domains/state/storage');
        storage.getState().applyUsers({ 'bot-holder': {
            id: 'bot-holder', name: 'Release owner', firstName: null, lastName: null,
            username: 'release-owner', bio: null, avatar: null, badges: [], status: 'friend', publicKey: null,
        } });
        if (typeof stored.body !== 'string') throw new Error('Expected the fixture approval body');
        const request = ApprovalRequestV2Schema.parse(JSON.parse(stored.body));
        const artifactId = await storeApproval(serverId, buildApprovalRequestArtifactHeaderV1(request), request);
        const hook = await renderReader(artifactId, serverId);
        try {
            await settle(hook, artifactId, state => expect(state.artifact?.id).toBe(artifactId));
            expect(hook.getCurrent().automaticCheckSkips).toMatchObject([
                { reason: 'machineRequired', notice: { triggerId: 'check-0' } },
                { reason: 'actorConsentUnavailableForRequester', notice: { triggerId: 'check-1' } },
                { reason: null, notice: { reason: 'futureReason', triggerId: 'check-2' } },
            ]);
            expect(hook.getCurrent().automaticChecksExecutionAccountName).toBe('Release owner');
            expect(hook.getCurrent().canAllow).toBe(false);
            expect(harness.requestsFor(`/v1/artifacts/${artifactId}`)).toHaveLength(1);
        } finally { await hook.unmount(); }
    });

    it.each([
        { family: 'built_in', accountId: ACCOUNT_ID, decision: 'pending', expected: true },
        { family: 'built_in', accountId: 'another-account', decision: 'pending', expected: false },
        { family: 'built_in', accountId: ACCOUNT_ID, decision: 'skip', expected: false },
        { family: 'target_action', accountId: ACCOUNT_ID, decision: 'pending', expected: true },
    ] as const)('projects automatic consent Allow for its current Account ($family, $accountId, $decision)', async ({ family, accountId, decision, expected }) => {
        const serverId = await addHome(HOME_IDENTITY);
        const base = homeSignedRequest(serverId, HOME_IDENTITY);
        const request = ApprovalRequestV2Schema.parse({ ...base,
            executionOriginV1: { ...base.executionOriginV1, accountId },
            automaticChecks: { phase: 'consent', humanApprovalRequired: false,
                subjects: [], selectionStatus: 'ready', notices: [], runs: [], results: [],
                selected: [{ automationId: 'shared', triggerId: 'check', triggerRevision: 1,
                    ownerAccountId: 'author', workflowId: 'workflow', workflowRevision: 1,
                    actionIds: [family === 'target_action' ? 'action.invoke' : 'session.title.set'],
                    phase: 'before', mode: 'wait', onFailure: 'ask' }],
                consents: [{ automationId: 'shared', triggerId: 'check', decision }],
            },
        });
        const target = family === 'target_action' ? TargetActionApprovalRequestV1Schema.parse({
            v: 1, kind: 'plugin_target_action', status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'cli' }, requestedSurface: 'cli', qualifiedActionId: 'acme.check/actions/run',
            input: {}, sourceCustody: { kind: 'development', registeredRootId: 'source' },
            policyFingerprint: 'b'.repeat(64), subjectFingerprint: 'a'.repeat(64), summary: 'Run check',
            executionOriginV1: { ...request.executionOriginV1, actionId: 'action.invoke' }, automaticChecks: request.automaticChecks,
        }) : null;
        const artifactId = await storeApproval(serverId, target ? buildTargetActionApprovalArtifactHeaderV1(target)
            : buildApprovalRequestArtifactHeaderV1(request), target ?? request);
        const hook = await renderReader(artifactId, serverId);
        try {
            await settle(hook, artifactId, state => expect(state.artifact?.id).toBe(artifactId));
            expect(hook.getCurrent().canAllow).toBe(expected);
            expect(harness.requestsFor(`/v1/artifacts/${artifactId}`)).toHaveLength(1);
        } finally { await hook.unmount(); }
    });

    it.each([true, false])('observes an unfocused approval only for a pending Action (%s)', async (observeWhileUnfocused) => {
        const serverId = await addHome(HOME_IDENTITY);
        const artifactId = await openPresentUserApproval(serverId);
        await addHome(OTHER_IDENTITY, 'https://approval-unfocused-other.example');
        // The Stack screen is the boundary: its navigation object and the blur event a covering page sends.
        const React = await import('react');
        const { NavigationContext } = await import('@react-navigation/native');
        let focused = true;
        const blurListeners = new Set<() => void>();
        const screen = {
            isFocused: () => focused,
            addListener: (event: string, listener: () => void) => {
                if (event !== 'blur') return () => {};
                blurListeners.add(listener);
                return () => { blurListeners.delete(listener); };
            },
        };
        const Screen = (props: React.PropsWithChildren) => React.createElement(
            NavigationContext.Provider, { value: screen as never }, props.children);
        const hook = await renderHook(() => useApprovalArtifact({ artifactId, serverId, observeWhileUnfocused }), { wrapper: Screen });
        try {
            await settle(hook, artifactId, state => expect(state.artifact?.header?.approvalStatus).toBe('open'));
            await act(async () => { focused = false; for (const listener of [...blurListeners]) listener(); });
            await expect(decideApprovalAsInbox(serverId, artifactId, 'reject')).resolves.toMatchObject({ ok: true });
            const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
            await act(async () => { publishHomeAccountChange(serverId, [artifactId], { changeKinds: ['artifact'] }); });
            if (observeWhileUnfocused) {
                await settle(hook, artifactId, state => expect(state.artifact?.header?.approvalStatus).toBe('rejected'));
            } else {
                expect(hook.getCurrent().artifact?.header?.approvalStatus).toBe('open');
            }
        } finally {
            await hook.unmount();
        }
    });

    it('keeps an absent approval reader still when its Home becomes unreachable', async () => {
        const serverId = await addHome(HOME_IDENTITY);
        const request = homeSignedRequest(serverId, HOME_IDENTITY);
        const artifactId = await storeApproval(serverId, buildApprovalRequestArtifactHeaderV1(request), request);
        const { storage } = await import('@/sync/domains/state/storage');
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        const [{ TokenStorage }, { getServerProfileById }] = await Promise.all([
            import('@/auth/storage/tokenStorage'), import('@/sync/domains/server/serverProfiles'),
        ]);
        const serverUrl = getServerProfileById(serverId)!.serverUrl;
        const credentials = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl');
        const targetCredentialReads = () => credentials.mock.calls.filter(([url, options]) => (
            url === serverUrl && options?.storageReadFailure === 'surface'
        )).length;
        const previous = storage.getState();
        const applied = getAppliedActiveServerSnapshot();
        const available = isAppliedActiveServerRuntimeAvailable();
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        storage.setState({ endpointStatus: 'online', socketStatus: 'connected' });
        let renders = 0;
        const hook = await renderHook<ReturnType<typeof useApprovalArtifact>, { artifactId: string | null }>(({ artifactId }) => {
            renders += 1;
            return useApprovalArtifact({ artifactId, serverId });
        }, { initialProps: { artifactId: null } });
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent().homeUnavailable).toBe(false));
            await flushHookEffects();
            expect.soft(targetCredentialReads()).toBe(0);
            const rendersBefore = renders;
            await act(async () => { storage.setState({ endpointStatus: 'offline' }); });
            expect(renders).toBe(rendersBefore);
            expect(hook.getCurrent()).toMatchObject({ homeUnavailable: false, isLoading: false, error: false, artifact: null });
            await act(async () => { storage.setState({ endpointStatus: 'online' }); });
            await hook.rerender({ artifactId });
            await waitForHomeGovernance(() => expect(hook.getCurrent().artifact?.id).toBe(artifactId));
            expect(targetCredentialReads()).toBeGreaterThan(0);
            await act(async () => { storage.setState({ endpointStatus: 'offline' }); });
            expect(hook.getCurrent().homeUnavailable).toBe(true);
            expect(hook.getCurrent().artifact?.id).toBe(artifactId);
            await act(async () => { storage.setState({ endpointStatus: 'online' }); });
            expect(hook.getCurrent().homeUnavailable).toBe(false);
            const readsWithApproval = targetCredentialReads();
            const addressedServerId = hook.getCurrent().serverId;
            await hook.rerender({ artifactId: null });
            await flushHookEffects();
            expect(hook.getCurrent()).toMatchObject({
                artifact: null, accessGrants: null, isLoading: false, homeUnavailable: false, error: false,
                serverId: addressedServerId,
            });
            expect(targetCredentialReads()).toBe(readsWithApproval);
        } finally {
            await hook.unmount();
            credentials.mockRestore();
            storage.setState(previous, true);
            publishAppliedActiveServerSnapshot(applied, available);
        }
    });

    it('stops an empty approval loading state when its Home becomes unreachable without discarding the pending read', async () => {
        const serverId = await addHome(HOME_IDENTITY);
        const artifactId = await openPresentUserApproval(serverId);
        const { storage } = await import('@/sync/domains/state/storage');
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        const previous = storage.getState();
        const applied = getAppliedActiveServerSnapshot();
        const available = isAppliedActiveServerRuntimeAvailable();
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        const path = `/v1/artifacts/${artifactId}`;
        harness.answer(serverId, path, { select: async () => {
            await held;
            const response = await harness.artifacts(serverId).handle(path, { method: 'GET' });
            if (!response) throw new Error('Expected real stored approval response');
            return { body: await response.json() };
        } });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        storage.setState({ artifacts: {}, endpointStatus: 'online', socketStatus: 'connected' });
        const hook = await renderReader(artifactId, serverId);
        try {
            await waitForHomeGovernance(() => expect(harness.requestsFor(path).length).toBeGreaterThan(0));
            expect(hook.getCurrent().isLoading).toBe(true);
            await act(async () => { storage.setState({ endpointStatus: 'offline' }); });
            expect(hook.getCurrent()).toMatchObject({ homeUnavailable: true, isLoading: false, error: true, artifact: null });
            await act(async () => { storage.setState({ endpointStatus: 'online' }); release(); });
            await settle(hook, artifactId, state => expect(state.artifact?.id).toBe(artifactId));
            expect(hook.getCurrent()).toMatchObject({ isLoading: false, error: false, homeUnavailable: false });
        } finally {
            release();
            await hook.unmount();
            storage.setState(previous, true);
            publishAppliedActiveServerSnapshot(applied, available);
        }
    });

    it('keeps an unrelated exact Home wake from invalidating the readable approval', async () => {
        const serverId = await addHome(HOME_IDENTITY);
        const artifactId = await openPresentUserApproval(serverId);
        await addHome(OTHER_IDENTITY, 'https://approval-other-home.example');
        const hook = await renderReader(artifactId, serverId);
        await settle(hook, artifactId, state => expect(state.artifact?.header?.approvalStatus).toBe('open'));
        // Another client deletes this row. Only its own change id may invalidate
        // the retained projection; an unrelated entity says nothing about it.
        harness.answer(serverId, `/v1/artifacts/${artifactId}`, { status: 404 });
        const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
        await act(async () => { publishHomeAccountChange(serverId, ['unrelated-session']); });
        await hook.rerender();
        expect(hook.getCurrent().error).toBe(false);
        expect(hook.getCurrent().artifact?.id).toBe(artifactId);
        await act(async () => { publishHomeAccountChange(serverId, [artifactId]); });
        await settle(hook, artifactId, state => expect(state.error).toBe(true));
        await hook.unmount();
    });

    it('settles a pending deep-link read when this Home is signed out', async () => {
        const serverId = await addHome(HOME_IDENTITY);
        const request = homeSignedRequest(serverId, HOME_IDENTITY);
        const artifactId = await storeApproval(serverId, buildApprovalRequestArtifactHeaderV1(request), request);
        const { storage } = await import('@/sync/domains/state/storage');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { getServerProfileById } = await import('@/sync/domains/server/serverProfiles');
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        const path = `/v1/artifacts/${artifactId}`;
        harness.answer(serverId, path, { respondAfter: held, status: 404 });
        storage.setState({ artifacts: {} });
        const hook = await renderReader(artifactId, HOME_IDENTITY);
        try {
            await waitForHomeGovernance(() => expect(harness.requestsFor(path).length).toBeGreaterThan(0));
            expect(hook.getCurrent().isLoading).toBe(true);
            await act(async () => {
                expect(await TokenStorage.removeCredentialsForServerUrl(
                    getServerProfileById(serverId)!.serverUrl, { serverId },
                )).toBe(true);
            });
            await settle(hook, artifactId, state => {
                expect(state.homeUnavailable).toBe(true);
                expect(state.isLoading).toBe(false);
                expect(state.error).toBe(true);
            });
        } finally {
            release();
            await hook.unmount();
        }
    });

    it('classifies an incompatible body after an exact-Home header-only row is filled', async () => {
        const serverId = await addHome(HOME_IDENTITY);
        const request = homeSignedRequest(serverId, HOME_IDENTITY);
        const artifactId = await storeApproval(serverId, {
            ...buildApprovalRequestArtifactHeaderV1(request), serverIdentityId: OTHER_IDENTITY,
        }, request);
        const { captureActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const { storage } = await import('@/sync/domains/state/storage');
        const context = await captureActionAccountContext(serverId);
        try {
            const full = await context.fetchArtifact(artifactId);
            if (!full) throw new Error('Expected the stored approval');
            storage.getState().deleteArtifact(artifactId);
            storage.getState().updateArtifact({ ...full, body: undefined, bodyVersion: undefined });
            expect(storage.getState().artifacts[artifactId]?.body).toBeUndefined();
        } finally {
            context.dispose();
        }
        const readsBefore = harness.requestsFor(`/v1/artifacts/${artifactId}`).length;
        const hook = await renderReader(artifactId, serverId);
        await settle(hook, artifactId, state => {
            expect(state.invalidArtifact).toBe(true);
            expect(state.isLoading).toBe(false);
            expect(state.error).toBe(true);
        });
        await flushHookEffects();
        expect(harness.requestsFor(`/v1/artifacts/${artifactId}`).length - readsBefore).toBe(1);
    });

    it('projects an accepted exact-Home decision before replay returns, without a remote change or poll', async () => {
        const serverId = await addHome(HOME_IDENTITY);
        const artifactId = await openPresentUserApproval(serverId);
        await addHome(OTHER_IDENTITY, 'https://approval-other-home.example');
        const hook = await renderReader(artifactId, serverId);
        await settle(hook, artifactId, state => expect(state.artifact?.header?.approvalStatus).toBe('open'));

        let executionReached!: () => void;
        let releaseExecution!: () => void;
        const reached = new Promise<void>(resolve => { executionReached = resolve; });
        const released = new Promise<void>(resolve => { releaseExecution = resolve; });
        harness.answer(serverId, '/v1/teams/update', {
            select: async () => {
                executionReached();
                await released;
                return { body: teamSummaryFixture({ name: 'Renamed' }) };
            },
        });
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        let decisionReturned = false;
        const decision = createDefaultActionExecutor().execute('approval.request.decide', {
            artifactId, decision: 'approve',
        }, { surface: 'ui', serverId, authority: 'present_user' }).finally(() => { decisionReturned = true; });
        try {
            await act(async () => { await Promise.race([reached, decision.then(result => {
                throw new Error(`Approval settled before its effect: ${JSON.stringify(result)}`);
            })]); });
            // The server has accepted and claimed the decision, but its side effect
            // is still pending. No socket event, timer, or explicit refresh is sent.
            await settle(hook, artifactId, state => expect(state.artifact?.header?.approvalStatus).toBe('executing'));
            expect(decisionReturned).toBe(false);
        } finally {
            releaseExecution();
            await act(async () => { await decision; });
        }
        await settle(hook, artifactId, state => expect(state.artifact?.header?.approvalStatus).toBe('executed'));
        await hook.unmount();
    });

    it('observes a newer approval revision even when the local acknowledgement timestamp does not advance', async () => {
        // The OS clock is a boundary, not an Artifact revision. Fast acknowledgements
        // can share a millisecond and a server clock can run ahead of this device.
        const serverId = await addHome(HOME_IDENTITY);
        const artifactId = await openPresentUserApproval(serverId);
        const hook = await renderReader(artifactId, serverId);
        await settle(hook, artifactId, state => expect(state.artifact?.header?.approvalStatus).toBe('open'));
        vi.spyOn(Date, 'now').mockReturnValue(hook.getCurrent().artifact!.updatedAt);
        harness.answer(serverId, '/v1/teams/update', { body: teamSummaryFixture({ name: 'Renamed' }) });
        await expect(decideApprovalAsInbox(serverId, artifactId, 'approve')).resolves.toMatchObject({ ok: true });
        expect(hook.getCurrent().artifact?.header?.approvalStatus).toBe('executed');
        expect(ApprovalRequestV2Schema.parse(JSON.parse(hook.getCurrent().artifact!.body as string)))
            .toMatchObject({ status: 'executed', execution: { ok: true } });
        await hook.unmount();
    });

    it('keeps an exact-Home present-user approval readable when its origin declares no portable identity', async () => {
        // A Settings form opens its own deferred approval on one exact Home. Only a
        // Home-signed external invocation records a portable identity, so requiring
        // one here would make every locally admitted V2 approval unreadable.
        const serverId = await addHome(HOME_IDENTITY);
        const artifactId = await openPresentUserApproval(serverId, { omitPortableIdentity: true });

        const hook = await renderReader(artifactId, serverId);

        await waitForHomeGovernance(() => expect(hook.getCurrent().artifact?.id).toBe(artifactId));
        expect(hook.getCurrent().error).toBe(false);
        expect(hook.getCurrent().invalidArtifact).toBe(false);
        expect(ApprovalRequestV2Schema.parse(JSON.parse(hook.getCurrent().artifact!.body as string)))
            .toMatchObject({ status: 'open', actionId: 'teams.update' });
    });

    it('reads through the active Home when the caller names no Home', async () => {
        const serverId = await addHome(null);
        const artifactId = await openPresentUserApproval(serverId);

        const hook = await renderReader(artifactId, null);

        await waitForHomeGovernance(() => expect(hook.getCurrent().artifact?.id).toBe(artifactId));
        expect(hook.getCurrent().error).toBe(false);
    });

    it('observes a committed terminal receipt on an open active-Home detail without reopening or polling', async () => {
        const serverId = await addHome(null);
        const artifactId = await openPresentUserApproval(serverId);
        const hook = await renderReader(artifactId, null);
        await settle(hook, artifactId, state => expect(state.artifact?.header?.approvalStatus).toBe('open'));
        const { encodePlainArtifactStoredContent } = await import('@happier-dev/protocol/storage/artifactStoredContent');
        const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
        const { openArtifactPrivateRevisionMetadata, sealArtifactPrivateRevisionMetadata } = await import('@/sync/domains/artifacts/accountArtifactEnvelope');
        const stored = harness.artifacts(serverId).read(artifactId);
        if (!stored || stored.bodyVersion === undefined) throw new Error('Expected a stored approval body revision');
        const request = ApprovalRequestV2Schema.parse(JSON.parse(harness.artifacts(serverId).readPlainBody(artifactId)!));
        // Persistence is the boundary: another process commits a schema-admitted
        // terminal receipt; this reader receives only the existing content-free wake.
        const terminal = ApprovalRequestV2Schema.parse({ ...request, status: 'executed', updatedAtMs: 5,
            decision: { kind: 'approve', decidedAtMs: 2 }, execution: { ok: true, executedAtMs: 5, result: {} } });
        const provenance = await openArtifactPrivateRevisionMetadata({ mode: 'plain', artifactId,
            bodyVersion: stored.bodyVersion, provenance: stored.provenance });
        harness.artifacts(serverId).replaceStoredRow({ ...stored,
            header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(terminal)),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(terminal) }),
            provenance: provenance ? await sealArtifactPrivateRevisionMetadata({ mode: 'plain', artifactId,
                bodyVersion: stored.bodyVersion + 1, provenance }) : null,
            headerVersion: stored.headerVersion + 1, bodyVersion: stored.bodyVersion + 1, updatedAt: stored.updatedAt + 1 });
        try {
            await act(async () => { publishHomeAccountChange(serverId, [artifactId], { changeKinds: ['artifact'] }); });
            await settle(hook, artifactId, state => {
                expect(state.artifact?.header?.approvalStatus).toBe('executed');
                expect(ApprovalRequestV2Schema.parse(JSON.parse(state.artifact!.body as string)).execution?.ok).toBe(true);
            });
        } finally { await hook.unmount(); }
    });

    it('resolves a portable Home identity to this device local profile before its first body fetch', async () => {
        const serverId = await addHome(HOME_IDENTITY);
        const request = homeSignedRequest(serverId, HOME_IDENTITY);
        const artifactId = await storeApproval(serverId, buildApprovalRequestArtifactHeaderV1(request), request);

        const hook = await renderReader(artifactId, HOME_IDENTITY);

        await settle(hook, artifactId, (state) => expect(state.artifact?.id).toBe(artifactId));
        expect(hook.getCurrent().homeUnavailable).toBe(false);
        expect(harness.requestsFor(`/v1/artifacts/${artifactId}`).map((entry) => entry.serverId))
            .toEqual(expect.arrayContaining([serverId]));
    });

    it('reports an unresolvable portable Home as unavailable instead of reading another Home', async () => {
        const serverId = await addHome(HOME_IDENTITY);
        const request = homeSignedRequest(serverId, HOME_IDENTITY);
        const artifactId = await storeApproval(serverId, buildApprovalRequestArtifactHeaderV1(request), request);
        const readsBefore = await primeActiveHomeArtifactRow(artifactId);

        const hook = await renderReader(artifactId, 'srv_home-not-saved');

        expect(hook.getCurrent().homeUnavailable).toBe(true);
        expect(hook.getCurrent().error).toBe(true);
        // No Home is asked on behalf of an identity this device cannot resolve,
        // and the active Home's row with the same id is not presented as its answer.
        expect(harness.requestsFor(`/v1/artifacts/${artifactId}`)).toHaveLength(readsBefore);
        expect(hook.getCurrent().artifact).toBeNull();
    });

    it('resolves a retained stack-scoped Review URL to the connected Home before reading its approval', async () => {
        const serverId = await addHome(HOME_IDENTITY);
        const stackServerId = 'stack_agent-qa-prs-issues__id_default';
        const [{ MMKV }, { readStorageScopeFromEnv, scopedStorageId }, { getServerProfileById }] = await Promise.all([
            import('react-native-mmkv'),
            import('@/utils/system/storageScope'),
            import('@/sync/domains/server/serverProfiles'),
        ]);
        const profile = getServerProfileById(serverId)!;
        // Device persistence retains the pre-adoption Stack id after learning
        // the Home identity. Exercise the real profile owner over that boundary.
        new MMKV({ id: scopedStorageId('server-profiles', readStorageScopeFromEnv()) }).set('server-state-v1', JSON.stringify({
            activeServerId: serverId,
            servers: { [serverId]: { ...profile, legacyServerIds: [stackServerId] } },
        }));
        expect(getServerProfileById(stackServerId)?.id).toBe(serverId);
        const request = homeSignedRequest(stackServerId, HOME_IDENTITY);
        const artifactId = await storeApproval(serverId, buildApprovalRequestArtifactHeaderV1(request), request);

        const hook = await renderReader(artifactId, stackServerId);

        await settle(hook, artifactId, (state) => expect(state.artifact?.id).toBe(artifactId));
        expect(hook.getCurrent()).toMatchObject({ serverId, homeUnavailable: false, invalidArtifact: false });
        expect(harness.requestsFor(`/v1/artifacts/${artifactId}`).map((entry) => entry.serverId))
            .toEqual(expect.arrayContaining([serverId]));
    });

    it('keeps an approval a 0.2 client created (V1, device-local Home id) readable on its Home', async () => {
        const serverId = await addHome(null);
        const request = ApprovalRequestV1Schema.parse({
            v: 1,
            status: 'open',
            createdAtMs: 1,
            updatedAtMs: 1,
            createdBy: { surface: 'system' },
            actionId: 'session.title.set',
            actionArgs: { sessionId: 'session-1', title: 'Updated title' },
            summary: 'Set session title',
            serverId,
        });
        const artifactId = await storeApproval(
            serverId,
            buildApprovalRequestArtifactHeaderV1(request, { legacyServerId: serverId }),
            request,
        );

        const hook = await renderReader(artifactId, serverId);

        await waitForHomeGovernance(() => expect(hook.getCurrent().artifact?.id).toBe(artifactId));
        expect(hook.getCurrent().error).toBe(false);
    });

    it('fails closed when an exact-Home read returns an approval bound to another portable Home', async () => {
        const serverId = await addHome(HOME_IDENTITY);
        const request = homeSignedRequest(serverId, OTHER_IDENTITY);
        const artifactId = await storeApproval(serverId, buildApprovalRequestArtifactHeaderV1(request), request);

        const hook = await renderReader(artifactId, serverId);

        await settle(hook, artifactId, (state) => expect(state.invalidArtifact).toBe(true));
        expect(hook.getCurrent().error).toBe(true);
        expect(hook.getCurrent().artifact).toBeNull();
    });

    it.each([
        {
            name: 'is missing',
            header: (request: ReturnType<typeof homeSignedRequest>) => {
                const { serverIdentityId: _omitted, ...header } = buildApprovalRequestArtifactHeaderV1(request);
                return header as ApprovalArtifactHeaderV1;
            },
        },
        {
            name: 'names a different Home than its body',
            header: (request: ReturnType<typeof homeSignedRequest>) => ({
                ...buildApprovalRequestArtifactHeaderV1(request),
                serverIdentityId: OTHER_IDENTITY,
            }),
        },
    ])('fails closed when the V2 header identity $name', async ({ header }) => {
        const serverId = await addHome(HOME_IDENTITY);
        const request = homeSignedRequest(serverId, HOME_IDENTITY);
        const artifactId = await storeApproval(serverId, header(request), request);

        const hook = await renderReader(artifactId, HOME_IDENTITY);

        // Classified from a completed read of the Home's row, not merely unread.
        await settle(hook, artifactId, (state) => expect(state.invalidArtifact).toBe(true));
        expect(hook.getCurrent().error).toBe(true);
        expect(hook.getCurrent().artifact).toBeNull();
    });

    it('does not reinterpret an unknown device-local route as V2 Home identity', async () => {
        const serverId = await addHome(HOME_IDENTITY);
        const request = homeSignedRequest(serverId, HOME_IDENTITY);
        const artifactId = await storeApproval(serverId, buildApprovalRequestArtifactHeaderV1(request), request);

        const readsBefore = await primeActiveHomeArtifactRow(artifactId);

        const hook = await renderReader(artifactId, 'unknown-local-home');

        expect(hook.getCurrent().homeUnavailable).toBe(true);
        expect(hook.getCurrent().error).toBe(true);
        expect(harness.requestsFor(`/v1/artifacts/${artifactId}`)).toHaveLength(readsBefore);
        expect(hook.getCurrent().artifact).toBeNull();
    });
});
