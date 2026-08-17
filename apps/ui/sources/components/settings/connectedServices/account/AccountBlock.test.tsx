import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import {
    ConnectedServiceQuotaSnapshotV1Schema,
    type ConnectedServiceQuotaSnapshotV1,
} from '@happier-dev/protocol';
import type { UseConnectedServiceQuotaSnapshotResult } from '@/hooks/server/connectedServices/useConnectedServiceQuotaSnapshot';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW_MS = 1_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('react-native-svg', () => ({
    SvgXml: (props: Record<string, unknown>) => React.createElement('SvgXml', props),
    // The capacity-ring avatar renders an SVG ring (Svg + Circle).
    Svg: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Svg', props, props.children),
    Circle: (props: Record<string, unknown>) => React.createElement('Circle', props, null),
}));

vi.mock('react-native-gesture-handler', async () => {
    const { createGestureHandlerMock } = await import('@/dev/testkit/mocks/gestureHandler');
    return createGestureHandlerMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

const reducedMotionRef = vi.hoisted(() => ({ value: true }));
vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => reducedMotionRef.value,
}));

const modalState = vi.hoisted(() => ({ confirmResult: true, confirmSpy: vi.fn() }));
vi.mock('@/modal', () => ({
    Modal: {
        confirm: (...args: unknown[]) => {
            modalState.confirmSpy(...args);
            return Promise.resolve(modalState.confirmResult);
        },
    },
}));

const featureState = vi.hoisted(() => ({ quotasEnabled: true }));
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) =>
        featureId === 'connectedServices.quotas' ? featureState.quotasEnabled : true,
}));

const quotaHookState = vi.hoisted(() => ({
    callSpy: vi.fn(),
    value: null as unknown,
}));
vi.mock('@/hooks/server/connectedServices/useConnectedServiceQuotaSnapshot', () => ({
    useConnectedServiceQuotaSnapshot: (params: unknown) => {
        quotaHookState.callSpy(params);
        return quotaHookState.value;
    },
}));

const settingsState = vi.hoisted(() => ({
    collapsed: {} as Record<string, boolean>,
    writes: [] as Array<Record<string, boolean>>,
}));
vi.mock('@/sync/store/hooks', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/store/hooks')>();
    const ReactModule = await import('react');
    return {
        ...actual,
        useSettingMutable: (key: string) => {
            const [value, setValue] = ReactModule.useState(() => settingsState.collapsed);
            const setter = (next: Record<string, boolean>) => {
                settingsState.writes.push(next);
                settingsState.collapsed = next;
                setValue(next);
            };
            return [value, setter];
        },
    };
});

/** Flatten an RN style prop (array or object) into one lookup for layout assertions. */
function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>(
            (accumulator, entry) => Object.assign(accumulator, flattenStyle(entry)),
            {},
        );
    }
    if (style && typeof style === 'object') return style as Record<string, unknown>;
    return {};
}

/**
 * Style of the columned-section grid CELL a node sits in, or `{}` when the node
 * is not inside one. Cells are the only ancestors that declare `flexBasis`.
 */
function resolveEnclosingGridCellStyle(node: { parent: unknown; props: Record<string, unknown> } | null): Record<string, unknown> {
    let current = node as { parent: unknown; props?: Record<string, unknown> } | null;
    while (current) {
        const style = flattenStyle(current.props?.style);
        if (style.flexBasis !== undefined) return style;
        current = current.parent as { parent: unknown; props?: Record<string, unknown> } | null;
    }
    return {};
}

function buildSnapshot(overrides: Partial<ConnectedServiceQuotaSnapshotV1> = {}): ConnectedServiceQuotaSnapshotV1 {
    return ConnectedServiceQuotaSnapshotV1Schema.parse({
        v: 1,
        serviceId: 'anthropic',
        profileId: 'work',
        fetchedAt: NOW_MS - 1000,
        staleAfterMs: 60_000,
        planLabel: 'Pro',
        accountLabel: null,
        // dev's recoveryCredits sub-schema is .strict(): only { availableCount, credits }.
        // Each credit requires `id` (not remote-dev's `providerCreditId`).
        recoveryCredits: {
            availableCount: 1,
            credits: [
                { id: 'pc-1', kind: 'usage_limit_reset', status: 'available', expiresAtMs: NOW_MS + 3 * DAY_MS },
            ],
        },
        meters: [
            { meterId: 'weekly', label: 'Weekly', used: 82, limit: 100, unit: 'count', utilizationPct: null, resetsAt: null, status: 'ok', details: {} },
        ],
        ...overrides,
    });
}

