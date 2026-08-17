import * as React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import type {
    PluginConnectedAccountAuthenticationModeV2,
    QualifiedConnectedAccountProfileV4,
} from '@happier-dev/protocol';

const modalAlertMock = vi.hoisted(() => vi.fn());
const modalConfirmMock = vi.hoisted(() => vi.fn());
const modalPromptMock = vi.hoisted(() => vi.fn());
const routerMethods = vi.hoisted(() => ({
    push: vi.fn(),
    back: vi.fn(),
    replace: vi.fn(),
    canGoBack: vi.fn(() => true),
}));
/**
 * Server feature state; pools AND automatic account fallback are separate,
 * optional, server-gated capabilities. Both default DISABLED here for any
 * feature this screen does not read, so a missing gate can never read as on.
 */
const featureState = vi.hoisted(() => ({ accountGroups: true, accountFallback: true }));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => {
        if (featureId === 'connectedServices.accountGroups') return featureState.accountGroups;
        if (featureId === 'connectedServices.accountFallback') return featureState.accountFallback;
        return false;
    },
}));

// The testkit owns the router boundary; drill-in and leave-screen navigation is
// this component's contract, so the pushes/backs are asserted directly.
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: routerMethods }).module;
});
/**
 * The three screens this component routes to are separately and thoroughly
 * tested (`QualifiedPoolsList`, `QualifiedPoolDetailView`,
 * `QualifiedAccountDetailView`). What belongs to THIS file is the wiring: which
 * screen a route focus selects and what each one is handed, so they render as
 * inspectable stubs.
 */
vi.mock('../pools/QualifiedPoolsList', () => ({
    QualifiedPoolsList: (props: Record<string, unknown>) =>
        React.createElement('QualifiedPoolsList', props),
}));
vi.mock('../pools/QualifiedPoolDetailView', () => ({
    QualifiedPoolDetailView: (props: Record<string, unknown>) =>
        React.createElement('QualifiedPoolDetailView', props),
}));
vi.mock('./QualifiedAccountDetailView', () => ({
    QualifiedAccountDetailView: (props: Record<string, unknown>) =>
        React.createElement('QualifiedAccountDetailView', props),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
// The testkit owns this boundary. The previous inline mock returned the
// stylesheet FACTORY unevaluated and carried only two colour groups, which the
// account block's pool chips and the focused screens' list container (state
// tones, surfaces) cannot render against.
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('ItemGroup', props, props.children),
}));
vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));
vi.mock('@/modal', () => ({
    Modal: {
        alert: modalAlertMock,
        confirm: modalConfirmMock,
        prompt: modalPromptMock,
    },
}));
vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: Record<string, unknown>) => React.createElement('Switch', props),
}));
vi.mock('@/hooks/server/connectedServices/useConnectedServiceQuotaSnapshot', () => ({
    useConnectedServiceQuotaSnapshot: () => ({
        snapshot: null,
        loading: false,
        error: null,
        canRefresh: false,
        isRefreshing: false,
        refresh: vi.fn(),
    }),
}));
vi.mock('@/hooks/server/connectedServices/useQualifiedConnectedAccountQuota', () => ({
    useQualifiedConnectedAccountQuota: () => ({
        supported: false,
        snapshot: null,
        loading: false,
        refreshing: false,
        error: null,
        refresh: vi.fn(),
    }),
}));
vi.mock('@/components/settings/connectedServices/detail/ConnectedServiceSegmentedShell', () => ({
    ConnectedServiceSegmentedShell: (props: Readonly<{
        accountsContent: React.ReactNode;
        poolsContent: React.ReactNode;
        activeSegment: 'accounts' | 'pools';
        poolsAvailable: boolean;
    }>) => React.createElement(
        'ConnectedServiceSegmentedShell',
        props,
        props.activeSegment === 'pools' && props.poolsAvailable
            ? props.poolsContent
            : props.accountsContent,
    ),
}));

const service = { pluginId: 'acme.accounts', localId: 'work' } as const;
const modes = [
    {
        id: 'manual',
        kind: 'manual',
        title: 'Access token',
        outcomeReconciliation: 'none',
        fields: [{
            id: 'token',
            title: 'Token',
            schema: { type: 'string', minLength: 1 },
            secret: true,
        }],
    },
    {
        id: 'device',
        kind: 'oauthDeviceCode',
        title: 'Device authorization',
        outcomeReconciliation: 'providerCheck',
    },
] satisfies PluginConnectedAccountAuthenticationModeV2[];
const accounts = [{
    ref: { service, accountId: 'account-a' },
    status: 'needs_reauth',
    authenticationModeId: 'device',
    revisionSemantics: 'revisioned',
    credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    configurationReady: true,
    configurationRevision: 'config-1',
    displayName: 'Work account',
    scopes: [],
}] satisfies QualifiedConnectedAccountProfileV4[];

