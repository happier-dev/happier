import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Imported from their own testkit modules rather than the `@/dev/testkit`
 * barrel. The barrel re-exports `fixtures/agentCatalogFixtures`, whose
 * production projection reaches `@/sync/runtime/orchestration/connectionManager`
 * and, through it, `@/sync/http/client` and the reachability fetch. Evaluating
 * that graph on this file's first import binds the real transports and freezes
 * the applied active Home to the built-in default *before*
 * `installHomeGovernanceBoundaries` can install either boundary, so every Home
 * request leaves the harness and the screen never settles. This is the same
 * rule the harness states for its own late imports.
 */
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import {
    homeAccountDetailFixture,
    homeAccountRowFixture,
    homeAdministrationEventFixture,
    homeGovernanceProjectionFixture,
} from '@/dev/testkit/fixtures/homeGovernanceFixtures';
import {
    createAccountTokenForTests,
    createHomeGovernanceHarness,
    installHomeGovernanceBoundaries,
    waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { collectRenderedTestIds } from '@/dev/testkit/render/collectRenderedTestIds';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { createManagedResourceDependencyFixture } from '@/dev/testkit/fixtures/managedResourceDependencyFixtures';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const modalState = vi.hoisted(() => ({
    confirmResult: true,
    /** When set, decides the confirmation instead (a case that acts while the dialog is open). */
    confirmWith: null as null | (() => Promise<boolean>),
    confirms: [] as Array<{ title: string; body: string | undefined; options?: Parameters<typeof import('@/modal')['Modal']['confirm']>[2] }>,
    alerts: [] as Array<{ title: string; body: string }>,
    /** What the person types into the reason prompt; `null` cancels it. */
    promptResult: 'Impersonation report' as string | null,
    promptResults: [] as Array<string | null>,
    prompts: [] as Array<{ title: string; body: string | undefined; defaultValue?: string }>,
}));
const routerBack = vi.hoisted(() => vi.fn());
const announceAccessibilityMessage = vi.hoisted(() => vi.fn());
const sockets = vi.hoisted(() => new Map<string, import('socket.io-client').Socket>());
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
const captureSocket = (socket: import('socket.io-client').Socket, url: string | undefined) => {
    if (url) sockets.set(new URL(url).origin, socket);
};
installDisconnectedServerSocketBoundary(captureSocket);
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;

vi.mock('@/components/ui/accessibility/announceAccessibilityMessage', () => ({
    announceAccessibilityMessage,
}));

installSettingsViewCommonModuleMocks({
    storage: 'real',
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ router: { push: vi.fn(), back: routerBack }, navigation: { setOptions: vi.fn() } }).module;
    },
    // The modal is a platform presentation boundary; the confirmation decision
    // it returns is what this surface is being tested against.
    modal: async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
        spies: {
            confirm: async (title, body, options) => {
                modalState.confirms.push({ title, body, options });
                return modalState.confirmWith ? await modalState.confirmWith() : modalState.confirmResult;
            },
            alertAsync: async (title: string, body: string) => {
                modalState.alerts.push({ title, body });
            },
            prompt: async (title: string, body?: string, options?: { defaultValue?: string }) => {
                modalState.prompts.push({ title, body, defaultValue: options?.defaultValue });
                return modalState.promptResults.length ? modalState.promptResults.shift() ?? null : modalState.promptResult;
            },
        },
    }).module,
});

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);

// Load the real owner after transport setup, outside an individual test's deadline.
await loadSyncSingletonForTests();
const [{ HomeAdministrationAccountScreen }, { resetHomeGovernanceEngineForTests }, { AuthProvider, ConcurrentSessionCacheRuntime }] = await Promise.all([
    import('./HomeAdministrationAccountScreen'),
    import('@/sync/engine/home/governance/homeGovernanceEngine'),
    import('@/auth/context/AuthContext'),
]);

const GOVERNANCE_PATH = '/v1/home/governance/get';
const LIST_PATH = '/v1/home/accounts/list';
const GET_PATH = '/v1/home/accounts/get';
const ROLE_PATH = '/v1/home/accounts/role/set';
const DISABLE_PATH = '/v1/home/accounts/disable';
const DELETE_PATH = '/v1/home/accounts/delete';
const SIGN_OUT_PATH = '/v1/home/accounts/sign-out-everywhere';
const RESTRICT_PATH = '/v1/home/public-profiles/ada/restrict';
const RESTORE_PATH = '/v1/home/public-profiles/ada/restore';
const RECLAIM_PATH = '/v1/home/public-profiles/ada/handle-reclaim';

/**
 * The answer the Home actually returns from the disable intent: its declared
 * Action output is the updated `HomeAccountRowV1`, so a body that is not one is
 * a refusal rather than a completed mutation.
 */
function disabledAccountRow() {
    return homeAccountRowFixture('ada', {
        status: 'suspended',
        mutationCapabilities: {
            setRole: {
                member: { status: 'unavailable', reason: 'target_inactive' },
                admin: { status: 'unavailable', reason: 'target_inactive' },
                owner: { status: 'unavailable', reason: 'target_inactive' },
            },
            disable: { status: 'unavailable', reason: 'target_not_active' },
            reenable: { status: 'available' },
            delete: { status: 'available' },
            signOutEverywhere: { status: 'unavailable', reason: 'target_not_active' },
        },
    });
}