function buildQuotaResult(overrides: Partial<UseConnectedServiceQuotaSnapshotResult> = {}): UseConnectedServiceQuotaSnapshotResult {
    return {
        snapshot: buildSnapshot(),
        loading: false,
        error: null,
        nowMs: NOW_MS,
        recoveryCreditSummary: { availableCount: 1, nextExpiresAtMs: NOW_MS + 3 * DAY_MS, providerCreditId: 'pc-1' },
        recoveryCreditMachineId: 'machine-1',
        canRefresh: true,
        isRefreshing: false,
        refresh: vi.fn(async () => {}),
        consumeRecoveryCredit: vi.fn(async () => {}),
        consumeRecoveryCreditPending: false,
        consumeRecoveryCreditPendingTarget: null,
        pinnedMeterIds: [],
        togglePinnedMeter: vi.fn(),
        ...overrides,
    };
}

beforeEach(() => {
    reducedMotionRef.value = true;
    modalState.confirmResult = true;
    modalState.confirmSpy.mockClear();
    featureState.quotasEnabled = true;
    quotaHookState.callSpy.mockClear();
    quotaHookState.value = buildQuotaResult();
    settingsState.collapsed = {};
    settingsState.writes = [];
});

afterEach(() => {
    vi.clearAllMocks();
});

async function renderAccountBlock(props: Partial<React.ComponentProps<typeof import('./AccountBlock')['AccountBlock']>> = {}) {
    const { AccountBlock } = await import('./AccountBlock');
    return renderScreen(
        <AccountBlock
            testID="acct"
            serviceId="anthropic"
            profileId="work"
            title="Work"
            status="connected"
            {...props}
        />,
    );
}