/** A loaded qualified pool of this service, with both accounts as members. */
function makePoolGroup() {
    return {
        ref: { service, groupId: 'team' },
        displayName: 'Team',
        policy: {
            v: 1 as const,
            strategy: 'least_limited' as const,
            autoSwitch: false,
            switchOn: {
                usageLimit: true,
                authExpired: true,
                accountChanged: true,
                refreshFailure: false,
            },
            cooldownMs: 30_000,
            honorProviderResetsAt: true,
            autoRestorePrimaryWhenReset: false,
            maxSwitchesPerTurn: 1,
            maxSwitchesPerSessionHour: 3,
            softSwitchRemainingPercent: 15,
            probeIfSnapshotOlderThanMs: 300_000,
            preTurnProbeMode: 'when_stale' as const,
            preTurnProbeOrder: 'current_first_then_candidates' as const,
            recoveryMode: 'switch_or_wait' as const,
            resumePromptMode: 'standard' as const,
        },
        activeAccountId: 'account-a',
        revision: {
            protocol: 'v4' as const,
            incarnation: 'qualified-group-row-team',
            generation: 4,
            runtimeStateRevision: 7,
        },
        state: {},
        members: [{
            ref: { service, accountId: 'account-a' },
            priority: 100,
            enabled: true,
            state: {},
        }, {
            ref: { service, accountId: 'account-b' },
            priority: 200,
            enabled: true,
            state: {},
        }],
    };
}

/**
 * Per-account affordances (reconnect / edit label / configure) are no longer
 * sibling `Item` rows: each account renders exactly ONE account block whose
 * kebab owns them. `tree.find` returns the OUTERMOST match for a testID, i.e.
 * the block container itself, so its props are the contract under test.
 */
type AccountBlockAction = Readonly<{
    id: string;
    disabled?: boolean;
    onPress: () => unknown;
}>;

function accountBlockActions(account: ReactTestInstance): ReadonlyArray<AccountBlockAction> {
    return (account.props.actions ?? []) as ReadonlyArray<AccountBlockAction>;
}

/** Rendered account blocks, outermost-first, in on-screen order. */
function accountBlockOrder(tree: Readonly<{
    findAll(predicate: (node: ReactTestInstance) => boolean): ReactTestInstance[];
}>): ReadonlyArray<string> {
    return [...new Set(tree
        .findAll((node) => (
            typeof node.props.testID === 'string'
            && /^connected-account:[^:]+$/.test(node.props.testID)
        ))
        .map((node) => node.props.testID as string))];
}

async function pressAccountBlockActionAsync(
    account: ReactTestInstance,
    actionId: string,
): Promise<void> {
    const actions = accountBlockActions(account);
    const action = actions.find((entry) => entry.id === actionId);
    if (!action) {
        throw new Error(
            `Missing account block action "${actionId}" (present: ${actions.map((entry) => entry.id).join(', ') || 'none'})`,
        );
    }
    await act(async () => {
        await action.onPress();
    });
}

