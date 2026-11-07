import * as React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CredentialShareButton } from '@/components/sharing/credentials/CredentialShareSheet';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { flattenTestStyle, reportPopoverContentLayout, withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { createDeferred } from '@/dev/testkit';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { OverlayPortalHost, OverlayPortalProvider } from '@/components/ui/popover/OverlayPortal';
import { PopoverPortalTargetContextProvider } from '@/components/ui/popover/PopoverPortalTarget';
import type { QualifiedConnectedAccountUiGroup } from '@/sync/domains/connectedServices/qualifiedConnectedAccountUiSource';
import { connectedEntitySubjectKeyV1 } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import {
    ConnectedServiceAuthGroupPolicyV1Schema} from '@happier-dev/protocol/connect/connected-service-schemas';
import {
    BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID} from '@happier-dev/protocol/connect/generatedBuiltInLegacyConnectedAccountCompatibility';
import {
    type PluginContributionIdentityV1} from '@happier-dev/protocol/plugins/contribution-identity';
import {
    type QualifiedConnectedAccountRef,
} from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';

import {
    QualifiedAccountDetailView,
    type QualifiedAccountDetailViewProps,
} from './QualifiedAccountDetailView';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const platformState = vi.hoisted(() => ({ os: 'web' }));

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    Platform: { get OS() { return platformState.os; } },
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
// These account journeys do not render Markdown; fail if the unavailable third-party export is used.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Unexpected streaming Markdown in account detail'); },
}));

// The system clipboard is a platform boundary.
const clipboardState = vi.hoisted(() => ({ setStringAsync: vi.fn(async (_value: string) => true) }));
vi.mock('expo-clipboard', () => ({ setStringAsync: clipboardState.setStringAsync, getStringAsync: async () => '' }));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

const SERVICE: PluginContributionIdentityV1 = BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID['openai-codex'].service;

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