describe('AccountBlock', () => {
    it('renders a calm collapsed meta line (resets + pools counts) with capacity in the ring', async () => {
        settingsState.collapsed = { 'anthropic:account:work': true };
        const screen = await renderAccountBlock({ poolLabels: ['Team'] });

        // Per-limit usage now reads from the avatar's capacity rings (center number),
        // not from collapsed mini-meters.
        expect(screen.findByTestId('acct:avatar:capacity')).toBeTruthy();
        // Resets + pool membership are muted counts on the meta line (not pills/chips).
        expect(screen.findByTestId('acct:resets')).toBeTruthy();
        expect(screen.findByTestId('acct:pools-count')).toBeTruthy();
        // Collapsed: the expanded body Pools section is not rendered.
        expect(screen.findAllByTestId('acct:body-pools').length).toBe(0);
        expect(screen.findAllByTestId('acct:pools-label').length).toBe(0);
        // Collapsed: the expanded body sections are not rendered.
        expect(screen.getTextContent()).not.toContain('connectedServices.account.usageCaption');
    });

    it('moves pool membership into a labelled "Pools" section when expanded', async () => {
        // Detail variant defaults to expanded.
        const screen = await renderAccountBlock({ poolLabels: ['Team'] });

        // The collapsed meta line (with the pools count) is absent when expanded.
        expect(screen.findAllByTestId('acct:pools-count').length).toBe(0);
        // Expanded body carries the labelled Pools section with the membership chip.
        expect(screen.findByTestId('acct:body-pools')).toBeTruthy();
        expect(screen.findByTestId('acct:pools-label')).toBeTruthy();
        expect(screen.findByTestId('acct:body-pool-chip:0')).toBeTruthy();
        expect(screen.getTextContent()).toContain('connectedServices.account.poolsLabel');
    });

    it('shows a needs-re-auth badge in the header when the credential needs re-auth', async () => {
        settingsState.collapsed = { 'anthropic:account:work': true };
        const screen = await renderAccountBlock({ status: 'needs_reauth' });

        expect(screen.findByTestId('acct:reauth-badge')).toBeTruthy();
    });

    it('lets credential health dominate quota display and polling when re-auth is required', async () => {
        const screen = await renderAccountBlock({ status: 'needs_reauth' });

        // The container is the single DISPLAY fail-direction owner: an EXPLICIT
        // needs_reauth hides usage AND never mounts the snapshot hook (no fetch),
        // while the reauth badge stays pinned.
        expect(quotaHookState.callSpy).not.toHaveBeenCalled();
        expect(screen.findByTestId('acct:reauth-badge')).toBeTruthy();
        expect(screen.findAllByTestId('acct:meter:weekly')).toHaveLength(0);
        expect(screen.getTextContent()).not.toContain('connectedServices.account.usageCaption');
        expect(screen.findByTestId('acct:avatar:capacity')).toBeNull();
    });

    it('renders usage for a healthy account whose status is empty/unknown (fails OPEN)', async () => {
        // Regression: an absent status coerced to '' must NOT blank the capacity
        // avatar or surface a reauth pill. Only an EXPLICIT needs_reauth hides
        // usage; '' is presumed healthy for display, so the snapshot hook mounts
        // (fetch key sees RAW) and quota renders.
        const screen = await renderAccountBlock({
            // Boundary value: the runtime feed can carry an absent/coerced '' that
            // the enum-typed callers do not model; the display gate must fail open.
            status: '',
        });

        expect(quotaHookState.callSpy).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('acct:avatar:capacity')).toBeTruthy();
        expect(screen.findAllByTestId('acct:reauth-badge').length).toBe(0);
    });

    it('shows a default-account star glyph (not a pill) for the default account', async () => {
        const screen = await renderAccountBlock({ isDefault: true });
        expect(screen.findByTestId('acct:default-star')).toBeTruthy();
    });

    it('reveals USAGE and QUOTA RESETS sections when expanded', async () => {
        const screen = await renderAccountBlock();

        const text = screen.getTextContent();
        expect(text).toContain('connectedServices.account.usageCaption');
        expect(text).toContain('connectedServices.account.resetsCaption');
        expect(screen.findByTestId('acct:meter:weekly')).toBeTruthy();
        expect(screen.findByTestId('acct:reset-row:pc-1')).toBeTruthy();
        expect(screen.findByTestId('acct:reset-use:pc-1')).toBeTruthy();
    });

    it('confirms before consuming a reset and skips consume when cancelled', async () => {
        modalState.confirmResult = false;
        const quota = buildQuotaResult();
        quotaHookState.value = quota;
        const screen = await renderAccountBlock();

        await screen.pressByTestIdAsync('acct:reset-use:pc-1');

        expect(modalState.confirmSpy).toHaveBeenCalledTimes(1);
        expect(quota.consumeRecoveryCredit).not.toHaveBeenCalled();
    });

    it('consumes the reset through the hook after the confirm is accepted, threading THAT row credit id', async () => {
        modalState.confirmResult = true;
        const quota = buildQuotaResult();
        quotaHookState.value = quota;
        const screen = await renderAccountBlock();

        await screen.pressByTestIdAsync('acct:reset-use:pc-1');

        expect(modalState.confirmSpy).toHaveBeenCalledTimes(1);
        // Per-credit "Use": the row's own credit id is forwarded so the
        // correct credit is redeemed (not just the summary default).
        expect(quota.consumeRecoveryCredit).toHaveBeenCalledTimes(1);
        expect(quota.consumeRecoveryCredit).toHaveBeenCalledWith('pc-1');
    });

    it('forwards a null credit id for the aggregate placeholder row (summary default)', async () => {
        modalState.confirmResult = true;
        const quota = buildQuotaResult({
            snapshot: buildSnapshot({
                recoveryCredits: {
                    availableCount: 2,
                    // No detailed credits -> a single aggregate row consumed via the
                    // summary default (consumableCreditId: null).
                    credits: [],
                },
            }),
        });
        quotaHookState.value = quota;
        const screen = await renderAccountBlock();

        await screen.pressByTestIdAsync('acct:reset-use:aggregate');

        expect(quota.consumeRecoveryCredit).toHaveBeenCalledWith(null);
    });

    it('shows pending only on the reset row being consumed while disabling the other rows', async () => {
        quotaHookState.value = buildQuotaResult({
            snapshot: buildSnapshot({
                recoveryCredits: {
                    availableCount: 2,
                    credits: [
                        { id: 'pc-1', kind: 'usage_limit_reset', status: 'available', expiresAtMs: NOW_MS + 2 * DAY_MS },
                        { id: 'pc-2', kind: 'usage_limit_reset', status: 'available', expiresAtMs: NOW_MS + 3 * DAY_MS },
                    ],
                },
            }),
            recoveryCreditSummary: { availableCount: 2, nextExpiresAtMs: NOW_MS + 2 * DAY_MS, providerCreditId: 'pc-1' },
            consumeRecoveryCreditPending: true,
            consumeRecoveryCreditPendingTarget: { providerCreditId: 'pc-2' },
        });
        const screen = await renderAccountBlock();

        const firstUse = screen.findByTestId('acct:reset-use:pc-1');
        const secondUse = screen.findByTestId('acct:reset-use:pc-2');

        expect(firstUse?.props.disabled).toBe(true);
        expect(secondUse?.props.disabled).toBe(true);
        expect(firstUse?.findAll((node) => node.props?.accessibilityRole === 'progressbar').length).toBe(0);
        expect(secondUse?.findAll((node) => node.props?.accessibilityRole === 'progressbar').length).toBe(1);
    });

    it('disables the reset Use action when no target machine is resolved', async () => {
        // In dev every schema-valid credit carries an `id`, so a reset row is always
        // individually consumable; the reachable "disabled" path is a missing target
        // machine (consumeUnavailableReason === 'machine'), which keeps the action
        // visible-but-inert with the inline explanation.
        quotaHookState.value = buildQuotaResult({ recoveryCreditMachineId: null });

        const screen = await renderAccountBlock();

        expect(screen.findByTestId('acct:reset-use:pc-1')?.props.disabled).toBe(true);
    });

    it('lays the resets machine-unavailable hint out as a full-width grid cell', async () => {
        // RESETS is a columned section, so every child must be exactly ONE grid
        // cell. The hint explains the whole section, so its cell spans every
        // column instead of taking a half-width slot beside the first reset row.
        quotaHookState.value = buildQuotaResult({ recoveryCreditMachineId: null });

        const screen = await renderAccountBlock();

        const hint = screen.findByTestId('acct:resets-hint');
        expect(hint).toBeTruthy();
        // `flexBasis` is what a grid CELL declares (the grid container itself does
        // not), so an unwrapped hint resolves to no cell at all.
        expect(resolveEnclosingGridCellStyle(hint).flexBasis).toBe('100%');
    });

    it('persists collapse state to connectedServicesCollapsedItemKeysV1 (sparse deviation)', async () => {
        const screen = await renderAccountBlock();

        // Account default is expanded -> toggling collapses it, persisting the deviation only.
        screen.findByTestId('acct:header')?.props.onPress?.();

        expect(settingsState.writes).toContainEqual({ 'anthropic:account:work': true });
    });

    it('toggles the pinned meter through the hook', async () => {
        const quota = buildQuotaResult();
        quotaHookState.value = quota;
        const screen = await renderAccountBlock();

        screen.findByTestId('acct:pin:weekly')?.props.onPress?.();

        expect(quota.togglePinnedMeter).toHaveBeenCalledWith('weekly');
    });

    it('tells a pinned meter from an unpinned one by glyph weight, not colour alone', async () => {
        // The pin is an icon-only button: nothing else in it changes when a meter is pinned, so a
        // primary-vs-secondary text colour was the entire signal — two greys apart in the dark
        // theme, and invisible to anyone who cannot separate them. `DESIGN.md`: do not rely on
        // colour alone.
        quotaHookState.value = buildQuotaResult({ pinnedMeterIds: [] });
        const unpinned = await renderAccountBlock();
        expect(unpinned.findByTestId('acct:pin:weekly')?.props.children.props.weight).toBe('regular');

        quotaHookState.value = buildQuotaResult({ pinnedMeterIds: ['weekly'] });
        const pinned = await renderAccountBlock();
        expect(pinned.findByTestId('acct:pin:weekly')?.props.children.props.weight).toBe('fill');
    });

    it('fails closed when the quotas feature is disabled (no fetch, no usage)', async () => {
        featureState.quotasEnabled = false;
        const screen = await renderAccountBlock();

        expect(quotaHookState.callSpy).not.toHaveBeenCalled();
        expect(screen.getTextContent()).not.toContain('connectedServices.account.usageCaption');
        expect(screen.findAllByTestId('acct:meter:weekly').length).toBe(0);
    });

    it('shows a loading skeleton before the first snapshot resolves', async () => {
        quotaHookState.value = buildQuotaResult({ snapshot: null, loading: true });
        const screen = await renderAccountBlock();

        expect(screen.findByTestId('acct:usage-skeleton')).toBeTruthy();
        expect(screen.findAllByTestId('acct:meter:weekly').length).toBe(0);
    });

    it('shows quota errors inline without hiding the account row', async () => {
        quotaHookState.value = buildQuotaResult({
            snapshot: null,
            loading: false,
            error: 'quota load failed',
        });

        const screen = await renderAccountBlock();

        expect(screen.findByTestId('acct:header')).toBeTruthy();
        expect(screen.findByTestId('acct:quota-error')).toBeTruthy();
        expect(screen.getTextContent()).toContain('quota load failed');
    });

    it('shows the refresh-in-flight state and disables duplicate refresh presses', async () => {
        quotaHookState.value = buildQuotaResult({ isRefreshing: true });

        const screen = await renderAccountBlock();
        const refresh = screen.findByTestId('acct:refresh');

        expect(screen.findByTestId('acct:refreshing')).toBeTruthy();
        expect(refresh?.props.disabled).toBe(true);
        expect(refresh?.props.accessibilityState).toEqual(expect.objectContaining({
            busy: true,
            disabled: true,
        }));
    });

    it('invokes the quota refresh once per refresh-button press', async () => {
        const refresh = vi.fn(async () => {});
        quotaHookState.value = buildQuotaResult({ refresh });

        const screen = await renderAccountBlock();

        screen.findByTestId('acct:refresh')?.props.onPress?.({ stopPropagation: vi.fn() });

        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('renders the account header as a group when the trailing refresh button is present', async () => {
        const screen = await renderAccountBlock();

        expect(screen.findByTestId('acct:header')?.props.role).toBe('group');
    });
});
