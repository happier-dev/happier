import * as React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { flattenTestStyle, withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { OverlayPortalHost, OverlayPortalProvider } from '@/components/ui/popover/OverlayPortal';
import { PopoverPortalTargetContextProvider } from '@/components/ui/popover/PopoverPortalTarget';
import type { QualifiedConnectedAccountUiGroup } from '@/sync/domains/connectedServices/qualifiedConnectedAccountUiSource';
import {
    ConnectedServiceAuthGroupPolicyV1Schema,
    type PluginContributionIdentityV1,
    type QualifiedConnectedAccountRef,
} from '@happier-dev/protocol';

import {
    QualifiedAccountDetailView,
    type QualifiedAccountDetailViewProps,
} from './QualifiedAccountDetailView';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const modalState = vi.hoisted(() => ({
    confirmResult: true,
    confirmSpy: vi.fn(),
}));
const platformState = vi.hoisted(() => ({ os: 'web' }));

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    Platform: { get OS() { return platformState.os; } },
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
// These account journeys do not render Markdown; fail if the unavailable third-party export is used.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Unexpected streaming Markdown in account detail'); },
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            confirm: async (...args) => {
                modalState.confirmSpy(...args);
                return modalState.confirmResult;
            },
        },
    }).module;
});

const SERVICE: PluginContributionIdentityV1 = {
    pluginId: 'openai-codex',
    localId: 'openai-codex',
};

const ACCOUNT: QualifiedConnectedAccountRef = {
    service: SERVICE,
    accountId: 'work',
};

function makeGroup(params: Readonly<{
    groupId: string;
    displayName: string | null;
    memberAccountIds: readonly string[];
}>): QualifiedConnectedAccountUiGroup {
    return {
        ref: { service: SERVICE, groupId: params.groupId },
        displayName: params.displayName,
        policy: ConnectedServiceAuthGroupPolicyV1Schema.parse({}),
        activeAccountId: params.memberAccountIds[0] ?? null,
        revision: {
            protocol: 'v4',
            incarnation: `qualified-group-row:${params.groupId}`,
            generation: 1,
            runtimeStateRevision: 1,
        },
        state: {},
        members: params.memberAccountIds.map((accountId, index) => ({
            ref: { service: SERVICE, accountId },
            priority: 100 + index,
            enabled: true,
            state: {},
        })),
    };
}

function renderDetail(overrides: Partial<QualifiedAccountDetailViewProps> = {}) {
    const props: QualifiedAccountDetailViewProps = {
        account: ACCOUNT,
        serviceLabel: 'Codex',
        presentation: {
            primaryLabel: 'Work account',
            secondaryLabel: 'Codex · work',
            accessibilityLabel: 'Codex · Work account · work',
        },
        ...overrides,
    };
    return renderScreen(<QualifiedAccountDetailView {...props} />);
}

/** Whether any rendered node (group header or row) carries exactly this title. */
function hasTitle(root: ReactTestInstance, title: string): boolean {
    return root.findAll((node) => node.props?.title === title).length > 0;
}

it('offers the supported usage refresh at the account header', async () => {
    const refresh = vi.fn();
    const screen = await renderDetail({ onRefresh: refresh });
    await screen.pressByTestIdAsync('qualified-account-detail:refresh');
    expect(refresh).toHaveBeenCalledTimes(1);
});

/** The row's own `title` prop (the label), read from the list row that carries it. */
function rowTitleOf(root: ReactTestInstance, testID: string): unknown {
    return root.findAll((node) => (
        node.props?.testID === testID && typeof node.props?.title === 'string'
    ))[0]?.props.title;
}

/** The text of one header fact (the identity line under the title), read by its test id. */
function metaTextOf(root: ReactTestInstance, testID: string): string | undefined {
    const node = root.findAll((candidate) => candidate.props?.testID === testID)[0];
    if (!node) return undefined;
    const parts: string[] = [];
    const collect = (value: unknown): void => {
        if (typeof value === 'string' || typeof value === 'number') { parts.push(String(value)); return; }
        if (Array.isArray(value)) { value.forEach(collect); return; }
        if (value && typeof value === 'object' && 'props' in value) collect((value as { props?: { children?: unknown; value?: unknown } }).props?.children ?? (value as { props?: { value?: unknown } }).props?.value);
    };
    collect(node.props?.children ?? node.props?.value);
    return parts.join('');
}