async function renderAccount(serverId: string, accountId = 'ada', observeHomes = false) {
    resetHomeGovernanceEngineForTests();
    let content = <HomeAdministrationAccountScreen serverId={serverId} accountId={accountId} />;
    if (observeHomes) {
        content = <ConcurrentSessionCacheRuntime>{content}</ConcurrentSessionCacheRuntime>;
    }
    const screen = await renderScreen(content);
    await waitForHomeGovernance(() => {
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-account-machines');
    });
    return screen;
}

async function renderAccountLookup(serverId: string, accountId = 'ada') {
    resetHomeGovernanceEngineForTests();
    return renderScreen(
        <HomeAdministrationAccountScreen serverId={serverId} accountId={accountId} />,
    );
}

async function addAdministeredHome(options?: Readonly<{
    projection?: Parameters<typeof homeGovernanceProjectionFixture>[0];
    detail?: ReturnType<typeof homeAccountDetailFixture>;
    currentAccount?: boolean;
}>): Promise<string> {
    const home = await harness.addHome({
        name: 'Home A',
        serverUrl: 'https://home-a.example',
        accountId: 'account-admin',
        currentAccount: options?.currentAccount ?? true,
    });
    harness.answer(home, GOVERNANCE_PATH, {
        body: homeGovernanceProjectionFixture(options?.projection),
    });
    harness.answer(home, GET_PATH, { body: options?.detail ?? homeAccountDetailFixture('ada') });
    return home;
}

beforeEach(async () => {
    // Reclaim this suite's network boundary after a real connection fixture is disposed.
    installHomeGovernanceBoundaries(harness);
    const { resetHomeGovernanceSnapshotsForTests } = await import(
        '@/sync/store/home/governance/homeGovernanceSnapshots'
    );
    resetHomeGovernanceSnapshotsForTests();
    const { resetServerFeaturesClientForTests } = await import(
        '@/sync/api/capabilities/serverFeaturesClient'
    );
    resetServerFeaturesClientForTests();
    await harness.reset();
    modalState.confirmResult = true;
    modalState.confirmWith = null;
    modalState.confirms = [];
    modalState.alerts = [];
    modalState.promptResult = 'Impersonation report';
    modalState.promptResults = [];
    modalState.prompts = [];
    routerBack.mockReset();
    announceAccessibilityMessage.mockReset();
    sockets.clear();
});

afterEach(async () => {
    standardCleanup();
    await connection?.dispose(); connection = null;
    installDisconnectedServerSocketBoundary(captureSocket);
});

function lastOwnerCapabilities() {
    return {
        setRole: {
            member: { status: 'unavailable', reason: 'last_active_owner' },
            admin: { status: 'unavailable', reason: 'last_active_owner' },
            owner: { status: 'unavailable', reason: 'unchanged' },
        },
        disable: { status: 'unavailable', reason: 'last_active_owner' },
        reenable: { status: 'unavailable', reason: 'target_not_suspended' },
        delete: { status: 'unavailable', reason: 'last_active_owner' },
        signOutEverywhere: { status: 'available' },
    } as const;
}

