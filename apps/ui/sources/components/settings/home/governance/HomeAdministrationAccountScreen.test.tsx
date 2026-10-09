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
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { readApprovalExecutionFailure } from '@happier-dev/protocol/approvals/approvalExecutionFailure';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';

import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const modalState = vi.hoisted(() => ({
    confirmResult: true,
    /** When set, decides the confirmation instead (a case that acts while the dialog is open). */
    confirmWith: null as null | (() => Promise<boolean>),
    confirms: [] as Array<{ title: string; body: string }>,
    alerts: [] as Array<{ title: string; body: string }>,
}));
const routerBack = vi.hoisted(() => vi.fn());
const announceAccessibilityMessage = vi.hoisted(() => vi.fn());
const sockets = vi.hoisted(() => new Map<string, import('socket.io-client').Socket>());
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary((socket, url) => { if (url) sockets.set(new URL(url).origin, socket); });
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;

vi.mock('@/components/ui/accessibility/announceAccessibilityMessage', () => ({
    announceAccessibilityMessage,
}));

installSettingsViewCommonModuleMocks({
    storage: async importOriginal => await importOriginal(),
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ router: { push: vi.fn(), back: routerBack }, navigation: { setOptions: vi.fn() } }).module;
    },
    // The modal is a platform presentation boundary; the confirmation decision
    // it returns is what this surface is being tested against.
    modal: async () => ({
        Modal: {
            confirm: async (title: string, body: string) => {
                modalState.confirms.push({ title, body });
                return modalState.confirmWith ? await modalState.confirmWith() : modalState.confirmResult;
            },
            alertAsync: async (title: string, body: string) => {
                modalState.alerts.push({ title, body });
            },
        },
    }),
});

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);

const GOVERNANCE_PATH = '/v1/home/governance/get';
const LIST_PATH = '/v1/home/accounts/list';
const GET_PATH = '/v1/home/accounts/get';
const ROLE_PATH = '/v1/home/accounts/role/set';
const DISABLE_PATH = '/v1/home/accounts/disable';
const DELETE_PATH = '/v1/home/accounts/delete';
const SIGN_OUT_PATH = '/v1/home/accounts/sign-out-everywhere';

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
    const { HomeAdministrationAccountScreen } = await import('./HomeAdministrationAccountScreen');
    const { resetHomeGovernanceEngineForTests } = await import('@/sync/engine/home/governance/homeGovernanceEngine');
    resetHomeGovernanceEngineForTests();
    let content = <HomeAdministrationAccountScreen serverId={serverId} accountId={accountId} />;
    if (observeHomes) {
        const { ConcurrentSessionCacheRuntime } = await import('@/auth/context/AuthContext');
        content = <ConcurrentSessionCacheRuntime>{content}</ConcurrentSessionCacheRuntime>;
    }
    const screen = await renderScreen(content);
    await waitForHomeGovernance(() => {
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-account-machines');
    });
    return screen;
}

async function renderAccountLookup(serverId: string, accountId = 'ada') {
    const { HomeAdministrationAccountScreen } = await import('./HomeAdministrationAccountScreen');
    const { resetHomeGovernanceEngineForTests } = await import('@/sync/engine/home/governance/homeGovernanceEngine');
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
        currentAccount: options?.currentAccount,
    });
    harness.answer(home, GOVERNANCE_PATH, {
        body: homeGovernanceProjectionFixture(options?.projection),
    });
    harness.answer(home, GET_PATH, { body: options?.detail ?? homeAccountDetailFixture('ada') });
    return home;
}

beforeEach(async () => {
    // A real connection fixture disposes its temporary credential spy. Reclaim
    // this suite's genuine device-storage/network boundaries for the next case.
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
    routerBack.mockReset();
    announceAccessibilityMessage.mockReset();
    sockets.clear();
});