it('leaves usage refresh to its Usage section on a wide page (lab s2svc:account)', async () => {
    const refresh = vi.fn();
    const screen = await renderDetail({ onRefresh: refresh });
    // The Usage section's own "As of · Refresh" is the one place it is offered; the header stays identity only.
    expect(screen.findByTestId('qualified-account-detail:refresh')).toBeNull();
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
    });

    afterEach(() => {
        standardCleanup();
        platformState.os = 'web';
        restoreWebGlobals();
        vi.unstubAllGlobals();
    });

    it('keeps compact Rename and Save reachable from a measurable account identity', async () => {
        platformState.os = 'ios';
        const onRename = vi.fn();
        const portalRoot = { measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 0, 390, 844) };
        let screen: Awaited<ReturnType<typeof renderScreen>>;
        // Native layout is the boundary. Only painted content (text, or the pencil button the phone
        // anchors rename to) gives a host an anchor box; a wrapper whose popover moved into the
        // overlay host and holds nothing else stays empty.
        const paintsText = (node: ReactTestInstance | string): boolean => typeof node === 'string'
            ? node.length > 0
            : node.props?.testID === 'qualified-account-detail:action:edit-label' || node.children.some(paintsText);
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
                const props = element.props;
                if (!props || typeof props !== 'object') throw new Error('native host descriptor props are unavailable');
                const ref = 'ref' in props ? props.ref : undefined;
                const children = 'children' in props ? props.children : undefined;
                const bounds = () => {
                    const host = screen?.root.findAll((node) => node.type === element.type && (
                        ref ? node.props.ref === ref : node.props.children === children
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

    it.each([
        ['ChatGPT', 'ChatGPT Pro', 'ChatGPT Pro'],
        ['ChatGPT', 'ChatGPT Pro (Max)', 'ChatGPT Pro (Max)'],
        ['ChatGPT', 'ChatGPT', 'ChatGPT'],
        ['ChatGPT', 'ChatGPTish Pro', 'ChatGPT ChatGPTish Pro'],
        ['Codex', 'Pro', 'Codex Pro'],
        ['ChatGPT', null, 'ChatGPT'],
    ] as const)('composes the %s service and %s plan without repeating its service identity', async (serviceLabel, planLabel, expected) => {
        const screen = await renderDetail({ serviceLabel, planLabel });
        expect(metaTextOf(screen.root, 'qualified-account-detail:meta:plan')).toBe(expected);
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
        // The provider's raw id is not a name and not a page row (lab s2svc:account has neither).
        expect(metaTextOf(screen.root, 'qualified-account-detail:meta:account-id')).toBeUndefined();
        expect(screen.findByTestId('qualified-account-detail:sign-in:account-id')).toBeNull();
        // Identity lives in the header; there is no separate "Account details" list.
        expect(screen.findByTestId('qualified-account-detail:row:email')).toBeNull();
    });

    it('keeps the provider account id reachable from the ⋯ menu, copying it to the clipboard', async () => {
        vi.stubGlobal('navigator', { clipboard: { writeText: clipboardState.setStringAsync } });
        clipboardState.setStringAsync.mockClear();
        const screen = await renderDetail({ providerAccountId: 'user-4fQk8TzW1c', status: 'connected' });
        const menu = screen.root.findAll((node) => Array.isArray(node.props?.items) && typeof node.props?.onSelect === 'function')[0];
        expect(menu?.props.items.map((item: { id: string }) => item.id)).toContain('copy-account-id');
        await act(async () => { await menu!.props.onSelect('copy-account-id'); });
        expect(clipboardState.setStringAsync).toHaveBeenCalledWith('user-4fQk8TzW1c');
    });

    it('offers no account id copy when the provider reported none', async () => {
        const screen = await renderDetail({ status: 'connected', onReconnect: vi.fn() });
        const menu = screen.root.findAll((node) => Array.isArray(node.props?.items) && typeof node.props?.onSelect === 'function')[0];
        expect(menu?.props.items.map((item: { id: string }) => item.id) ?? []).not.toContain('copy-account-id');
    });

    it('joins the machine line to the Sign-in group instead of drawing a sheet of its own', async () => {
        const screen = await renderDetail({
            status: 'connected',
            onReconnect: vi.fn(),
            authenticationModeTitle: 'Signed in with a code',
            machineScopeLine: React.createElement('MachineLineProbe', { testID: 'machine-line-probe' }),
        });
        const signIn = screen.root.findAll((node) => node.props?.testID === 'qualified-account-detail:sign-in' && typeof node.props?.title === 'string')[0]!;
        const probe = screen.root.findAll((node) => node.props?.testID === 'machine-line-probe')[0]!;
        // The nearest group (sheet) around each is the same one.
        const groupOf = (node: ReactTestInstance) => {
            let current: ReactTestInstance | null = node.parent;
            while (current && !(typeof current.props?.title === 'string' && current.props.title === 'Sign-in')) current = current.parent;
            return current;
        };
        expect(groupOf(probe)).not.toBeNull();
        expect(groupOf(probe)).toBe(groupOf(signIn));
    });

    it('promises no sign-in freshness it cannot show (no "keeps it fresh" line)', async () => {
        const screen = await renderDetail({ status: 'connected', onReconnect: vi.fn(), authenticationModeTitle: 'Signed in with a code' });
        const row = screen.root.findAll((node) => node.props?.testID === 'qualified-account-detail:sign-in' && typeof node.props?.title === 'string')[0];
        expect(row).toBeTruthy();
        expect(row!.props.subtitle || undefined).toBeUndefined();
    });

    it('says where and when an account signed in only when that evidence is held, never from last use alone', async () => {
        const signInSubtitle = (screen: Awaited<ReturnType<typeof renderDetail>>) => screen.root.findAll((node) =>
            node.props?.testID === 'qualified-account-detail:sign-in' && typeof node.props?.title === 'string')[0]!.props.subtitle as string | undefined;
        const held = await renderDetail({
            status: 'connected', authenticationModeTitle: 'Signed in with a code',
            authenticationProvenance: { authenticatedAt: Date.UTC(2026, 9, 12, 9, 30), machine: { serverId: 'home-1', machineId: 'machine-1' } },
            authenticationMachineName: 'nl2-devbox', lastRefreshSuccessAt: Date.UTC(2026, 9, 25, 7, 15), lastUsedAt: Date.UTC(2026, 9, 25, 8, 0),
        });
        expect(signInSubtitle(held)).toMatch(/^refreshed .+ · signed in .+ on nl2-devbox$/);
        const unnamed = await renderDetail({
            status: 'connected', authenticationModeTitle: 'Signed in with a code',
            authenticationProvenance: { authenticatedAt: Date.UTC(2026, 9, 12, 9, 30), machine: { serverId: 'other-home', machineId: 'machine-9' } },
        });
        expect(signInSubtitle(unnamed)).toMatch(/^signed in [^·]+$/);
        const imported = await renderDetail({ status: 'connected', authenticationModeTitle: 'Signed in with a code', lastUsedAt: Date.UTC(2026, 9, 25, 8, 0) });
        expect(signInSubtitle(imported)).toMatch(/^last used /);
        expect(signInSubtitle(imported)).not.toMatch(/signed in|refreshed/);
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
                primaryLabelKind: 'email',
                secondaryLabel: 'Codex · acct-77',
                accessibilityLabel: 'Codex · work@example.com · acct-77',
            },
            providerEmail: 'work@example.com',
            status: 'connected',
        });

        expect(hasTitle(screen.root, 'work@example.com')).toBe(true);
        expect(hasTitle(screen.root, 'acct-77')).toBe(false);
        // The title already is the email: the header says it once.
        expect(metaTextOf(screen.root, 'qualified-account-detail:meta:email')).toBeUndefined();
    });

    it('does not repeat the email when the account is named by that same address', async () => {
        const screen = await renderDetail({
            presentation: { primaryLabel: 'work@example.com', accessibilityLabel: 'Codex · work@example.com' },
            providerEmail: 'work@example.com',
            status: 'connected',
        });

        expect(hasTitle(screen.root, 'work@example.com')).toBe(true);
        expect(metaTextOf(screen.root, 'qualified-account-detail:meta:email')).toBeUndefined();
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
        // The header says which pool holds it ("… · in Fallback pool").
        expect(metaTextOf(screen.root, 'qualified-account-detail:meta:pool')).toContain('Fallback pool');

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

    it('offers Use original name only while a personal label is set, clearing it through the same rename write', async () => {
        const onRename = vi.fn(async () => true);
        const unlabelled = await renderDetail({ rename: { currentLabel: '', onRename } });
        await unlabelled.pressByTestIdAsync('qualified-account-detail:action:edit-label');
        await act(async () => reportPopoverContentLayout(unlabelled, { width: 320, height: 180 }));
        expect(unlabelled.findHostByTestId('qualified-account-detail:rename:reset')).toBeNull();

        const screen = await renderDetail({ rename: { currentLabel: 'Work account', onRename } });
        await screen.pressByTestIdAsync('qualified-account-detail:action:edit-label');
        await act(async () => reportPopoverContentLayout(screen, { width: 320, height: 180 }));
        await screen.pressByTestIdAsync('qualified-account-detail:rename:reset');
        expect(onRename).toHaveBeenCalledWith('');
        expect(screen.findHostByTestId('qualified-account-detail:rename:input')).toBeNull();
    });

    it('keeps the rename draft until the write is acknowledged and retains it after failure', async () => {
        const receipt = createDeferred<boolean>();
        const onRename = vi.fn(() => receipt.promise);
        const onReconnect = vi.fn();
        const screen = await renderDetail({
            status: 'needs_reauth',
            rename: { currentLabel: 'Work account', onRename },
            onReconnect,
        });

        expect(screen.findByTestId('qualified-account-detail:rename:input')).toBeNull();
        await screen.pressByTestIdAsync('qualified-account-detail:action:edit-label');
        await act(async () => reportPopoverContentLayout(screen, { width: 320, height: 180 }));
        await act(async () => screen.changeTextByTestId('qualified-account-detail:rename:input', '  Team · Acme  '));
        expect(screen.findHostByTestId('qualified-account-detail:rename:input')?.props.value).toBe('  Team · Acme  ');
        await act(async () => { screen.pressByTestId('qualified-account-detail:rename:save'); });
        expect(onRename).toHaveBeenCalledWith('Team · Acme');
        expect(screen.findHostByTestId('qualified-account-detail:rename:input')?.props.value).toBe('  Team · Acme  ');
        await act(async () => { receipt.resolve(false); await receipt.promise; });
        expect(screen.findHostByTestId('qualified-account-detail:rename:input')?.props.value).toBe('  Team · Acme  ');
        onRename.mockImplementation(async () => true);
        await screen.pressByTestIdAsync('qualified-account-detail:rename:save');
        expect(screen.findHostByTestId('qualified-account-detail:rename:input')).toBeNull();

        // Signed out, the banner owns Sign in again (the section row offers it only to a healthy account).
        screen.pressByTestId('qualified-account-detail:signed-out-banner:sign-in-again');
        expect(onReconnect).toHaveBeenCalledTimes(1);
    });

    it('shares the connected account from the header Share action, not a page row or the ⋯ menu', async () => {
        const source = { kind: 'connected_account' as const, serverId: 'server-a', account: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'acct-1' } };
        const screen = await renderDetail({ shareSource: source });

        // One Share action in the header opens the one credential share sheet for this exact source.
        expect(screen.findAllByType(CredentialShareButton).map((button) => button.props.source)).toEqual([source]);
        expect(screen.findByTestId('qualified-account-detail:action:share-with-team')).toBeNull();
        const without = await renderDetail({});
        expect(without.findAllByType(CredentialShareButton)).toHaveLength(0);
    });

    it('offers no add-to-pool affordance: membership is edited from the pool detail', async () => {
        const screen = await renderDetail({
            groups: [makeGroup({ groupId: 'fallback', displayName: 'Fallback pool', memberAccountIds: ['work'] })],
            onOpenPool: vi.fn(),
        });

        expect(screen.findByTestId('qualified-account-detail:action:add-to-pool')).toBeNull();
    });

    it('offers ★ "default for an agent" with Used by, never in the header or as a per-service default switch', async () => {
        const setDefault = vi.fn();
        const screen = await renderDetail({
            agentDefaults: { choices: [{ agentId: 'codex', title: 'Codex', isDefault: true }], setDefault },
        });

        expect(screen.findByTestId('qualified-account-detail:default-for')).toBeTruthy();
        const header = screen.findByTestId('qualified-account-detail:header');
        expect(header?.findAll((node) => node.props?.testID === 'qualified-account-detail:default-for')).toHaveLength(0);
        const usedBy = screen.findByTestId('account-detail-used-by');
        expect(usedBy?.findAll((node) => node.props?.testID === 'qualified-account-detail:default-for').length).toBeGreaterThan(0);
        expect(screen.findByTestId('qualified-account-detail:default-switch')).toBeNull();
    });

    it('says a signed-out account is blocked in a banner here, with the fix, and keeps its usage in view', async () => {
        const onReconnect = vi.fn();
        const screen = await renderDetail({
            status: 'needs_reauth',
            statusReason: 'invalid_client',
            onReconnect,
            usageSection: <></>,
        });

        expect(screen.findByTestId('qualified-account-detail:signed-out-banner')).toBeTruthy();
        expect(screen.getTextContent()).toContain('Signed out · app access was removed');
        screen.pressByTestId('qualified-account-detail:signed-out-banner:sign-in-again');
        expect(onReconnect).toHaveBeenCalledTimes(1);

        const healthy = await renderDetail({ status: 'connected', onReconnect });
        expect(healthy.findByTestId('qualified-account-detail:signed-out-banner')).toBeNull();
    });

    it('offers Sign in again once: the signed-out banner owns it, and a running sign-in replaces it', async () => {
        const onReconnect = vi.fn();
        const signedOut = await renderDetail({ status: 'needs_reauth', onReconnect, authenticationModeTitle: 'Signed in with a browser' });
        expect(signedOut.findByTestId('qualified-account-detail:signed-out-banner:sign-in-again')).toBeTruthy();
        expect(signedOut.findByTestId('qualified-account-detail:action:reconnect')).toBeNull();
        standardCleanup();

        // The attempt runs inside its Sign-in section; nothing else offers to start another one.
        const running = await renderDetail({ status: 'needs_reauth', onReconnect, authenticationModeTitle: 'Signed in with a browser',
            signInFlow: <></> });
        expect(running.findByTestId('qualified-account-detail:signed-out-banner')).toBeTruthy();
        expect(running.findByTestId('qualified-account-detail:signed-out-banner:sign-in-again')).toBeNull();
        expect(running.findByTestId('qualified-account-detail:action:reconnect')).toBeNull();
    });

    // Owner ruling 2026-11-07: pool membership requires confirmation, never blocks removal.
    it.each(['button', 'menu'] as const)('allows removing a pooled account through the %s and retains the separate leave-pool action', async (entry) => {
        const onDisconnect = vi.fn();
        const onOpenPool = vi.fn();
        const props = {
            groups: [makeGroup({ groupId: 'work-pool', displayName: 'Work pool', memberAccountIds: ['work'] })],
            onOpenPool,
            onDisconnect,
            labelsByKey: { [connectedEntitySubjectKeyV1({ kind: 'group', service: SERVICE, groupId: 'work-pool' })]: 'Personal work pool' },
        };
        const pooled = await renderDetail(props);
        expect(rowTitleOf(pooled.root, 'qualified-account-detail:action:leave-pool:work-pool')).toContain('Personal work pool');

        const remove = pooled.findAll((node) => node.props?.testID === 'qualified-account-detail:action:disconnect'
            && typeof node.props?.onPress === 'function')[0];
        expect(remove?.props.disabled).toBeFalsy();
        pooled.pressByTestId('qualified-account-detail:action:leave-pool:work-pool');
        expect(onOpenPool).toHaveBeenCalledWith('work-pool');
        expect(onDisconnect).not.toHaveBeenCalled();
        if (entry === 'button') {
            await pooled.pressByTestIdAsync('qualified-account-detail:action:disconnect');
        } else {
            const menu = pooled.root.findByType(DropdownMenu);
            expect(menu.props.items.find((item: { id: string }) => item.id === 'disconnect')?.disabled).toBeFalsy();
            await act(async () => { await menu.props.onSelect('disconnect'); });
        }
        expect(onDisconnect).toHaveBeenCalledOnce();

        const alone = await renderDetail({ groups: [], onOpenPool, onDisconnect });
        const enabled = alone.findAll((node) => node.props?.testID === 'qualified-account-detail:action:disconnect'
            && typeof node.props?.onPress === 'function')[0];
        expect(enabled?.props.disabled).toBeFalsy();
    });
});
