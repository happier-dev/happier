import * as React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { t } from '@/text';
import type { QualifiedConnectedAccountUiGroup } from '@/sync/domains/connectedServices/qualifiedConnectedAccountUiSource';
import {
    ConnectedServiceAuthGroupPolicyV1Schema,
    type ConnectedServiceCredentialHealthStatusV1,
    type PluginContributionIdentityV1,
    type QualifiedConnectedAccountRef,
} from '@happier-dev/protocol';
import type { StatusPillVariant } from '@/components/ui/status/StatusPill';

import {
    QualifiedAccountDetailView,
    type QualifiedAccountDetailViewProps,
} from './QualifiedAccountDetailView';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const modalState = vi.hoisted(() => ({
    confirmResult: true,
    confirmSpy: vi.fn(),
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

/** The row's own `title` prop (the label), read from the list row that carries it. */
function rowTitleOf(root: ReactTestInstance, testID: string): unknown {
    return root.findAll((node) => (
        node.props?.testID === testID && typeof node.props?.title === 'string'
    ))[0]?.props.title;
}

/** The status pill's rendered variant, read from the element that carries it. */
function statusPillVariantOf(root: ReactTestInstance): unknown {
    return root.findAll((node) => (
        node.props?.testID === 'qualified-account-detail:status-pill'
        && typeof node.props?.variant === 'string'
    ))[0]?.props.variant;
}

function subtitleTextOf(node: ReactTestInstance | null): string {
    if (!node) return '';
    const parts: string[] = [];
    const collect = (value: unknown): void => {
        if (typeof value === 'string' || typeof value === 'number') {
            parts.push(String(value));
            return;
        }
        if (Array.isArray(value)) {
            for (const entry of value) collect(entry);
            return;
        }
        if (value && typeof value === 'object' && 'props' in value) {
            collect((value as { props?: { children?: unknown } }).props?.children);
        }
    };
    collect(node.props?.children);
    return parts.join(' ');
}

describe('QualifiedAccountDetailView', () => {
    beforeEach(() => {
        modalState.confirmResult = true;
        modalState.confirmSpy.mockClear();
    });

    it('renders identity rows from the qualified account props', async () => {
        const screen = await renderDetail({
            providerEmail: 'work@example.com',
            providerAccountId: 'acct_1234',
            status: 'connected',
        });

        expect(subtitleTextOf(screen.findByTestId('qualified-account-detail:row:account-id:subtitle')))
            .toContain('work');
        expect(subtitleTextOf(screen.findByTestId('qualified-account-detail:row:email:subtitle')))
            .toContain('work@example.com');
        expect(subtitleTextOf(screen.findByTestId('qualified-account-detail:row:provider-account-id:subtitle')))
            .toContain('acct_1234');
        expect(screen.findByTestId('qualified-account-detail:status-pill')).toBeTruthy();
    });

    // The pill's colour is NOT this screen's decision: the credential status is
    // derived to `AccountHealth` by the canonical `deriveAccountHealth` owner and
    // painted by `resolveAccountHealthVariant`, exactly as the accounts list dot
    // and the pool aggregate are. `refreshing` is therefore healthy (a credential
    // being renewed is not a problem), not the warning a local table once painted.
    const STATUS_PILL_VARIANTS: ReadonlyArray<
        readonly [ConnectedServiceCredentialHealthStatusV1, StatusPillVariant]
    > = [
        ['connected', 'success'],
        ['refreshing', 'success'],
        ['refresh_failed_retryable', 'warning'],
        ['needs_reauth', 'danger'],
    ];

    it.each(STATUS_PILL_VARIANTS)(
        'paints the "%s" status pill through the canonical account-health variant owner',
        async (status, variant) => {
            const screen = await renderDetail({ status });

            expect(statusPillVariantOf(screen.root)).toBe(variant);
        },
    );

    it('names the qualified id "Account id" and the provider-side id "Provider account id"', async () => {
        const screen = await renderDetail({
            providerAccountId: 'acct_1234',
            status: 'connected',
        });

        // dev's vocabulary reserves "account" for the QUALIFIED identity, so the
        // qualified `ref.accountId` owns the account-id label and the
        // provider-reported id is explicitly namespaced as the provider's.
        expect(rowTitleOf(screen.root, 'qualified-account-detail:row:account-id'))
            .toBe(t('connectedServices.profile.accountId'));
        expect(rowTitleOf(screen.root, 'qualified-account-detail:row:provider-account-id'))
            .toBe(t('connectedServices.profile.providerAccountId'));
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

        expect(hasTitle(screen.root, 'Codex • work@example.com')).toBe(true);
        expect(hasTitle(screen.root, 'Codex • acct-77')).toBe(false);
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

        expect(hasTitle(screen.root, 'Codex • Work account')).toBe(true);
    });

    it('omits the email and provider-account rows when those identity fields are unknown', async () => {
        const screen = await renderDetail({ status: 'connected' });

        expect(screen.findByTestId('qualified-account-detail:row:email')).toBeNull();
        expect(screen.findByTestId('qualified-account-detail:row:provider-account-id')).toBeNull();
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

        expect(screen.findByTestId('qualified-account-detail:action:set-default')).toBeNull();
        expect(screen.findByTestId('qualified-account-detail:default-switch')).toBeNull();
        expect(screen.findByTestId('qualified-account-detail:action:edit-label')).toBeNull();
        expect(screen.findByTestId('qualified-account-detail:action:reconnect')).toBeNull();
        expect(screen.findByTestId('qualified-account-detail:action:disconnect')).toBeNull();
        // The pool row stays readable even without a drill-in callback.
        expect(screen.findByTestId('qualified-account-detail:pool:fallback')).toBeTruthy();
    });

    it('invokes the edit-label and reconnect callbacks', async () => {
        const onEditLabel = vi.fn();
        const onReconnect = vi.fn();
        const screen = await renderDetail({
            status: 'needs_reauth',
            onEditLabel,
            onReconnect,
        });

        screen.pressByTestId('qualified-account-detail:action:edit-label');
        screen.pressByTestId('qualified-account-detail:action:reconnect');

        expect(onEditLabel).toHaveBeenCalledTimes(1);
        expect(onReconnect).toHaveBeenCalledTimes(1);
    });

    it('offers no add-to-pool affordance: membership is edited from the pool detail', async () => {
        const screen = await renderDetail({
            groups: [makeGroup({ groupId: 'fallback', displayName: 'Fallback pool', memberAccountIds: ['work'] })],
            onOpenPool: vi.fn(),
        });

        expect(screen.findByTestId('qualified-account-detail:action:add-to-pool')).toBeNull();
    });

    it('toggles the default account from the settings switch', async () => {
        const onToggleDefault = vi.fn();
        const screen = await renderDetail({ isDefault: false, onToggleDefault });

        const switchNode = screen.findAllByTestId('qualified-account-detail:default-switch')
            .find((node) => typeof node.props?.onValueChange === 'function');
        expect(switchNode).toBeTruthy();
        expect(switchNode?.props.value).toBe(false);

        switchNode?.props.onValueChange(true);

        expect(onToggleDefault).toHaveBeenCalledTimes(1);
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
});