describe('ConnectedAccountServiceContent', () => {
    beforeEach(() => {
        featureState.accountGroups = true;
        featureState.accountFallback = true;
    });

    it('lists every descriptor mode and reconnects only the exact qualified account', async () => {
        const onBeginConnect = vi.fn();
        const onBeginReconnect = vi.fn();
        const { ConnectedAccountServiceContent } = await import('./ConnectedAccountServiceContent');
        const tree = (await renderScreen(
            <ConnectedAccountServiceContent
                title="Acme"
                service={service}
                modes={modes}
                accounts={accounts}
                busy={false}
                onBeginConnect={onBeginConnect}
                onBeginReconnect={onBeginReconnect}
                onRevoke={vi.fn()}
            />,
        )).tree;

        const modeRows = tree.findAll((node) =>
            String(node.type) === 'Item'
            &&
            typeof node.props.testID === 'string'
            && node.props.testID.startsWith('connected-account-mode:'),
        );
        expect(modeRows.map((row) => row.props.title)).toEqual([
            'Access token',
            'Device authorization',
        ]);

        await pressTestInstanceAsync(modeRows[1]!);
        expect(onBeginConnect).toHaveBeenCalledWith({
            service,
            modeId: 'device',
        });

        const account = tree.find((node) => node.props.testID === 'connected-account:account-a');
        await pressAccountBlockActionAsync(account, 'reconnect');
        expect(onBeginReconnect).toHaveBeenCalledWith({
            service,
            accountId: 'account-a',
        });
    });

    it('names an account by label, then provider email, then plugin display name', async () => {
        const { ConnectedAccountServiceContent } = await import('./ConnectedAccountServiceContent');
        const emailAccount = {
            ...accounts[0]!,
            providerIdentity: { email: 'work@example.com' },
        } satisfies QualifiedConnectedAccountProfileV4;
        const rendered = await renderScreen(
            <ConnectedAccountServiceContent
                title="Acme"
                service={service}
                modes={modes}
                accounts={[emailAccount]}
                busy={false}
            />,
        );
        const account = () => rendered.tree.find((node) => (
            node.props.testID === 'connected-account:account-a'
        ));

        // No user label: the provider email names the account and the stable
        // account id stays visible on the identity line — never the raw id as
        // the title.
        expect(account().props.title).toBe('work@example.com');
        expect(account().props.identityLabel).toContain('account-a');

        await rendered.update(
            <ConnectedAccountServiceContent
                title="Acme"
                service={service}
                modes={modes}
                accounts={[emailAccount]}
                accountLabels={{ 'account-a': 'Work' }}
                busy={false}
            />,
        );
        expect(account().props.title).toBe('Work');
        expect(account().props.identityLabel).toContain('work@example.com');

        // Neither a user label nor a provider email: the plugin display name
        // names the account rather than its id.
        await rendered.update(
            <ConnectedAccountServiceContent
                title="Acme"
                service={service}
                modes={modes}
                accounts={accounts}
                busy={false}
            />,
        );
        expect(account().props.title).toBe('Work account');
    });

    it('orders accounts needing attention ahead of healthy ones', async () => {
        const withAccount = (
            accountId: string,
            status: QualifiedConnectedAccountProfileV4['status'],
        ) => ({
            ...accounts[0]!,
            ref: { service, accountId },
            status,
        } satisfies QualifiedConnectedAccountProfileV4);
        const { ConnectedAccountServiceContent } = await import('./ConnectedAccountServiceContent');
        const tree = (await renderScreen(
            <ConnectedAccountServiceContent
                title="Acme"
                service={service}
                modes={modes}
                accounts={[
                    withAccount('account-healthy', 'connected'),
                    withAccount('account-broken', 'needs_reauth'),
                    withAccount('account-also-healthy', 'connected'),
                    withAccount('account-retrying', 'refresh_failed_retryable'),
                ]}
                busy={false}
            />,
        )).tree;

        // Worst health first, then a stable alphabetical order inside a health
        // band, so a broken account is never buried below healthy ones.
        expect(accountBlockOrder(tree)).toEqual([
            'connected-account:account-broken',
            'connected-account:account-retrying',
            'connected-account:account-also-healthy',
            'connected-account:account-healthy',
        ]);
    });

    it('blocks credential actions while an authentication attempt is in flight', async () => {
        const { ConnectedAccountServiceContent } = await import('./ConnectedAccountServiceContent');
        const tree = (await renderScreen(
            <ConnectedAccountServiceContent
                title="Acme"
                service={service}
                modes={modes}
                accounts={[{
                    ...accounts[0]!,
                    status: 'connected' as const,
                } satisfies QualifiedConnectedAccountProfileV4]}
                busy
                onEditLabel={vi.fn()}
                onBeginReconnect={vi.fn()}
                onRevoke={vi.fn()}
            />,
        )).tree;

        // The screen runs ONE attempt at a time and has no re-entrancy guard of
        // its own, so starting or destroying a credential stays blocked; the
        // read-only drill-in and the local label edit do not.
        const disabledById = Object.fromEntries(accountBlockActions(
            tree.find((node) => node.props.testID === 'connected-account:account-a'),
        ).map((entry) => [entry.id, entry.disabled ?? false]));
        expect(disabledById).toEqual({
            open: false,
            label: false,
            reconnect: true,
            disconnect: true,
        });
    });

    it('renders a centered empty state rather than an info row when nothing is connected', async () => {
        const { ConnectedAccountServiceContent } = await import('./ConnectedAccountServiceContent');
        const tree = (await renderScreen(
            <ConnectedAccountServiceContent
                title="Acme"
                service={service}
                modes={modes}
                accounts={[]}
                busy={false}
            />,
        )).tree;

        expect(tree.findAll((node) => (
            String(node.type) === 'Item'
            && node.props.testID === 'connected-accounts:empty'
        ))).toHaveLength(0);
        expect(tree.find((node) => (
            node.props.testID === 'connected-accounts:empty'
        )).props.title).toBe('connectedServices.detail.profiles.empty');
    });

    it('disconnects from the account kebab instead of a service-level row', async () => {
        const onRevoke = vi.fn();
        const connectedAccount = {
            ...accounts[0]!,
            status: 'connected' as const,
        } satisfies QualifiedConnectedAccountProfileV4;
        const { ConnectedAccountServiceContent } = await import('./ConnectedAccountServiceContent');
        const tree = (await renderScreen(
            <ConnectedAccountServiceContent
                title="Acme"
                service={service}
                modes={modes}
                accounts={[connectedAccount]}
                busy={false}
                onBeginConnect={vi.fn()}
                onRevoke={onRevoke}
            />,
        )).tree;

        // Disconnect belongs to the account it acts on, so the service-level
        // actions group carries no per-account row at all.
        expect(tree.findAll((node) => (
            typeof node.props.testID === 'string'
            && node.props.testID.startsWith('connected-account-revoke:')
        ))).toHaveLength(0);

        const account = tree.find((node) => node.props.testID === 'connected-account:account-a');
        expect(accountBlockActions(account).map((entry) => entry.id))
            .toEqual(['open', 'disconnect']);
        await pressAccountBlockActionAsync(account, 'disconnect');
        expect(onRevoke).toHaveBeenCalledWith({ service, accountId: 'account-a' });
    });

    it('keeps a legacy-unfenced account passive by omitting its mutation affordances', async () => {
        const legacyAccount = {
            ...accounts[0]!,
            status: 'connected' as const,
            revisionSemantics: 'legacy_unfenced' as const,
            credentialRevision: null,
        } satisfies QualifiedConnectedAccountProfileV4;
        const { ConnectedAccountServiceContent } = await import('./ConnectedAccountServiceContent');
        const tree = (await renderScreen(
            <ConnectedAccountServiceContent
                title="Acme"
                service={service}
                modes={modes}
                accounts={[legacyAccount]}
                busy={false}
                onToggleDefault={vi.fn()}
                onEditLabel={vi.fn()}
                onBeginReconnect={vi.fn()}
                onRevoke={vi.fn()}
            />,
        )).tree;

        const account = tree.find((node) => (
            node.props.testID === 'connected-account:account-a'
        ));
        expect(accountBlockActions(account).map((entry) => entry.id))
            .toEqual(['open']);
        expect(account.props.onToggleDefault).toBeUndefined();
    });

    it('omits disconnect entirely when the peer permits no credential deletion', async () => {
        const connectedAccount = {
            ...accounts[0]!,
            status: 'connected' as const,
        } satisfies QualifiedConnectedAccountProfileV4;
        const { ConnectedAccountServiceContent } = await import('./ConnectedAccountServiceContent');
        const tree = (await renderScreen(
            <ConnectedAccountServiceContent
                title="Acme"
                service={service}
                modes={modes}
                accounts={[connectedAccount]}
                busy={false}
                onBeginConnect={vi.fn()}
            />,
        )).tree;

        const account = tree.find((node) => node.props.testID === 'connected-account:account-a');
        expect(accountBlockActions(account).map((entry) => entry.id))
            .not.toContain('disconnect');
    });

    it('keeps reconnect available for a non-null public mode unknown to this descriptor snapshot', async () => {
        const onBeginReconnect = vi.fn();
        const futureModeAccount = {
            ...accounts[0],
            authenticationModeId: 'future-oauth',
            configurationReady: false,
        } satisfies QualifiedConnectedAccountProfileV4;
        const { ConnectedAccountServiceContent } = await import('./ConnectedAccountServiceContent');
        const tree = (await renderScreen(
            <ConnectedAccountServiceContent
                title="Acme"
                service={service}
                modes={modes}
                accounts={[futureModeAccount]}
                busy={false}
                onBeginConnect={vi.fn()}
                onBeginReconnect={onBeginReconnect}
                onRevoke={vi.fn()}
            />,
        )).tree;

        const account = tree.find((node) => node.props.testID === 'connected-account:account-a');
        const reconnect = accountBlockActions(account).find((entry) => (
            entry.id === 'reconnect'
        ));
        // Reconnect stays offered AND enabled even though configuration reads as
        // blocked for a mode this descriptor snapshot does not know about.
        expect(reconnect).toBeDefined();
        expect(reconnect?.disabled).toBeFalsy();
        expect(account.props.identityLabel).toContain('common.blocked');
        await pressAccountBlockActionAsync(account, 'reconnect');
        expect(onBeginReconnect).toHaveBeenCalledWith({
            service,
            accountId: 'account-a',
        });
    });

    it('shows configuration blocking from the current service or account scope owner', async () => {
        const configuredAccount = {
            ...accounts[0],
            status: 'connected' as const,
            authenticationModeId: 'manual',
            configurationReady: false,
            configurationRevision: null,
        } satisfies QualifiedConnectedAccountProfileV4;
        const configuredMode = {
            ...modes[0],
            configuration: {
                scope: 'service' as const,
                changeBehavior: 'reconnect' as const,
                fields: [{
                    id: 'origin',
                    title: 'Origin',
                    schema: { type: 'string' as const, minLength: 1 },
                    required: true as const,
                    semantic: 'connectedAccountOrigin' as const,
                    secret: false as const,
                }],
            },
        } satisfies PluginConnectedAccountAuthenticationModeV2;
        const { ConnectedAccountServiceContent } = await import(
            './ConnectedAccountServiceContent'
        );
        const rendered = await renderScreen(
            <ConnectedAccountServiceContent
                title="Acme"
                service={service}
                modes={[configuredMode]}
                accounts={[configuredAccount]}
                serviceConfigurationStatusByModeId={{ manual: 'ready' }}
                busy={false}
                onBeginReconnect={vi.fn()}
                onConfigureService={vi.fn()}
            />,
        );
        const accountRow = () => rendered.tree.find((node) => (
            node.props.testID === 'connected-account:account-a'
        ));

        // The blocked marker rides the block's identity line now (the account row
        // subtitle it used to share is gone with the row).
        expect(accountRow().props.identityLabel).not.toContain('common.blocked');
        expect(rendered.tree.find((node) => (
            node.props.testID
            === 'connected-service-configuration-settings:manual'
        )).props.detail).toBe('Access token');

        await rendered.update(
            <ConnectedAccountServiceContent
                title="Acme"
                service={service}
                modes={[configuredMode]}
                accounts={[configuredAccount]}
                serviceConfigurationStatusByModeId={{
                    manual: 'configurationRequired',
                }}
                busy={false}
                onBeginReconnect={vi.fn()}
                onConfigureService={vi.fn()}
            />,
        );

        expect(accountRow().props.identityLabel).toContain('common.blocked');
        expect(rendered.tree.find((node) => (
            node.props.testID
            === 'connected-service-configuration-settings:manual'
        )).props.detail).toContain('common.blocked');

        await rendered.update(
            <ConnectedAccountServiceContent
                title="Acme"
                service={service}
                modes={[{
                    ...configuredMode,
                    configuration: {
                        ...configuredMode.configuration,
                        scope: 'account',
                    },
                }]}
                accounts={[configuredAccount]}
                serviceConfigurationStatusByModeId={{ manual: 'ready' }}
                busy={false}
                onBeginReconnect={vi.fn()}
            />,
        );

        expect(accountRow().props.identityLabel).toContain('common.blocked');
    });

    it('keeps the account usable when its qualified service has no quota leaf', async () => {
        const { ConnectedAccountServiceContent } = await import('./ConnectedAccountServiceContent');
        const tree = (await renderScreen(
            <ConnectedAccountServiceContent
                title="Acme"
                service={service}
                modes={modes}
                accounts={accounts}
                groups={{
                    ...EMPTY_GROUPS_FOR_TEST,
                    status: 'loaded',
                    source: { protocol: 'v4' },
                }}
                busy={false}
                onBeginConnect={vi.fn()}
                onBeginReconnect={vi.fn()}
                onRevoke={vi.fn()}
            />,
        )).tree;

        expect(tree.findAll((node) => (
            node.props.testID === 'connected-account:account-a'
        )).length).toBeGreaterThan(0);
        expect(tree.findAll((node) => (
            node.props.testID === 'qualified-connected-account-quota:account-a'
        ))).toHaveLength(0);
    });

    it('offers public setup modes without reconnecting an account whose public mode is unavailable', async () => {
        const onBeginConnect = vi.fn();
        const onBeginReconnect = vi.fn();
        const supportedSetupModes = [{
            id: 'api-key',
            kind: 'manual',
            title: 'Gemini API key',
            outcomeReconciliation: 'none',
            fields: [{
                id: 'token',
                title: 'Gemini API key',
                schema: { type: 'string', minLength: 1 },
                secret: true,
            }],
        }, {
            id: 'service-account',
            kind: 'manual',
            title: 'Google service account',
            outcomeReconciliation: 'none',
            fields: [{
                id: 'credentialsJson',
                title: 'Service-account JSON',
                schema: { type: 'string', minLength: 1 },
                secret: true,
            }],
        }] satisfies PluginConnectedAccountAuthenticationModeV2[];
        const unsupportedLegacyAccount = {
            ...accounts[0],
            authenticationModeId: null,
        } satisfies QualifiedConnectedAccountProfileV4;
        const { ConnectedAccountServiceContent } = await import('./ConnectedAccountServiceContent');
        const tree = (await renderScreen(
            <ConnectedAccountServiceContent
                title="Acme"
                service={service}
                modes={supportedSetupModes}
                accounts={[unsupportedLegacyAccount]}
                busy={false}
                onBeginConnect={onBeginConnect}
                onBeginReconnect={onBeginReconnect}
                onRevoke={vi.fn()}
            />,
        )).tree;

        const account = tree.find((node) => node.props.testID === 'connected-account:account-a');
        // The needs-reauth state reaches the block RAW, which is what pins its
        // reauth badge (badge rendering itself is proven in AccountBlock.test.tsx;
        // the `Item` stub in this file never mounts the header's title node)…
        expect(account.props.status).toBe('needs_reauth');
        // …and NO RECONNECT affordance is reachable for an account whose public
        // authentication mode is gone: neither `reconnect` nor `replace-token`
        // is offered, and it exposes no default toggle. The read-only drill-in
        // to the account's own screen remains and navigates. Disconnect stays
        // available because removing a broken credential must not depend on its
        // authentication mode still existing — the account detail screen
        // disconnects unconditionally, and the row menu now agrees.
        expect(accountBlockActions(account).map((entry) => entry.id)).toEqual([
            'open',
            'disconnect',
        ]);
        expect(account.props.onToggleDefault).toBeUndefined();
        await pressAccountBlockActionAsync(account, 'open');
        expect(routerMethods.push).toHaveBeenCalledWith(expect.objectContaining({
            params: expect.objectContaining({
                pluginId: service.pluginId,
                localId: service.localId,
                accountId: 'account-a',
            }),
        }));

        const modeRows = tree.findAll((node) =>
            String(node.type) === 'Item'
            && typeof node.props.testID === 'string'
            && node.props.testID.startsWith('connected-account-mode:'),
        );
        expect(modeRows.map((row) => row.props.title)).toEqual([
            'Gemini API key',
            'Google service account',
        ]);
        await pressTestInstanceAsync(modeRows[0]!);
        expect(onBeginConnect).toHaveBeenCalledWith({
            service,
            modeId: 'api-key',
        });
        expect(onBeginReconnect).not.toHaveBeenCalled();
    });

    it('renders a focused pool as its own screen and owns the runtime-cooldown override', async () => {
        const group = makePoolGroup();
        const cooldownError = Object.assign(
            new Error('connect_group_profile_runtime_cooldown'),
            {
                code: 'connect_group_profile_runtime_cooldown',
                resetAtMs: Date.now() + 10_000,
            },
        );
        const setActiveAccount = vi.fn()
            .mockRejectedValueOnce(cooldownError)
            .mockResolvedValueOnce(group);
        const deleteGroup = vi.fn(async () => true);
        modalConfirmMock.mockReset();
        modalConfirmMock.mockResolvedValueOnce(true);
        routerMethods.back.mockClear();
        const groups = {
            ...EMPTY_GROUPS_FOR_TEST,
            status: 'loaded' as const,
            source: { protocol: 'v4' as const },
            groups: [group],
            setActiveAccount,
            delete: deleteGroup,
        };
        const secondAccount = {
            ...accounts[0],
            ref: { service, accountId: 'account-b' },
            status: 'connected' as const,
        };
        const { ConnectedAccountServiceContent } = await import('./ConnectedAccountServiceContent');
        const tree = (await renderScreen(
            <ConnectedAccountServiceContent
                title="Acme"
                service={service}
                focus={{ kind: 'group', groupId: 'team' }}
                modes={[]}
                accounts={[accounts[0], secondAccount]}
                accountLabels={{ 'account-a': 'Work' }}
                groups={groups}
                busy={false}
                onBeginConnect={vi.fn()}
                onBeginReconnect={vi.fn()}
                onRevoke={vi.fn()}
            />,
        )).tree;

        // A pool focus is its OWN screen: the service detail's segmented shell
        // (accounts list, pools list, connect actions) is not rendered at all.
        expect(tree.findAll(
            (node) => String(node.type) === 'ConnectedServiceSegmentedShell',
        )).toHaveLength(0);
        const detail = tree.find(
            (node) => String(node.type) === 'QualifiedPoolDetailView',
        );
        expect(detail.props.group).toBe(group);
        expect(detail.props.serviceLabel).toBe('Acme');
        expect(detail.props.accountLabels).toEqual({ 'account-a': 'Work' });
        expect(detail.props.accounts).toHaveLength(2);
        expect(detail.props.fallbackControlsEnabled).toBe(true);

        // The runtime-cooldown override stays with THIS owner: the detail view's
        // mutation surface never prompts, so a rejected activation is confirmed
        // once here and retried with the explicit override.
        await act(async () => {
            await detail.props.mutations.setActiveAccount({
                group,
                account: { service, accountId: 'account-b' },
            });
        });
        expect(modalConfirmMock).toHaveBeenCalledTimes(1);
        expect(setActiveAccount).toHaveBeenCalledTimes(2);
        expect(setActiveAccount).toHaveBeenLastCalledWith({
            group,
            account: { service, accountId: 'account-b' },
            overrideRuntimeCooldown: true,
        });

        // Deleting the focused pool leaves a screen whose pool no longer exists.
        await act(async () => {
            await detail.props.mutations.delete(group);
        });
        expect(deleteGroup).toHaveBeenCalledWith(group);
        expect(routerMethods.back).toHaveBeenCalledTimes(1);
    });

    it('disables the pool fallback controls when the server has not enabled account fallback', async () => {
        // The fallback gate is registered fail-closed and is a SEPARATE capability
        // from pools: a server that serves pools may still refuse to run automatic
        // fallback, and the pool screen must say so rather than offering controls
        // the server will not honor.
        featureState.accountFallback = false;
        const group = makePoolGroup();
        const { ConnectedAccountServiceContent } = await import('./ConnectedAccountServiceContent');
        const tree = (await renderScreen(
            <ConnectedAccountServiceContent
                title="Acme"
                service={service}
                focus={{ kind: 'group', groupId: 'team' }}
                modes={[]}
                accounts={accounts}
                groups={{
                    ...EMPTY_GROUPS_FOR_TEST,
                    status: 'loaded' as const,
                    source: { protocol: 'v4' as const },
                    groups: [group],
                }}
                busy={false}
            />,
        )).tree;

        const detail = tree.find(
            (node) => String(node.type) === 'QualifiedPoolDetailView',
        );
        expect(detail.props.fallbackControlsEnabled).toBe(false);
        expect(detail.props.fallbackDisabledSubtitle)
            .toBe('connectedServices.detail.groupActions.accountFallbackDisabled');
    });

    it('reports a focused pool that no longer exists instead of an empty screen', async () => {
        const { ConnectedAccountServiceContent } = await import('./ConnectedAccountServiceContent');
        const tree = (await renderScreen(
            <ConnectedAccountServiceContent
                title="Acme"
                service={service}
                focus={{ kind: 'group', groupId: 'gone' }}
                modes={[]}
                accounts={accounts}
                groups={{
                    ...EMPTY_GROUPS_FOR_TEST,
                    status: 'loaded' as const,
                    source: { protocol: 'v4' as const },
                }}
                busy={false}
            />,
        )).tree;

        expect(tree.findAll(
            (node) => String(node.type) === 'QualifiedPoolDetailView',
        )).toHaveLength(0);
        expect(tree.find((node) => (
            node.props.testID === 'connected-services-pool-detail:missing:row'
        )).props.title).toBe('connectedServices.detail.groupDetail.missingTitle');
    });

    it('renders a focused account as its own screen with only the permitted affordances', async () => {
        const group = makePoolGroup();
        const onBeginReconnect = vi.fn();
        const onDisconnectAccount = vi.fn(async () => true);
        routerMethods.push.mockClear();
        routerMethods.back.mockClear();
        const { ConnectedAccountServiceContent } = await import('./ConnectedAccountServiceContent');
        const tree = (await renderScreen(
            <ConnectedAccountServiceContent
                title="Acme"
                service={service}
                focus={{ kind: 'account', accountId: 'account-a' }}
                modes={modes}
                accounts={accounts}
                accountLabels={{ 'account-a': 'Work' }}
                defaultAccountId="account-a"
                groups={{
                    ...EMPTY_GROUPS_FOR_TEST,
                    status: 'loaded' as const,
                    source: { protocol: 'v4' as const },
                    groups: [group],
                }}
                busy={false}
                onBeginReconnect={onBeginReconnect}
                onDisconnectAccount={onDisconnectAccount}
            />,
        )).tree;

        expect(tree.findAll(
            (node) => String(node.type) === 'ConnectedServiceSegmentedShell',
        )).toHaveLength(0);
        const detail = tree.find(
            (node) => String(node.type) === 'QualifiedAccountDetailView',
        );
        expect(detail.props.account).toEqual({ service, accountId: 'account-a' });
        expect(detail.props.presentation).toEqual({
            primaryLabel: 'Work',
            secondaryLabel: 'Acme · account-a',
            accessibilityLabel: 'Acme · Work · account-a',
        });
        expect(detail.props.serviceLabel).toBe('Acme');
        expect(detail.props.isDefault).toBe(true);
        // Pools apply to this service, so the section renders (empty membership
        // included); every affordance whose callback was NOT supplied stays absent.
        expect(detail.props.groups).toEqual([group]);
        expect(detail.props.onEditLabel).toBeUndefined();
        expect(detail.props.onToggleDefault).toBeUndefined();

        detail.props.onOpenPool('team');
        expect(routerMethods.push).toHaveBeenCalledWith(expect.objectContaining({
            params: expect.objectContaining({
                pluginId: service.pluginId,
                localId: service.localId,
                groupId: 'team',
            }),
        }));

        detail.props.onReconnect();
        expect(onBeginReconnect).toHaveBeenCalledWith({ service, accountId: 'account-a' });

        // The account is gone once revoked, so its own screen is left behind.
        await act(async () => {
            await detail.props.onDisconnect();
        });
        expect(onDisconnectAccount).toHaveBeenCalledWith({ service, accountId: 'account-a' });
        expect(routerMethods.back).toHaveBeenCalledTimes(1);
    });

    it('hides the pools section for an account of a service without a pool source', async () => {
        const { ConnectedAccountServiceContent } = await import('./ConnectedAccountServiceContent');
        const tree = (await renderScreen(
            <ConnectedAccountServiceContent
                title="Acme"
                service={service}
                focus={{ kind: 'account', accountId: 'account-a' }}
                modes={modes}
                accounts={accounts}
                busy={false}
            />,
        )).tree;

        const detail = tree.find(
            (node) => String(node.type) === 'QualifiedAccountDetailView',
        );
        expect(detail.props.groups).toBeUndefined();
        expect(detail.props.onOpenPool).toBeUndefined();
    });

    it('hides every pool surface when the server has not enabled account groups', async () => {
        featureState.accountGroups = false;
        const group = makePoolGroup();
        const { ConnectedAccountServiceContent } = await import('./ConnectedAccountServiceContent');
        const rendered = await renderScreen(
            <ConnectedAccountServiceContent
                title="Acme"
                service={service}
                modes={modes}
                accounts={accounts}
                groups={{
                    ...EMPTY_GROUPS_FOR_TEST,
                    status: 'loaded' as const,
                    // A live transport is NOT permission to show the feature: the
                    // server bit decides, exactly as on every other surface.
                    source: { protocol: 'v4' as const },
                    groups: [group],
                }}
                busy={false}
            />,
        );

        expect(rendered.tree.find(
            (node) => String(node.type) === 'ConnectedServiceSegmentedShell',
        ).props.poolsAvailable).toBe(false);
        // Membership chips are part of the same feature; a transport that still
        // answers with groups must not leak them onto the accounts list.
        expect(rendered.tree.find(
            (node) => node.props.testID === 'connected-account:account-a',
        ).props.poolLabels).toBeUndefined();

        // The account detail screen's pools section is gated by the same fact.
        await rendered.update(
            <ConnectedAccountServiceContent
                title="Acme"
                service={service}
                focus={{ kind: 'account', accountId: 'account-a' }}
                modes={modes}
                accounts={accounts}
                groups={{
                    ...EMPTY_GROUPS_FOR_TEST,
                    status: 'loaded' as const,
                    source: { protocol: 'v4' as const },
                    groups: [group],
                }}
                busy={false}
            />,
        );
        const detail = rendered.tree.find(
            (node) => String(node.type) === 'QualifiedAccountDetailView',
        );
        expect(detail.props.groups).toBeUndefined();
        expect(detail.props.onOpenPool).toBeUndefined();
    });

    it('drives the Pools segment through the pools list and drills into a pool', async () => {
        const group = makePoolGroup();
        const refresh = vi.fn();
        routerMethods.push.mockClear();
        const { ConnectedAccountServiceContent } = await import('./ConnectedAccountServiceContent');
        const rendered = await renderScreen(
            <ConnectedAccountServiceContent
                title="Acme"
                service={service}
                modes={modes}
                accounts={accounts}
                accountLabels={{ 'account-a': 'Work' }}
                groups={{
                    ...EMPTY_GROUPS_FOR_TEST,
                    status: 'loaded' as const,
                    source: { protocol: 'v4' as const },
                    groups: [group],
                    refresh,
                }}
                busy={false}
            />,
        );
        const shell = rendered.tree.find(
            (node) => String(node.type) === 'ConnectedServiceSegmentedShell',
        );
        expect(shell.props.poolsAvailable).toBe(true);
        await act(async () => {
            shell.props.onSelectSegment('pools');
        });

        const list = rendered.tree.find(
            (node) => String(node.type) === 'QualifiedPoolsList',
        );
        expect(list.props.groups).toEqual([group]);
        expect(list.props.status).toBe('loaded');
        expect(list.props.serviceLabel).toBe('Acme');
        expect(list.props.poolConfigurationSupported).toBe(true);
        expect(list.props.accountLabels).toEqual({ 'account-a': 'Work' });

        list.props.onRetryLoad();
        expect(refresh).toHaveBeenCalledTimes(1);

        list.props.onOpenPool('team');
        expect(routerMethods.push).toHaveBeenCalledWith(expect.objectContaining({
            params: expect.objectContaining({
                pluginId: service.pluginId,
                localId: service.localId,
                groupId: 'team',
            }),
        }));
    });

    it.each([0, 2])(
        'renders one service configuration action with %i accounts',
        async (accountCount) => {
            const onConfigureService = vi.fn();
            const configuredModes = [{
                ...modes[0]!,
                configuration: {
                    scope: 'service' as const,
                    changeBehavior: 'refresh' as const,
                    fields: [{
                        id: 'origin',
                        title: 'Origin',
                        schema: { type: 'string' as const, minLength: 1 },
                        required: true as const,
                        secret: false as const,
                        semantic: 'connectedAccountOrigin' as const,
                    }],
                },
            }];
            const configuredAccounts = Array.from(
                { length: accountCount },
                (_, index) => ({
                    ...accounts[0]!,
                    ref: {
                        service,
                        accountId: `account-${index + 1}`,
                    },
                    authenticationModeId: 'manual',
                }),
            );
            const { ConnectedAccountServiceContent } = await import(
                './ConnectedAccountServiceContent'
            );
            const tree = (await renderScreen(
                <ConnectedAccountServiceContent
                    title="Acme"
                    service={service}
                    modes={configuredModes}
                    accounts={configuredAccounts}
                    busy={false}
                    onConfigureService={onConfigureService}
                />,
            )).tree;

            const rows = tree.findAll((node) => (
                node.props.testID
                === 'connected-service-configuration-settings:manual'
            ));
            expect(rows).toHaveLength(2);
            await pressTestInstanceAsync(rows[0]!);
            expect(onConfigureService).toHaveBeenCalledOnce();
            expect(onConfigureService).toHaveBeenCalledWith('manual');
        },
    );
});

const EMPTY_GROUPS_FOR_TEST = {
    source: null,
    groups: [],
    error: null,
    mutating: false,
    refresh: vi.fn(),
    create: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    addMember: vi.fn(),
    patchMember: vi.fn(),
    removeMember: vi.fn(),
    setActiveAccount: vi.fn(),
} as const;