describe('QualifiedAccountDetailView', () => {
    let restoreWebGlobals: () => void;
    beforeEach(() => {
        platformState.os = 'web';
        restoreWebGlobals = withPopoverWebGlobals();
        modalState.confirmResult = true;
        modalState.confirmSpy.mockClear();
    });

    afterEach(() => {
        standardCleanup();
        platformState.os = 'web';
        restoreWebGlobals();
    });

    it('keeps compact Rename and Save reachable from a measurable account identity', async () => {
        platformState.os = 'ios';
        const onRename = vi.fn();
        const portalRoot = { measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 0, 390, 844) };
        let screen: Awaited<ReturnType<typeof renderScreen>>;
        // Native layout is the boundary. Only actually painted text gives a host an anchor box;
        // the compact pencil wrapper is empty once its popover moves into the overlay host.
        const paintsText = (node: ReactTestInstance | string): boolean => typeof node === 'string'
            ? node.length > 0 : node.children.some(paintsText);
        screen = await renderScreen(
            <PopoverPortalTargetContextProvider value={{ rootRef: { current: portalRoot }, layout: { width: 390, height: 844 } }}>
                <OverlayPortalProvider>
                    <QualifiedAccountDetailView account={ACCOUNT} serviceLabel="Codex"
                        presentation={{ primaryLabel: 'Work account', secondaryLabel: 'Codex', accessibilityLabel: 'Work account' }}
                        rename={{ currentLabel: 'Work account', onRename }} />
                    <OverlayPortalHost />
                </OverlayPortalProvider>
            </PopoverPortalTargetContextProvider>,
            { createNodeMock: (element) => {
                // react-test-renderer passes a host descriptor, not a React
                // element with $$typeof, to the native measurement boundary.
                const props: { ref?: unknown; children?: React.ReactNode } = element.props;
                const bounds = () => {
                    const host = screen?.root.findAll((node) => node.type === element.type && (
                        props?.ref ? node.props.ref === props.ref : node.props.children === props?.children
                    ))[0];
                    return host && paintsText(host) ? { width: 390, height: 120 } : { width: 0, height: 0 };
                };
                return {
                    measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => {
                        const rect = bounds(); callback(0, 60, rect.width, rect.height);
                    },
                    measureLayout: (_relative: unknown, callback: (x: number, y: number, width: number, height: number) => void) => {
                        const rect = bounds(); callback(0, 60, rect.width, rect.height);
                    },
                };
            } },
        );
        await act(async () => {
            screen.root.findAll((node) => typeof node.type === 'string' && node.props.testID === 'qualified-account-detail')[0]
                .props.onLayout({ nativeEvent: { layout: { width: 390, height: 844 } } });
        });
        await screen.pressByTestIdAsync('qualified-account-detail:action:edit-label');
        await act(async () => {
            for (const node of screen.root.findAll((node) => typeof node.type === 'string' && typeof node.props.onLayout === 'function')) {
                node.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 380, height: 170 } } });
            }
            await flushHookEffects({ cycles: 1, turns: 8 });
        });
        const save = screen.findHostByTestId('qualified-account-detail:rename:save');
        expect(save).not.toBeNull();
        for (let node = save; node; node = node.parent) {
            if (typeof node.type !== 'string') continue;
            expect(node.props.pointerEvents).not.toBe('none');
            expect(flattenTestStyle(node.props.style).opacity).not.toBe(0);
        }
        await act(async () => screen.changeTextByTestId('qualified-account-detail:rename:input', 'Team'));
        await screen.pressByTestIdAsync('qualified-account-detail:rename:save');
        expect(onRename).toHaveBeenCalledWith('Team');
        expect(screen.findHostByTestId('qualified-account-detail:rename:input')).toBeNull();
    });

    it('offers account configuration only when declared and opens its existing form', async () => {
        const absent = await renderDetail();
        expect(absent.findByTestId('qualified-account-detail:configuration')).toBeNull();
        const onConfigureAccount = vi.fn();
        const screen = await renderDetail({ onConfigureAccount, accountConfigurationBlocked: true });
        expect(screen.findByTestId('qualified-account-detail:configuration')).toBeTruthy();
        expect(screen.root.findAll((node) => node.props.testID === 'qualified-account-detail:configuration'
            && node.props.detail === 'Blocked').length).toBeGreaterThan(0);
        screen.pressByTestId('qualified-account-detail:configuration');
        expect(onConfigureAccount).toHaveBeenCalledOnce();
    });

    it('offers service configuration separately with its blocked state and exact mode', async () => {
        const onConfigure = vi.fn();
        const screen = await renderDetail({
            serviceConfigurations: [{ modeId: 'enterprise', title: 'Enterprise sign-in', blocked: true, onConfigure }],
        });
        const id = 'connected-service-configuration-settings:enterprise';
        expect(screen.findByTestId(id)).toBeTruthy();
        expect(screen.root.findAll((node) => node.props.testID === id
            && node.props.detail === 'Enterprise sign-in · Blocked').length).toBeGreaterThan(0);
        screen.pressByTestId(id);
        expect(onConfigure).toHaveBeenCalledOnce();
        expect(screen.findByTestId('qualified-account-detail:configuration')).toBeNull();
    });

    it('says who the account is in its header: the email, the service and plan, and the provider account id (lab csvc D1)', async () => {
        const screen = await renderDetail({
            providerEmail: 'work@example.com',
            providerAccountId: 'user-4fQk8TzW1c',
            planLabel: 'Pro',
            status: 'connected',
        });

        expect(metaTextOf(screen.root, 'qualified-account-detail:meta:email')).toBe('work@example.com');
        expect(metaTextOf(screen.root, 'qualified-account-detail:meta:plan')).toBe('Codex Pro');
        expect(metaTextOf(screen.root, 'qualified-account-detail:meta:account-id')).toContain('user-4fQk8TzW1c');
        // Identity lives in the header; there is no separate "Account details" list.
        expect(screen.findByTestId('qualified-account-detail:row:email')).toBeNull();
    });

    it('says a signed-out account once, in its banner, never also as a header pill (lab csvc D2)', async () => {
        const screen = await renderDetail({ status: 'needs_reauth', onReconnect: vi.fn() });

        expect(screen.findByTestId('qualified-account-detail:signed-out-banner')).toBeTruthy();
        expect(screen.findByTestId('qualified-account-detail:status-pill')).toBeNull();
    });

    it('names the account by its provider email when the caller resolved no label', async () => {
        // With no user label the presenter ranks the provider email first, so the
        // screen must title itself with that email and never with an opaque
        // account identifier the user cannot recognise.
        const screen = await renderDetail({
            account: { service: SERVICE, accountId: 'acct-77' },
            presentation: {
                primaryLabel: 'work@example.com',
                secondaryLabel: 'Codex · acct-77',
                accessibilityLabel: 'Codex · work@example.com · acct-77',
            },
            providerEmail: 'work@example.com',
            status: 'connected',
        });

        expect(hasTitle(screen.root, 'work@example.com')).toBe(true);
        expect(hasTitle(screen.root, 'acct-77')).toBe(false);
    });

    it('keeps a resolved account label ahead of the provider email', async () => {
        const screen = await renderDetail({
            presentation: {
                primaryLabel: 'Work account',
                secondaryLabel: 'Codex · work@example.com · work',
                accessibilityLabel: 'Codex · Work account · work@example.com · work',
            },
            providerEmail: 'work@example.com',
            status: 'connected',
        });

        expect(hasTitle(screen.root, 'Work account')).toBe(true);
    });

    it('omits the email and account id facts when those identity fields are unknown', async () => {
        const screen = await renderDetail({ status: 'connected' });

        expect(metaTextOf(screen.root, 'qualified-account-detail:meta:email')).toBeUndefined();
        expect(metaTextOf(screen.root, 'qualified-account-detail:meta:account-id')).toBeUndefined();
    });

    it('lists pools the account belongs to and drills into the pressed pool', async () => {
        const onOpenPool = vi.fn();
        const screen = await renderDetail({
            groups: [
                makeGroup({ groupId: 'fallback', displayName: 'Fallback pool', memberAccountIds: ['work', 'personal'] }),
                makeGroup({ groupId: 'other', displayName: 'Other pool', memberAccountIds: ['personal'] }),
            ],
            onOpenPool,
        });

        expect(screen.findByTestId('qualified-account-detail:pool:other')).toBeNull();
        expect(screen.findByTestId('qualified-account-detail:pools-empty')).toBeNull();

        screen.pressByTestId('qualified-account-detail:pool:fallback');

        expect(onOpenPool).toHaveBeenCalledTimes(1);
        expect(onOpenPool).toHaveBeenCalledWith('fallback');
    });

    it('uses the author service title rather than an unnamed pool\'s opaque id', async () => {
        const screen = await renderDetail({
            groups: [makeGroup({ groupId: 'pool_opaque_123', displayName: null, memberAccountIds: ['work'] })],
        });

        expect(rowTitleOf(screen.root, 'qualified-account-detail:pool:pool_opaque_123')).toBe('Codex');
    });

    it('shows the empty pools state when the account belongs to no pool', async () => {
        const screen = await renderDetail({
            groups: [makeGroup({ groupId: 'other', displayName: 'Other pool', memberAccountIds: ['personal'] })],
        });

        expect(screen.findByTestId('qualified-account-detail:pools-empty')).toBeTruthy();
    });

    it('renders the pools section whenever pools apply, including for an empty pool list', async () => {
        // `groups` is the ONE signal that pools apply to this service; an empty
        // array still means "pools apply, this account is in none of them".
        const screen = await renderDetail({ groups: [] });

        expect(screen.findByTestId('qualified-account-detail:pools-empty')).toBeTruthy();
    });

    it('omits the pools section entirely when pools do not apply to the service', async () => {
        const screen = await renderDetail({});

        expect(screen.findByTestId('qualified-account-detail:pools-empty')).toBeNull();
    });

    it('hides every mutation affordance whose callback is absent', async () => {
        const screen = await renderDetail({
            groups: [makeGroup({ groupId: 'fallback', displayName: 'Fallback pool', memberAccountIds: ['work'] })],
            status: 'needs_reauth',
        });

        expect(screen.findByTestId('qualified-account-detail:action:edit-label')).toBeNull();
        expect(screen.findByTestId('qualified-account-detail:action:reconnect')).toBeNull();
        expect(screen.findByTestId('qualified-account-detail:action:disconnect')).toBeNull();
        // The pool row stays readable even without a drill-in callback.
        expect(screen.findByTestId('qualified-account-detail:pool:fallback')).toBeTruthy();
    });

    it('renames the account in place: the pencil opens a small popover under the name, and Save writes the new name', async () => {
        const onRename = vi.fn();
        const onReconnect = vi.fn();
        const screen = await renderDetail({
            status: 'needs_reauth',
            rename: { currentLabel: 'Work account', onRename },
            onReconnect,
        });

        expect(screen.findByTestId('qualified-account-detail:rename:input')).toBeNull();
        await screen.pressByTestIdAsync('qualified-account-detail:action:edit-label');
        await act(async () => screen.changeTextByTestId('qualified-account-detail:rename:input', '  Team · Acme  '));
        expect(screen.findHostByTestId('qualified-account-detail:rename:input')?.props.value).toBe('  Team · Acme  ');
        await screen.pressByTestIdAsync('qualified-account-detail:rename:save');
        expect(onRename).toHaveBeenCalledWith('Team · Acme');

        screen.pressByTestId('qualified-account-detail:action:reconnect');
        expect(onReconnect).toHaveBeenCalledTimes(1);
    });

    it('offers the connected account to a Team through the mounted source action', async () => {
        const onShareWithTeam = vi.fn();
        const screen = await renderDetail({ onShareWithTeam });

        screen.pressByTestId('qualified-account-detail:action:share-with-team');

        expect(onShareWithTeam).toHaveBeenCalledTimes(1);
    });

    it('offers no add-to-pool affordance: membership is edited from the pool detail', async () => {
        const screen = await renderDetail({
            groups: [makeGroup({ groupId: 'fallback', displayName: 'Fallback pool', memberAccountIds: ['work'] })],
            onOpenPool: vi.fn(),
        });

        expect(screen.findByTestId('qualified-account-detail:action:add-to-pool')).toBeNull();
    });

    it('offers ★ "default for an agent" in the header, never a per-service default switch', async () => {
        const setDefault = vi.fn();
        const screen = await renderDetail({
            agentDefaults: { choices: [{ agentId: 'codex', title: 'Codex', isDefault: true }], setDefault },
        });

        expect(screen.findByTestId('qualified-account-detail:default-for')).toBeTruthy();
        expect(screen.findByTestId('qualified-account-detail:default-switch')).toBeNull();
    });

    it('confirms before disconnecting and does not disconnect when the confirmation is declined', async () => {
        modalState.confirmResult = false;
        const onDisconnect = vi.fn();
        const screen = await renderDetail({ onDisconnect });

        await screen.pressByTestIdAsync('qualified-account-detail:action:disconnect');

        expect(modalState.confirmSpy).toHaveBeenCalledTimes(1);
        expect(onDisconnect).not.toHaveBeenCalled();
    });

    it('confirms disconnect against the full identity, not the bare account id', async () => {
        modalState.confirmResult = false;
        const screen = await renderDetail({
            presentation: {
                primaryLabel: 'Work account',
                secondaryLabel: 'Codex · work@example.com · work',
                accessibilityLabel: 'Codex · Work account · work@example.com · work',
            },
            providerEmail: 'work@example.com',
            onDisconnect: vi.fn(),
        });

        await screen.pressByTestIdAsync('qualified-account-detail:action:disconnect');

        // Disconnect is irreversible, so the prompt names every identity the user
        // could RECOGNISE the account by — its label, provider email and
        // provider-side account identity. The canonical account id is never one
        // of them: the shared presenter deliberately does not emit it.
        const body = modalState.confirmSpy.mock.calls[0]?.[1];
        expect(body).toContain('Work account · work@example.com · work');
    });

    it('disconnects after the confirmation is accepted', async () => {
        modalState.confirmResult = true;
        const onDisconnect = vi.fn();
        const screen = await renderDetail({ onDisconnect });

        await screen.pressByTestIdAsync('qualified-account-detail:action:disconnect');

        expect(modalState.confirmSpy).toHaveBeenCalledTimes(1);
        expect(onDisconnect).toHaveBeenCalledTimes(1);
    });
    it('says a signed-out account is blocked in a banner here, with the fix, and keeps its usage in view', async () => {
        const onReconnect = vi.fn();
        const screen = await renderDetail({
            status: 'needs_reauth',
            onReconnect,
            usageSection: <></>,
        });

        expect(screen.findByTestId('qualified-account-detail:signed-out-banner')).toBeTruthy();
        screen.pressByTestId('qualified-account-detail:signed-out-banner:sign-in-again');
        expect(onReconnect).toHaveBeenCalledTimes(1);

        const healthy = await renderDetail({ status: 'connected', onReconnect });
        expect(healthy.findByTestId('qualified-account-detail:signed-out-banner')).toBeNull();
    });

    it('never offers a removal that would fail: while a pool uses the account, the way out of the pool comes first', async () => {
        const onDisconnect = vi.fn();
        const onOpenPool = vi.fn();
        const pooled = await renderDetail({
            groups: [makeGroup({ groupId: 'work-pool', displayName: 'Work pool', memberAccountIds: ['work'] })],
            onOpenPool,
            onDisconnect,
        });

        const remove = pooled.findAll((node) => node.props?.testID === 'qualified-account-detail:action:disconnect'
            && typeof node.props?.onPress === 'function')[0];
        expect(remove?.props.disabled).toBe(true);
        pooled.pressByTestId('qualified-account-detail:action:leave-pool:work-pool');
        expect(onOpenPool).toHaveBeenCalledWith('work-pool');
        expect(onDisconnect).not.toHaveBeenCalled();

        const alone = await renderDetail({ groups: [], onOpenPool, onDisconnect });
        const enabled = alone.findAll((node) => node.props?.testID === 'qualified-account-detail:action:disconnect'
            && typeof node.props?.onPress === 'function')[0];
        expect(enabled?.props.disabled).toBeFalsy();
    });
});