describe('HomeAdministrationAccountScreen', () => {
    it('reads the person in one request and never pages the roster to find them', async () => {
        const home = await addAdministeredHome();

        await renderAccount(home);

        expect(harness.requestsFor(GET_PATH)).toHaveLength(1);
        expect(harness.requestsFor(GET_PATH)[0]?.input).toEqual({ accountId: 'ada' });
        expect(harness.requestsFor(LIST_PATH)).toHaveLength(0);
    });

    it('shows Teams, linked providers, machine and token counts and the latest events about the person', async () => {
        const home = await addAdministeredHome({
            projection: {
                authenticationOptions: {
                    methods: [
                        { id: 'email_password', displayName: 'Email and password', actions: [] },
                        { id: 'github', displayName: 'GitHub', actions: [] },
                    ],
                    permittedAccountModes: ['e2ee'],
                    recommendedProvisioningMode: 'e2ee',
                    signInService: { deploymentMode: null, canDisable: false },
                },
            },
            detail: homeAccountDetailFixture('ada', {
                authentication: {
                    signInEmail: 'ada@example.test',
                    usableMethodIds: ['email_password'],
                    linkedProviderIds: ['github'],
                },
                teams: [
                    { teamId: 'team-platform', name: 'Platform', role: 'member', status: 'active', archived: false },
                    { teamId: 'team-design', name: 'Design', role: 'admin', status: 'active', archived: true },
                ],
                machines: { count: 2 },
                apiTokens: { count: 3, lastUsedAt: 1_700_000_000_000 },
                recentEvents: [homeAdministrationEventFixture({
                    id: 'event-1',
                    action: 'account.role.set',
                    target: { kind: 'account', id: 'ada', profile: null },
                    summary: { from: 'member', to: 'admin' },
                })],
            }),
        });

        const screen = await renderAccount(home);
        const text = screen.getTextContent();
        const ids = collectRenderedTestIds(screen.tree.toJSON());

        expect(text).toContain('ada@example.test');
        expect(text).toContain('Email and password');
        expect(text).toContain('GitHub');
        expect(ids).toEqual(expect.arrayContaining(['home-account-team:team-platform', 'home-account-team:team-design']));
        expect(text).toContain('Platform');
        expect(text).toContain('homeGovernance.person.teamArchived');
        expect(text).toContain('2');
        expect(text).toContain('3');
        expect(ids).toContain('home-activity-row:event-1');
        expect(ids).toContain('home-account-activity-all');
    });

    it('signs the person out everywhere through the exact Home after an explicit confirmation', async () => {
        const home = await addAdministeredHome();
        harness.answer(home, SIGN_OUT_PATH, { body: homeAccountRowFixture('ada') });

        const screen = await renderAccount(home);
        await screen.pressByTestIdAsync('home-account-sign-out-everywhere-button');

        await waitForHomeGovernance(() => expect(harness.requestsFor(SIGN_OUT_PATH)).toHaveLength(1));
        expect(modalState.confirms).toHaveLength(1);
        const [request] = harness.requestsFor(SIGN_OUT_PATH);
        expect(request?.serverId).toBe(home);
        expect(request?.input).toEqual({ accountId: 'ada' });
        expect(request?.token).toBe(createAccountTokenForTests('account-admin', { currentAccount: true }));
    });

    it('does nothing when someone else signs in on this Home while the sign-out confirmation is open', async () => {
        const home = await addAdministeredHome();
        harness.answer(home, SIGN_OUT_PATH, { body: homeAccountRowFixture('ada') });
        const screen = await renderAccount(home);

        // The confirmation was opened as `account-admin`; before it is accepted, another Account
        // takes this Home's credential. Accepting must not act as the new Account.
        modalState.confirmWith = async () => {
            await harness.switchAccount(home, 'account-intruder');
            return true;
        };
        await screen.pressByTestIdAsync('home-account-sign-out-everywhere-button');

        await waitForHomeGovernance(() => expect(modalState.confirms).toHaveLength(1));
        await flushHookEffects();
        expect(harness.requestsFor(SIGN_OUT_PATH)).toHaveLength(0);
    });

    it('binds every destructive People action to the Account captured when its confirmation opened', async () => {
        for (const testID of ['home-account-sign-out-everywhere-button', 'home-account-delete']) {
            await harness.reset();
            modalState.alerts = [];
            modalState.confirms = [];
            const home = await addAdministeredHome();
            const screen = await renderAccount(home);
            modalState.confirmWith = async () => {
                await harness.switchAccount(home, 'account-intruder');
                return true;
            };
            await screen.pressByTestIdAsync(testID);
            await waitForHomeGovernance(() => expect(modalState.confirms).toHaveLength(1));
            await flushHookEffects();
            expect(harness.requestsFor(DISABLE_PATH)).toHaveLength(0);
            expect(harness.requestsFor(DELETE_PATH)).toHaveLength(0);
            expect(harness.requestsFor(ROLE_PATH)).toHaveLength(0);
            act(() => screen.tree.unmount());
            modalState.confirmWith = null;
        }
    });

    it('changes a role directly by default without a caller confirmation', async () => {
        const home = await addAdministeredHome();
        harness.answer(home, ROLE_PATH, { body: homeAccountRowFixture('ada', { homeRole: 'admin' }) });
        const screen = await renderAccount(home);

        modalState.confirmResult = false;
        await screen.pressByTestIdAsync('home-account-role:admin');
        await waitForHomeGovernance(() => expect(harness.requestsFor(ROLE_PATH)).toHaveLength(1));
        expect(modalState.confirms).toHaveLength(0);
        expect(harness.requestsFor(ROLE_PATH)[0]?.input).toEqual({ accountId: 'ada', homeRole: 'admin' });
    });

    it('uses one native Action confirmation for a configured role change', async () => {
        const home = await addAdministeredHome({ currentAccount: true });
        await harness.requireUiApproval(home, 'home.accounts.role.set');
        const screen = await renderAccount(home);
        await screen.pressByTestIdAsync('home-account-role:admin');
        await waitForHomeGovernance(() => expect(harness.requestsFor(ROLE_PATH)).toHaveLength(1));
        expect(harness.requestsFor(ROLE_PATH)[0]?.input).toEqual({ accountId: 'ada', homeRole: 'admin' });
        expect(harness.artifacts(home).list()).toHaveLength(0);
        expect(modalState.confirms).toHaveLength(1);
    });

    it('explains the last active owner instead of offering a demotion, disable or delete that would strand the Home', async () => {
        const home = await addAdministeredHome({
            projection: { activeOwnerCount: 1 },
            detail: homeAccountDetailFixture('ada', { homeRole: 'owner', mutationCapabilities: lastOwnerCapabilities() }),
        });

        const screen = await renderAccount(home);
        const ids = collectRenderedTestIds(screen.tree.toJSON());
        // No inert controls: the role chooser, Disable and Delete are withheld and the reason is stated.
        expect(ids).not.toContain('home-account-role:member');
        expect(ids).not.toContain('home-account-disable');
        expect(ids).not.toContain('home-account-delete');
        expect(ids).toContain('home-account-access-unavailable');
        expect(screen.getTextContent()).toContain('homeGovernance.reasonLastActiveOwner');
        // Ending sessions changes no role, so the last owner can still be signed out everywhere.
        expect(ids).toContain('home-account-sign-out-everywhere-button');
    });

    it('does not offer sign-out everywhere for a person who is no longer active', async () => {
        const home = await addAdministeredHome({
            detail: homeAccountDetailFixture('ada', { status: 'suspended', mutationCapabilities: disabledAccountRow().mutationCapabilities }),
        });

        const screen = await renderAccount(home);
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('home-account-sign-out-everywhere');
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-account-enable');
    });

    it('announces one completed Account mutation through the shared accessibility owner', async () => {
        const home = await addAdministeredHome();
        harness.answer(home, DISABLE_PATH, { body: disabledAccountRow() });

        const screen = await renderAccount(home);
        await screen.pressByTestIdAsync('home-account-disable');

        await waitForHomeGovernance(() => expect(announceAccessibilityMessage).toHaveBeenCalledOnce());
        expect(announceAccessibilityMessage).toHaveBeenLastCalledWith('homeGovernance.disable. common.success');
    });

    it('never exposes unlabelled method identifiers as a label', async () => {
        const home = await addAdministeredHome({
            projection: {
                authenticationOptions: {
                    methods: [{ id: 'managed-okta', displayName: 'Acme SSO', actions: [] }],
                    permittedAccountModes: ['e2ee'],
                    recommendedProvisioningMode: 'e2ee',
                    signInService: { deploymentMode: null, canDisable: false },
                },
            },
            detail: homeAccountDetailFixture('ada', {
                authentication: { signInEmail: null, usableMethodIds: ['managed-okta'], linkedProviderIds: [] },
            }),
        });

        const screen = await renderAccount(home);
        expect(screen.getTextContent()).toContain('Acme SSO');
        expect(screen.getTextContent()).toContain('settingsAccount.nativePassword.signInEmailNotSet');
        expect(screen.getTextContent()).toContain('homeGovernance.person.none');
    });

    it('shows a failed read with retry instead of claiming the person is absent', async () => {
        const home = await addAdministeredHome();
        harness.answer(home, GET_PATH, { status: 503, body: { error: 'temporarily_unavailable' } });

        const screen = await renderAccountLookup(home);
        await waitForHomeGovernance(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-account-error');
        });
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('home-account-unavailable');

        harness.answer(home, GET_PATH, { body: homeAccountDetailFixture('ada') });
        await screen.pressByTestIdAsync('home-account-retry');
        await waitForHomeGovernance(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-account-machines');
        });
    });

    it('shows not found only when the Home says the person does not exist', async () => {
        const home = await addAdministeredHome();
        harness.answer(home, GET_PATH, { status: 404, body: { error: 'home_account_not_found' } });

        const screen = await renderAccountLookup(home);
        await waitForHomeGovernance(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-account-unavailable');
        });
    });

    it.each([
        { status: 404, error: 'home_account_not_found', state: 'home-account-unavailable' },
        { status: 403, error: 'home_governance_forbidden', state: 'home-account-forbidden' },
    ])('withdraws a populated detail after an authoritative $status refresh', async ({ status, error, state }) => {
        const home = await addAdministeredHome();
        const screen = await renderAccount(home);
        harness.answer(home, GET_PATH, { status, body: { error } });
        const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
        await act(async () => publishHomeAccountChange(home));
        await waitForHomeGovernance(() => expect(screen.findByTestId(state)).not.toBeNull());
        expect(screen.findByTestId('home-account-machines')).toBeNull();
        expect(screen.findByTestId('home-account-disable')).toBeNull();
    });

    it('keeps last-known person detail with a visible refresh error and Retry after a transient failure', async () => {
        const home = await addAdministeredHome();
        const screen = await renderAccount(home);
        harness.answer(home, GET_PATH, { status: 503, body: { error: 'temporarily_unavailable' } });
        const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
        await act(async () => publishHomeAccountChange(home));
        await waitForHomeGovernance(() => expect(screen.findByTestId('home-account-refresh-error')).not.toBeNull());
        expect(screen.findByTestId('home-account-machines')).not.toBeNull();
        harness.answer(home, GET_PATH, { body: homeAccountDetailFixture('ada', { machines: { count: 7 } }) });
        await screen.pressByTestIdAsync('home-account-refresh-error-action');
        await waitForHomeGovernance(() => expect(screen.findByTestId('home-account-refresh-error')).toBeNull());
        expect(screen.findHostByTestId('home-account-machines')?.findAll((node) => node.children.includes('7')).length).toBeGreaterThan(0);
    });

    it('disables an account through the exact Home with no default confirmation', async () => {
        const home = await addAdministeredHome();
        harness.answer(home, DISABLE_PATH, { body: disabledAccountRow() });

        const screen = await renderAccount(home);
        await screen.pressByTestIdAsync('home-account-disable');

        await waitForHomeGovernance(() => expect(harness.requestsFor(DISABLE_PATH)).toHaveLength(1));
        const [request] = harness.requestsFor(DISABLE_PATH);
        expect(request?.serverId).toBe(home);
        expect(request?.input).toEqual({ accountId: 'ada' });
    });

    it('exposes the exact pending lifecycle action as busy and prevents a duplicate submission', async () => {
        const home = await addAdministeredHome();
        let finishDisable: (() => void) | null = null;
        const disableResponse = new Promise<void>((resolve) => { finishDisable = resolve; });
        harness.answer(home, DISABLE_PATH, { body: disabledAccountRow(), respondAfter: disableResponse });

        const screen = await renderAccount(home);
        await screen.pressByTestIdAsync('home-account-disable');

        await waitForHomeGovernance(() => expect(harness.requestsFor(DISABLE_PATH)).toHaveLength(1));
        const pending = screen.findByTestId('home-account-disable');
        expect(pending?.props.accessibilityState).toMatchObject({ busy: true, disabled: true });
        await screen.pressByTestIdAsync('home-account-disable');
        expect(harness.requestsFor(DISABLE_PATH)).toHaveLength(1);

        await act(async () => {
            finishDisable?.();
            await disableResponse;
        });
    });

    it('sends the change to the Home being administered, not the focused one', async () => {
        const administered = await addAdministeredHome();
        const focused = await harness.addHome({
            name: 'Home B',
            serverUrl: 'https://home-b.example',
            accountId: 'account-other',
        });
        harness.answer(focused, GOVERNANCE_PATH, { body: homeGovernanceProjectionFixture() });
        harness.answer(focused, DISABLE_PATH, { body: disabledAccountRow() });
        harness.answer(administered, DISABLE_PATH, { body: disabledAccountRow() });

        const screen = await renderAccount(administered);
        await screen.pressByTestIdAsync('home-account-disable');

        await waitForHomeGovernance(() => expect(harness.requestsFor(DISABLE_PATH)).toHaveLength(1));
        expect(harness.requestsFor(DISABLE_PATH)[0]?.serverId).toBe(administered);
        expect(harness.requestsFor(DISABLE_PATH)[0]?.serverUrl).toBe('https://home-a.example');
    });

    it('changes nothing and stays quiet when the shared destructive confirmation is declined', async () => {
        const home = await addAdministeredHome();
        harness.answer(home, DELETE_PATH, { body: { status: 'deleted' } });
        modalState.confirmResult = false;

        const screen = await renderAccount(home);
        await screen.pressByTestIdAsync('home-account-delete');
        await waitForHomeGovernance(() => expect(modalState.confirms).toHaveLength(1));
        await flushHookEffects();
        expect(harness.requestsFor(DELETE_PATH)).toHaveLength(0);
        expect(modalState.alerts).toHaveLength(0);
    });

    it('offers Re-enable only for the reversible hold, never for a retired account', async () => {
        const held = await addAdministeredHome({
            detail: homeAccountDetailFixture('ada', { status: 'suspended', mutationCapabilities: disabledAccountRow().mutationCapabilities }),
        });
        const screen = await renderAccount(held);
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-account-enable');

        await harness.reset();
        const retired = await addAdministeredHome({
            detail: homeAccountDetailFixture('ada', {
                status: 'disabled',
                mutationCapabilities: {
                    setRole: {
                        member: { status: 'unavailable', reason: 'target_inactive' },
                        admin: { status: 'unavailable', reason: 'target_inactive' },
                        owner: { status: 'unavailable', reason: 'target_inactive' },
                    },
                    disable: { status: 'unavailable', reason: 'target_retired' },
                    reenable: { status: 'unavailable', reason: 'target_retired' },
                    delete: { status: 'available' },
                    signOutEverywhere: { status: 'unavailable', reason: 'target_not_active' },
                },
            }),
        });
        const retiredScreen = await renderAccount(retired);
        expect(collectRenderedTestIds(retiredScreen.tree.toJSON())).not.toContain('home-account-enable');
        expect(collectRenderedTestIds(retiredScreen.tree.toJSON())).toContain('home-account-delete');
    });

    it('reports an unfinished deletion as unfinished and keeps the page open', async () => {
        const home = await addAdministeredHome();
        harness.answer(home, DELETE_PATH, { body: { status: 'disabled_pending_completion' } });

        const screen = await renderAccount(home);
        await screen.pressByTestIdAsync('home-account-delete');

        await waitForHomeGovernance(() => {
            expect(modalState.alerts).toHaveLength(1);
            expect(harness.requestsFor(GET_PATH)).toHaveLength(2);
        });
        expect(routerBack).not.toHaveBeenCalled();
    });

    it.each(['deleted', 'disabled_pending_completion'] as const)('retains its own Account deletion acknowledgement after remote sign-out (%s)', async status => {
        const home = await addAdministeredHome({
            projection: { viewer: { accountId: 'account-admin', homeRole: 'owner', status: 'active' } },
            detail: homeAccountDetailFixture('account-admin', { homeRole: 'owner' }),
        });
        harness.answer(home, DELETE_PATH, { select: async () => {
            const auth = (await import('@/auth/context/currentAuth')).getCurrentAuth();
            if (!auth) throw new Error('Expected real authenticated Home owner');
            await auth.logout();
            return { body: { status } };
        } });
        const screen = await renderScreen(<AuthProvider initialCredentials={{ token: createAccountTokenForTests('account-admin', { currentAccount: true }) }}>
            <HomeAdministrationAccountScreen serverId={home} accountId="account-admin" />
        </AuthProvider>);
        await waitForHomeGovernance(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-account-machines'));
        await screen.pressByTestIdAsync('home-account-delete');
        await waitForHomeGovernance(() => {
            if (status === 'disabled_pending_completion') {
                expect(modalState.alerts).toContainEqual({ title: 'homeGovernance.deleteIncompleteTitle', body: 'homeGovernance.deleteIncompleteBody' });
                expect(routerBack).not.toHaveBeenCalled();
            } else expect(routerBack).toHaveBeenCalled();
        });
        expect((await import('@/auth/context/currentAuth')).getCurrentAuth()?.isAuthenticated).toBe(false);
        expect(harness.requestsFor(DELETE_PATH)[0]?.input).toEqual({ accountId: 'account-admin' });
        expect(harness.requestsFor(GET_PATH)).toHaveLength(1);
    });

    it('leaves the person page once a deletion actually completed', async () => {
        const home = await addAdministeredHome();
        harness.answer(home, DELETE_PATH, { body: { status: 'deleted' } });

        const screen = await renderAccount(home);
        await screen.pressByTestIdAsync('home-account-delete');

        await waitForHomeGovernance(() => expect(routerBack).toHaveBeenCalled());
    });

    it('requires renewed resource consent and deletes only the same person on the originally captured Home', async () => {
        const home = await addAdministeredHome();
        const resources = [createManagedResourceDependencyFixture(7), createManagedResourceDependencyFixture(8)];
        let attempts = 0;
        harness.answer(home, DELETE_PATH, { select: () => attempts++ < 2
            ? { status: 409, body: { error: 'account_erasure_managed_resources_review_required', resources: [resources[attempts - 1]] } }
            : { body: { status: 'deleted' } } });
        const screen = await renderAccount(home);
        // Focusing a different saved Home while reviewing cannot retarget an administrator's captured person.
        modalState.confirmWith = async () => {
            if (modalState.confirms.length === 2) await harness.addHome({ name: 'Other', serverUrl: 'https://other-delete.example', accountId: 'other' });
            return true;
        };
        await screen.pressByTestIdAsync('home-account-delete');
        await waitForHomeGovernance(() => expect(routerBack).toHaveBeenCalled());
        expect(modalState.confirms).toHaveLength(5);
        expect(modalState.confirms[1]?.options?.messageParagraphs?.some(paragraph => paragraph.text.includes('native-1'))).toBe(true);
        expect(harness.requestsFor(DELETE_PATH).map(request => ({ serverId: request.serverId, input: request.input }))).toEqual([
            { serverId: home, input: { accountId: 'ada' } },
            ...resources.map(resource => ({ serverId: home, input: { accountId: 'ada', managedResourceDispositions: [{
                managedId: resource.managedId, expectedIntentRevision: resource.intentRevision, expectedAllocation: resource.allocation,
                expectedResource: resource.resource, expectedNativeOperationRef: resource.nativeOperationRef,
                expectedRecovery: resource.recovery, responsibility: 'manual',
            }] } })),
        ]);
    });

    it.each(['cancel', 'credential-retired'] as const)('keeps the person and does not retry resource deletion after %s during review', async interruption => {
        const home = await addAdministeredHome();
        harness.answer(home, DELETE_PATH, { status: 409, body: { error: 'account_erasure_managed_resources_review_required',
            resources: [createManagedResourceDependencyFixture()] } });
        const screen = await renderAccount(home);
        modalState.confirmWith = async () => {
            if (modalState.confirms.length === 1) return true;
            if (interruption === 'cancel') return false;
            await harness.switchAccount(home, 'different-admin');
            return true;
        };
        await screen.pressByTestIdAsync('home-account-delete');
        await waitForHomeGovernance(() => expect(harness.requestsFor(DELETE_PATH)).toHaveLength(1));
        await flushHookEffects();
        expect(modalState.confirms).toHaveLength(2);
        expect(harness.requestsFor(DELETE_PATH)).toHaveLength(1);
        expect(routerBack).not.toHaveBeenCalled();
        expect(announceAccessibilityMessage).not.toHaveBeenCalled();
    });

    it('reviews the Home resource refusal and confirms the exact retry on the administered Home', async () => {
        installDisconnectedServerSocketBoundary((socket, url) => {
            captureSocket(socket, url);
            configureConnectedServerSocketBoundary(socket);
        });
        const home = await addAdministeredHome({ currentAccount: true });
        const resource = createManagedResourceDependencyFixture();
        let attempts = 0;
        harness.answer(home, DELETE_PATH, { select: () => attempts++ === 0
            ? { status: 409, body: { error: 'account_erasure_managed_resources_review_required', resources: [resource] } }
            : { body: { status: 'deleted' } } });
        await harness.requireUiApproval(home, 'home.accounts.delete');
        const focused = await harness.addHome({ name: 'Focused Home', serverUrl: 'https://focused-delete.example', accountId: 'focused-account', currentAccount: true });
        for (const serverId of [home, focused]) harness.answer(serverId, '/v1/auth/ping', { body: {} });
        await harness.selectHomes([home, focused]);
        connection = await restoreServerAccountForTest({ serverUrl: 'https://focused-delete.example', accountId: 'focused-account',
            credentials: { token: createAccountTokenForTests('focused-account', { currentAccount: true }) },
            additionalRequestOrigins: ['https://home-a.example'],
            request: harness.request,
        });
        const { storage } = await import('@/sync/domains/state/storage');
        const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
        const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
        const focusedScope = { serverId: resolveServerProfileScopeIdForIdentifier(focused), accountId: 'focused-account' };
        storage.getState().activateProfileScope(focusedScope);
        const screen = await renderAccount(home, 'ada', true);
        await waitForHomeGovernance(() => expect(sockets.get('https://home-a.example')?.listeners('update').length).toBeGreaterThan(0));
        expect(sockets.get('https://home-a.example')?.connected).toBe(true);
        expect(sockets.get('https://focused-delete.example')?.connected).toBe(true);
        expect(getActiveServerAccountScope()).toEqual(focusedScope);

        await screen.pressByTestIdAsync('home-account-delete');

        await waitForHomeGovernance(() => expect(routerBack).toHaveBeenCalled());
        expect(getActiveServerAccountScope()).toEqual(focusedScope);
        expect(harness.artifacts(home).list()).toHaveLength(0);
        expect(harness.requestsFor(DELETE_PATH).every(request => request.token === createAccountTokenForTests('account-admin', { currentAccount: true }))).toBe(true);
        // The Action confirms each new operand; the intervening resource review
        // is the person's separate decision to assume manual responsibility.
        expect(modalState.confirms).toHaveLength(3);
        expect(harness.requestsFor(DELETE_PATH).map(request => ({ serverId: request.serverId, input: request.input }))).toEqual([
            { serverId: home, input: { accountId: 'ada' } },
            { serverId: home, input: { accountId: 'ada', managedResourceDispositions: [{ managedId: resource.managedId,
                expectedIntentRevision: resource.intentRevision, expectedAllocation: resource.allocation,
                expectedResource: resource.resource, expectedNativeOperationRef: resource.nativeOperationRef,
                expectedRecovery: resource.recovery, responsibility: 'manual' }] } },
        ]);
    });

    it('never claims nothing changed when a dispatched mutation lost its answer', async () => {
        const home = await addAdministeredHome();
        harness.answer(home, DISABLE_PATH, { dispatchThenFail: true });

        const screen = await renderAccount(home);
        await screen.pressByTestIdAsync('home-account-disable');

        await waitForHomeGovernance(() => expect(modalState.alerts).toHaveLength(1));
        const alert = modalState.alerts[0]!;
        expect(`${alert.title} ${alert.body}`).toContain('errorOutcomeUnknown');
        await waitForHomeGovernance(() => expect(harness.requestsFor(GET_PATH).length).toBeGreaterThan(1));
    });

    it('carries the Home typed refusal back instead of a generic failure', async () => {
        const home = await addAdministeredHome();
        harness.answer(home, DISABLE_PATH, { status: 409, body: { error: 'home_owner_transfer_required' } });

        const screen = await renderAccount(home);
        await screen.pressByTestIdAsync('home-account-disable');

        await waitForHomeGovernance(() => {
            expect(modalState.alerts).toHaveLength(1);
            expect(harness.requestsFor(GET_PATH)).toHaveLength(2);
        });
        expect(modalState.alerts[0]?.body).toContain('errorOwnerTransferRequired');
    });

    it('offers the roles the viewer may actually assign, and no others', async () => {
        const home = await addAdministeredHome({
            projection: { viewer: { accountId: 'account-admin', homeRole: 'admin', status: 'active' } },
            detail: homeAccountDetailFixture('ada', {
                mutationCapabilities: {
                    setRole: {
                        member: { status: 'unavailable', reason: 'unchanged' },
                        admin: { status: 'available' },
                        owner: { status: 'unavailable', reason: 'not_authorized' },
                    },
                    disable: { status: 'available' },
                    reenable: { status: 'unavailable', reason: 'target_not_suspended' },
                    delete: { status: 'unavailable', reason: 'not_authorized' },
                    signOutEverywhere: { status: 'available' },
                },
            }),
        });

        const screen = await renderAccount(home);
        const ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids).toContain('home-account-role:member');
        expect(ids).toContain('home-account-role:admin');
        expect(ids).not.toContain('home-account-role:owner');
    });

    it('states a server-projected Team ownership blocker instead of an inert Delete', async () => {
        const home = await addAdministeredHome({
            detail: homeAccountDetailFixture('ada', {
                mutationCapabilities: {
                    ...homeAccountRowFixture('ada').mutationCapabilities,
                    delete: { status: 'unavailable', reason: 'team_owner_transfer_required' },
                },
            }),
        });

        const screen = await renderAccount(home);
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('home-account-delete');
        expect(screen.getTextContent()).toContain('homeGovernance.errorTeamOwnerTransferRequired');
        expect(harness.requestsFor(DELETE_PATH)).toHaveLength(0);
    });
    describe('public profile moderation', () => {
        it('uses the server decision even when the general Home projection grants management', async () => {
            const home = await addAdministeredHome({ detail: homeAccountDetailFixture('ada', {
                publicProfile: { managementCapability: { status: 'unavailable', reason: 'not_authorized' }, restricted: false },
            }) });
            const screen = await renderAccount(home);
            const ids = collectRenderedTestIds(screen.tree.toJSON());
            expect(ids).not.toContain('home-account-public-profile-restrict');
            expect(ids).not.toContain('home-account-public-profile-restore');
            expect(ids).not.toContain('home-account-public-profile-reclaim');
        });

        it('restricts the public profile with the typed reason through the exact Home and refreshes the audit trail', async () => {
            const home = await addAdministeredHome();
            harness.answer(home, RESTRICT_PATH, { body: { kind: 'updated', record: null } });

            const screen = await renderAccount(home);
            expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('home-account-public-profile-restore');
            expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('home-account-public-profile-reclaim');
            await screen.pressByTestIdAsync('home-account-public-profile-restrict');

            await waitForHomeGovernance(() => expect(harness.requestsFor(RESTRICT_PATH)).toHaveLength(1));
            const [request] = harness.requestsFor(RESTRICT_PATH);
            expect(request?.serverId).toBe(home);
            // The target Account is the route (`/public-profiles/ada/restrict`); the body carries only the reason.
            expect(request?.input).toEqual({ reason: 'Impersonation report' });
            expect(request?.token).toBe(createAccountTokenForTests('account-admin', { currentAccount: true }));
            expect(harness.requestsFor(RESTORE_PATH)).toHaveLength(0);
            await waitForHomeGovernance(() => expect(harness.requestsFor(GET_PATH).length).toBeGreaterThan(1));
        });

        it('restores the public profile with the typed reason', async () => {
            const home = await addAdministeredHome({ detail: homeAccountDetailFixture('ada', {
                publicProfile: { managementCapability: { status: 'available' }, restricted: true },
            }) });
            harness.answer(home, RESTORE_PATH, { body: { kind: 'updated', record: null } });

            const screen = await renderAccount(home);
            expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('home-account-public-profile-restrict');
            modalState.promptResult = '  Reviewed, no violation  ';
            await screen.pressByTestIdAsync('home-account-public-profile-restore');

            await waitForHomeGovernance(() => expect(harness.requestsFor(RESTORE_PATH)).toHaveLength(1));
            expect(harness.requestsFor(RESTORE_PATH)[0]?.input).toEqual({ reason: 'Reviewed, no violation' });
            expect(harness.requestsFor(RESTRICT_PATH)).toHaveLength(0);
        });

        it('sends nothing when the reason is cancelled or left blank', async () => {
            const home = await addAdministeredHome();
            const screen = await renderAccount(home);

            for (const reason of [null, '   ']) {
                modalState.promptResult = reason;
                await screen.pressByTestIdAsync('home-account-public-profile-restrict');
            }
            await flushHookEffects();

            expect(modalState.prompts).toHaveLength(2);
            expect(harness.requestsFor(RESTRICT_PATH)).toHaveLength(0);
        });

        it('hides owner management when the server denies an admin', async () => {
            const home = await addAdministeredHome({
                projection: {
                    viewer: { accountId: 'account-admin', homeRole: 'admin', status: 'active' },
                    capabilities: { ...homeGovernanceProjectionFixture().capabilities, manageHomeRoles: false },
                },
                detail: homeAccountDetailFixture('ada', { homeRole: 'owner', publicProfile: {
                    managementCapability: { status: 'unavailable', reason: 'not_authorized' }, restricted: false,
                } }),
            });

            const screen = await renderAccount(home);
            const ids = collectRenderedTestIds(screen.tree.toJSON());

            expect(ids).not.toContain('home-account-public-profile-restrict');
            expect(ids).not.toContain('home-account-public-profile-restore');
            expect(ids).not.toContain('home-account-public-profile-reclaim');
        });

        it('reclaims the reviewed exact username with reason and notice through the existing Action', async () => {
            const home = await addAdministeredHome({ detail: homeAccountDetailFixture('ada', {
                profile: { ...homeAccountDetailFixture('ada').profile, username: 'reviewed_handle' },
            }) });
            harness.answer(home, RECLAIM_PATH, { body: { username: null, reclaimed: true } });
            modalState.promptResults = ['  Impersonation  ', '  Contact this Home operator to appeal.  '];
            const screen = await renderAccount(home);
            await screen.pressByTestIdAsync('home-account-public-profile-reclaim');
            await waitForHomeGovernance(() => expect(harness.requestsFor(RECLAIM_PATH)).toHaveLength(1));
            expect(harness.requestsFor(RECLAIM_PATH)[0]).toMatchObject({ serverId: home, input: {
                username: 'reviewed_handle', reason: 'Impersonation', notice: 'Contact this Home operator to appeal.',
            } });
            await waitForHomeGovernance(() => expect(harness.requestsFor(GET_PATH).length).toBeGreaterThan(1));
        });

        it('keeps reclaim reason and notice after a stale-name refusal and cancels without dispatch', async () => {
            const home = await addAdministeredHome({ detail: homeAccountDetailFixture('ada', {
                profile: { ...homeAccountDetailFixture('ada').profile, username: 'reviewed_handle' },
            }) });
            harness.answer(home, RECLAIM_PATH, { status: 409, body: { error: 'username-changed' } });
            const screen = await renderAccount(home);
            modalState.promptResults = ['Impersonation', 'Contact the operator.'];
            await screen.pressByTestIdAsync('home-account-public-profile-reclaim');
            await waitForHomeGovernance(() => expect(modalState.alerts).toHaveLength(1));
            expect(modalState.alerts[0]?.body).toContain('publicProfileReclaimChangedBody');
            modalState.promptResults = ['Impersonation', null];
            await screen.pressByTestIdAsync('home-account-public-profile-reclaim');
            expect(modalState.prompts.slice(-2).map(prompt => prompt.defaultValue)).toEqual(['Impersonation', 'Contact the operator.']);
            expect(harness.requestsFor(RECLAIM_PATH)).toHaveLength(1);
        });

        it('does not infer operator authority from a Home answer without profile facts', async () => {
            const home = await addAdministeredHome({ detail: homeAccountDetailFixture('ada', { publicProfile: undefined }) });
            const screen = await renderAccount(home);
            expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('home-account-public-profile-reclaim');
            expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('home-account-public-profile-restrict');
        });
    });
});