afterEach(async () => {
    standardCleanup();
    await connection?.dispose(); connection = null;
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
        expect(modalState.confirms[0]?.title).toContain('homeGovernance.person.signOutEverywhereTitle');
        const [request] = harness.requestsFor(SIGN_OUT_PATH);
        expect(request?.serverId).toBe(home);
        expect(request?.input).toEqual({ accountId: 'ada' });
        expect(request?.token).toBe(createAccountTokenForTests('account-admin'));
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

        await waitForHomeGovernance(() => expect(modalState.alerts).toHaveLength(1));
        expect(modalState.alerts[0]?.body).toContain('settingsApiTokens.errors.accountChanged');
        expect(harness.requestsFor(SIGN_OUT_PATH)).toHaveLength(0);
    });

    it('binds every destructive People action to the Account captured when its confirmation opened', async () => {
        for (const testID of ['home-account-disable', 'home-account-delete', 'home-account-role:admin']) {
            await harness.reset();
            modalState.alerts = [];
            const home = await addAdministeredHome();
            const screen = await renderAccount(home);
            modalState.confirmWith = async () => {
                await harness.switchAccount(home, 'account-intruder');
                return true;
            };
            await screen.pressByTestIdAsync(testID);
            await waitForHomeGovernance(() => expect(modalState.alerts).toHaveLength(1));
            expect(harness.requestsFor(DISABLE_PATH)).toHaveLength(0);
            expect(harness.requestsFor(DELETE_PATH)).toHaveLength(0);
            expect(harness.requestsFor(ROLE_PATH)).toHaveLength(0);
            act(() => screen.tree.unmount());
            modalState.confirmWith = null;
        }
    });

    it('changes a role only after its confirmation, and not at all when it is declined', async () => {
        const home = await addAdministeredHome();
        harness.answer(home, ROLE_PATH, { body: homeAccountRowFixture('ada', { homeRole: 'admin' }) });
        const screen = await renderAccount(home);

        modalState.confirmResult = false;
        await screen.pressByTestIdAsync('home-account-role:admin');
        expect(harness.requestsFor(ROLE_PATH)).toHaveLength(0);

        modalState.confirmResult = true;
        await screen.pressByTestIdAsync('home-account-role:admin');
        await waitForHomeGovernance(() => expect(harness.requestsFor(ROLE_PATH)).toHaveLength(1));
        expect(harness.requestsFor(ROLE_PATH)[0]?.input).toEqual({ accountId: 'ada', homeRole: 'admin' });
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

    it('disables an account through the exact Home after an explicit confirmation', async () => {
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

    it('changes nothing when the destructive confirmation is declined', async () => {
        const home = await addAdministeredHome();
        harness.answer(home, DISABLE_PATH, { body: disabledAccountRow() });
        modalState.confirmResult = false;

        const screen = await renderAccount(home);
        await screen.pressByTestIdAsync('home-account-disable');

        expect(harness.requestsFor(DISABLE_PATH)).toHaveLength(0);
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
        await waitForHomeGovernance(() => expect(harness.requestsFor(DELETE_PATH).length).toBeGreaterThan(0));
        await flushHookEffects();
        expect(modalState.confirms).toHaveLength(3);
        await waitForHomeGovernance(() => expect(routerBack).toHaveBeenCalled());
        expect(modalState.confirms[1]?.body).toContain('native-1');
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

    it('consumes the real Ask-first refusal into resource review and requires normal approval for the reviewed retry', async () => {
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
            request: harness.request,
        });
        // The restore helper binds a single Home; the real concurrent observation
        // runtime needs the same HTTP boundary to answer both selected Homes.
        const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        setRuntimeFetch(harness.request);
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async serverUrl => {
            const record = harness.findByServerUrl(serverUrl);
            return record?.token ? { token: record.token } : null;
        });
        const { storage } = await import('@/sync/domains/state/storage');
        const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
        storage.getState().activateProfileScope({ serverId: resolveServerProfileScopeIdForIdentifier(focused), accountId: 'focused-account' });
        const screen = await renderAccount(home, 'ada', true);
        await waitForHomeGovernance(() => expect(sockets.get('https://home-a.example')?.listeners('update').length).toBeGreaterThan(0));
        const { subscribeHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
        const deliverAccountChange = async () => {
            const socket = sockets.get('https://home-a.example');
            if (!socket) throw new Error('Expected administered Home observation transport');
            const observedHomes: string[] = [];
            const unsubscribe = subscribeHomeAccountChange(event => observedHomes.push(event.serverId));
            try {
                await act(async () => { for (const receive of socket.listeners('update')) receive({ body: { t: 'account-change' } }); });
                expect(observedHomes).toContain(home);
                expect(observedHomes).not.toContain(focused);
            } finally { unsubscribe(); }
        };
        await screen.pressByTestIdAsync('home-account-delete');
        await waitForHomeGovernance(() => expect(harness.artifacts(home).list()).toHaveLength(1));
        expect(harness.requestsFor(DELETE_PATH)).toEqual([]);
        const firstApprovalId = harness.artifacts(home).list()[0]!.id;
        await decideApprovalAsInbox(home, firstApprovalId, 'approve');
        expect(harness.requestsFor(DELETE_PATH)).toHaveLength(1);
        const failedArtifactBody = harness.artifacts(home).readPlainBody(firstApprovalId);
        expect(failedArtifactBody).not.toBeNull();
        const failedRequest = ApprovalRequestV2Schema.parse(JSON.parse(failedArtifactBody!));
        expect(failedRequest.status).toBe('failed');
        expect(readApprovalExecutionFailure(failedRequest)).toMatchObject({
            errorCode: 'account_erasure_managed_resources_review_required',
            details: { error: 'account_erasure_managed_resources_review_required', resources: [resource] },
        });
        await deliverAccountChange();
        await flushHookEffects();
        expect(modalState.confirms).toHaveLength(2);
        await waitForHomeGovernance(() => expect(harness.artifacts(home).list()).toHaveLength(2));
        expect(routerBack).not.toHaveBeenCalled();
        expect(harness.requestsFor(DELETE_PATH)).toHaveLength(1);
        await decideApprovalAsInbox(home, harness.artifacts(home).list()[1]!.id, 'approve');
        await deliverAccountChange();
        await waitForHomeGovernance(() => expect(routerBack).toHaveBeenCalled());
        expect(harness.requestsFor(DELETE_PATH).map(request => request.input)).toEqual([
            { accountId: 'ada' }, { accountId: 'ada', managedResourceDispositions: [{ managedId: resource.managedId,
                expectedIntentRevision: resource.intentRevision, expectedAllocation: resource.allocation,
                expectedResource: resource.resource, expectedNativeOperationRef: resource.nativeOperationRef,
                expectedRecovery: resource.recovery, responsibility: 'manual' }] },
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
});
