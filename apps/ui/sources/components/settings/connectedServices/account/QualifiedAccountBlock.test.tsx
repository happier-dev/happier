import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import {
    QualifiedConnectedAccountQuotaSnapshotV4Schema,
    type QualifiedConnectedAccountQuotaSnapshotV4,
    type QualifiedConnectedAccountRef,
} from '@happier-dev/protocol';
import type {
    UseQualifiedConnectedAccountQuotaResult,
} from '@/hooks/server/connectedServices/useQualifiedConnectedAccountQuota';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW_MS = 1_000_000_000;

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
    Svg: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Svg', props, props.children),
    Circle: (props: Record<string, unknown>) => React.createElement('Circle', props, null),
}));

vi.mock('react-native-gesture-handler', async () => {
    const { createGestureHandlerMock } = await import('@/dev/testkit/mocks/gestureHandler');
    return createGestureHandlerMock();
});

// Interpolation params are kept in the rendered string so counted copy stays assertable.
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key, params) => (params ? `${key}(${JSON.stringify(params)})` : key),
    });
});

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => true,
}));

vi.mock('@/modal', () => ({
    Modal: { confirm: () => Promise.resolve(true) },
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

const quotaHookState = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('@/hooks/server/connectedServices/useQualifiedConnectedAccountQuota', () => ({
    useQualifiedConnectedAccountQuota: () => quotaHookState.value,
}));

const settingsState = vi.hoisted(() => ({
    collapsed: {} as Record<string, boolean>,
    pinnedMeterIdsByKey: {} as Record<string, string[]>,
    applied: [] as Array<Record<string, unknown>>,
}));
vi.mock('@/sync/store/hooks', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/store/hooks')>();
    const ReactModule = await import('react');
    return {
        ...actual,
        useSetting: (name: Parameters<typeof actual.useSetting>[0]) => (
            name === 'connectedServicesQuotaPinnedMeterIdsByKey'
                ? settingsState.pinnedMeterIdsByKey
                : actual.useSetting(name)
        ),
        useSettingMutable: () => {
            const [value, setValue] = ReactModule.useState(() => settingsState.collapsed);
            return [value, (next: Record<string, boolean>) => {
                settingsState.collapsed = next;
                setValue(next);
            }];
        },
    };
});

vi.mock('@/sync/store/settingsWriters', () => ({
    useApplySettings: () => (delta: Record<string, unknown>) => {
        settingsState.applied.push(delta);
    },
}));

const ACCOUNT: QualifiedConnectedAccountRef = {
    service: { pluginId: 'happier.anthropic', localId: 'claude' },
    accountId: 'acct-1',
};

function buildSnapshot(
    recoveryCredits: QualifiedConnectedAccountQuotaSnapshotV4['recoveryCredits'],
): QualifiedConnectedAccountQuotaSnapshotV4 {
    return QualifiedConnectedAccountQuotaSnapshotV4Schema.parse({
        v: 1,
        ref: ACCOUNT,
        fetchedAt: NOW_MS - 1000,
        staleAfterMs: 600_000,
        planLabel: 'Pro',
        accountLabel: null,
        recoveryCredits,
        meters: [
            {
                meterId: 'weekly',
                label: 'Weekly',
                used: 40,
                limit: 100,
                unit: 'count',
                utilizationPct: null,
                resetsAt: null,
                status: 'ok',
                details: {},
            },
        ],
    });
}

function buildQuotaResult(
    overrides: Partial<UseQualifiedConnectedAccountQuotaResult> = {},
): UseQualifiedConnectedAccountQuotaResult {
    return {
        supported: true,
        snapshot: buildSnapshot({ availableCount: 1, credits: [] }),
        loading: false,
        refreshing: false,
        error: null,
        refresh: vi.fn(async () => {}),
        ...overrides,
    };
}

beforeEach(() => {
    settingsState.collapsed = {};
    settingsState.pinnedMeterIdsByKey = {};
    settingsState.applied = [];
    quotaHookState.value = buildQuotaResult();
});

/** Build a pan reorder gesture via the gesture-handler mock to bind a handle. */
async function makeReorderGesture() {
    const { Gesture } = await import('react-native-gesture-handler');
    return Gesture.Pan();
}

async function renderQualifiedAccountBlock(
    props: Partial<React.ComponentProps<typeof import('./QualifiedAccountBlock')['QualifiedAccountBlock']>> = {},
) {
    const { QualifiedAccountBlock } = await import('./QualifiedAccountBlock');
    return renderScreen(
        <QualifiedAccountBlock
            testID="acct"
            account={ACCOUNT}
            title="Work"
            status="connected"
            {...props}
        />,
    );
}

describe('QualifiedAccountBlock', () => {
    it('counts available resets through the shared summary owner, not the rendered row count', async () => {
        // A v4 account must read the same reset count a legacy account reads for
        // the same credits. Undisclosed credits collapse into ONE aggregate row,
        // so the row count is not the available count.
        settingsState.collapsed = { 'happier.anthropic:claude:account:acct-1': true };
        quotaHookState.value = buildQuotaResult({
            snapshot: buildSnapshot({ availableCount: 3, credits: [] }),
        });

        const screen = await renderQualifiedAccountBlock();

        expect(screen.findByTestId('acct:resets')).toBeTruthy();
        expect(screen.getTextContent()).toContain('connectedServices.quota.recoveryCreditBadge({"count":3})');
    });

    it('shows no reset signal when the account holds no available credits', async () => {
        settingsState.collapsed = { 'happier.anthropic:claude:account:acct-1': true };
        quotaHookState.value = buildQuotaResult({
            snapshot: buildSnapshot({ availableCount: 0, credits: [] }),
        });

        const screen = await renderQualifiedAccountBlock();

        expect(screen.findAllByTestId('acct:resets').length).toBe(0);
    });

    it('reads and writes pinned meters under the canonical connected-service profile key', async () => {
        // Pins are a SHARED per-account preference: the Usage panel and the
        // settings-list badges look them up with `connectedServiceProfileKey`
        // over the qualified service key, exactly as labels and default-account
        // preferences do. A block-local key format would make every V4 pin
        // invisible to those surfaces.
        settingsState.pinnedMeterIdsByKey = { 'happier.anthropic%2Fclaude/acct-1': ['monthly'] };

        const screen = await renderQualifiedAccountBlock();
        screen.findByTestId('acct:pin:weekly')?.props.onPress?.();

        expect(settingsState.applied).toEqual([{
            connectedServicesQuotaPinnedMeterIdsByKey: {
                'happier.anthropic%2Fclaude/acct-1': ['monthly', 'weekly'],
            },
        }]);
    });

    it('offers no reset redemption affordance when the account has no redemption operation', async () => {
        // V4 exposes no credit-redemption operation at all, so "Use" must be
        // ABSENT rather than a disabled button excused by the machine-unavailable
        // copy — that copy would claim a transient machine problem the protocol
        // never has.
        quotaHookState.value = buildQuotaResult({
            snapshot: buildSnapshot({ availableCount: 1, credits: [] }),
        });

        const screen = await renderQualifiedAccountBlock();

        expect(screen.findAllByTestId('acct:reset-use:aggregate').length).toBe(0);
        expect(screen.findAllByTestId('acct:resets-hint').length).toBe(0);
        expect(screen.getTextContent()).not.toContain('connectedServices.quota.recoveryCreditMachineUnavailable');
    });

    // Pools are V4-only, so the qualified block is the ONLY container that still
    // drives the shared view's `poolMember` variant (QualifiedPoolDetailView is
    // its single caller). These cases moved here from the legacy block's suite
    // when that container's dead pool pass-through was removed.
    describe('poolMember variant', () => {
        it('renders collapsed by default with an inline reorder handle, enable switch, and capacity', async () => {
            const onToggleEnabled = vi.fn();
            const screen = await renderQualifiedAccountBlock({
                variant: 'poolMember',
                groupId: 'g1',
                enabled: true,
                onToggleEnabled,
                reorderGesture: await makeReorderGesture(),
            });

            // Default-collapsed: body sections hidden.
            expect(screen.getTextContent()).not.toContain('connectedServices.account.usageCaption');
            // The handle is rendered INLINE inside the view (mirroring SessionItem),
            // bound to the supplied pan gesture via a GestureDetector.
            expect(screen.findByTestId('acct:reorder-handle')).toBeTruthy();
            // Capacity now lives in the ring avatar (its centered value).
            expect(screen.findByTestId('acct:avatar:capacity')).toBeTruthy();

            const enableSwitch = screen.findByTestId('acct:enable-toggle');
            expect(enableSwitch).toBeTruthy();
            enableSwitch?.props.onValueChange?.(false);
            expect(onToggleEnabled).toHaveBeenCalledWith(false);
        });

        it('shows the active-account radio and sets active from the list', async () => {
            const onSetActive = vi.fn();
            const screen = await renderQualifiedAccountBlock({
                variant: 'poolMember',
                groupId: 'g1',
                enabled: true,
                isActive: false,
                onSetActive,
                reorderGesture: await makeReorderGesture(),
            });
            const radio = screen.findByTestId('acct:active-radio');
            expect(radio).toBeTruthy();
            expect(radio?.props.accessibilityState?.checked).toBe(false);
            radio?.props.onPress?.({});
            expect(onSetActive).toHaveBeenCalled();
        });

        it('marks the active member radio selected and non-interactive', async () => {
            const screen = await renderQualifiedAccountBlock({
                variant: 'poolMember',
                groupId: 'g1',
                enabled: true,
                isActive: true,
                onSetActive: vi.fn(),
                reorderGesture: await makeReorderGesture(),
            });
            const radio = screen.findByTestId('acct:active-radio');
            expect(radio?.props.accessibilityState?.checked).toBe(true);
            expect(radio?.props.accessibilityState?.disabled).toBe(true);
        });

        it('renders the inline reorder handle in the trailing cluster and collapses member actions into a single kebab', async () => {
            const actions: ItemAction[] = [
                { id: 'act:move-up', title: 'Move up', icon: 'arrow-up', onPress: () => {} },
                { id: 'act:move-down', title: 'Move down', icon: 'arrow-down', onPress: () => {} },
                { id: 'act:set-active', title: 'Set active', icon: 'circle', onPress: () => {} },
            ];
            const screen = await renderQualifiedAccountBlock({
                variant: 'poolMember',
                groupId: 'g1',
                enabled: true,
                onToggleEnabled: vi.fn(),
                reorderGesture: await makeReorderGesture(),
                actions,
            });

            // The handle now lives in the header's trailing cluster (rendered as
            // the header `Item`'s rightElement), i.e. it is a descendant of the
            // header row instead of a leading sibling in front of the row.
            const header = screen.findByTestId('acct:header');
            expect(header).toBeTruthy();
            expect(header?.findAll((node) => node.props?.testID === 'acct:reorder-handle').length).toBe(1);

            // Member actions collapse into one ⋮ overflow menu (kebab) rather
            // than inline icons on the row.
            expect(screen.findByTestId('acct:actions-menu')).toBeTruthy();

            // Move up / Move down / Set active are no longer inline on the row —
            // they live inside the (closed) kebab popover, so none are present.
            expect(screen.findAllByTestId('act:move-up').length).toBe(0);
            expect(screen.findAllByTestId('act:move-down').length).toBe(0);
            expect(screen.findAllByTestId('act:set-active').length).toBe(0);
        });
    });
});
