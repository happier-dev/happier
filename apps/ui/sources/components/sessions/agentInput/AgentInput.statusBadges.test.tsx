import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { ConnectedServiceQuotaGaugeViewModel } from '@/sync/domains/connectedServices/connectedServiceQuotaGauge';

import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-svg', () => ({
    __esModule: true,
    default: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Svg', props, props.children),
    Svg: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Svg', props, props.children),
    Circle: (props: Record<string, unknown>) => React.createElement('Circle', props, null),
    G: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('G', props, props.children),
}));

const capturedFloatingOverlayProps = vi.hoisted(() => ({
    last: null as (Record<string, unknown> & { children?: React.ReactNode }) | null,
}));

installAgentInputCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string) => key,
            translateLoose: (key: string) => key,
        });
    },
    storage: async (importOriginal) => {
        const actual = await importOriginal<Record<string, unknown>>();
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return {
            ...actual,
            ...createStorageModuleStub({
                useSetting: () => null,
                useSettings: () => ({}),
                useSessionMessagesById: () => ({}),
                useSessionMessagesVersion: () => 0,
                useSessionTranscriptIds: () => ({ ids: [], isLoaded: true }),
                useSessionMessagesReducerState: () => null,
            }),
            useSessionProjectScmSnapshot: () => null,
        };
    },
});

vi.mock('expo-image', () => ({
    Image: 'Image',
}));

vi.mock('react-native-svg', () => ({
    Svg: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Svg', props, props.children),
    Circle: (props: Record<string, unknown>) => React.createElement('Circle', props, null),
}));

vi.mock('@/hooks/session/useUserMessageHistory', () => ({
    useUserMessageHistory: () => ({ reset: () => {}, moveUp: () => {}, moveDown: () => {}, setText: () => {} }),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/hooks/ui/useKeyboardHeight', () => ({
    useKeyboardHeight: () => 0,
}));

vi.mock('@/components/ui/forms/MultiTextInput', () => ({
    MultiTextInput: (props: Record<string, unknown>) => React.createElement('MultiTextInput', props, null),
}));

vi.mock('@/components/ui/overlays/FloatingOverlay', () => ({
    FloatingOverlay: (props: Record<string, unknown> & { children?: React.ReactNode }) => {
        capturedFloatingOverlayProps.last = props;
        return React.createElement('FloatingOverlay', props, props.children);
    },
}));

vi.mock('@/agents/catalog/catalog', () => ({
    getAgentIconSvgXml: () => null,
    getAgentIconSource: () => null,
    getAgentIconTintColor: () => undefined,
    AGENT_IDS: ['codex', 'claude', 'opencode', 'gemini'],
    DEFAULT_AGENT_ID: 'codex',
    resolveAgentIdFromFlavor: () => null,
    getAgentCore: () => ({ displayNameKey: 'agents.codex', toolRendering: { hideUnknownToolsByDefault: false } }),
}));

vi.mock('@/sync/domains/models/modelOptions', () => ({
    findModelOptionForEffectiveModelId: (options: any, effectiveModelId: any) =>
        options?.find?.((option: any) => option.value === effectiveModelId)
            ?? options?.find?.((option: any) => option.value === String(effectiveModelId ?? '').replace(/\[[^\]]*\]$/u, ''))
            ?? null,
    getModelOptionsForSession: () => [{ value: 'default', label: 'Default' }],
    supportsFreeformModelSelectionForSession: () => false,
}));

vi.mock('@/sync/domains/models/describeEffectiveModelMode', () => ({
    describeEffectiveModelMode: () => ({ selectedModelId: 'default', appliedModelId: null, effectiveModelId: 'default' }),
}));

vi.mock('@/sync/domains/permissions/permissionModeOptions', () => ({
    getPermissionModeBadgeLabelForAgentType: () => 'Default',
    getPermissionModeLabelForAgentType: () => 'Default',
    getPermissionModeOptionsForSession: () => [{ value: 'default', label: 'Default' }],
    getPermissionModeTitleForAgentType: () => 'Permissions',
}));

vi.mock('@/sync/domains/permissions/describeEffectivePermissionMode', () => ({
    describeEffectivePermissionMode: () => ({ effectiveMode: 'default' }),
}));

describe('AgentInput status badges', () => {
    it('renders provider quota gauge as a clickable usage badge', async () => {
        const { AgentInput } = await import('./AgentInput');
        const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: {
                addEventListener: () => {},
                removeEventListener: () => {},
            },
        });
        const providerUsageGauge: ConnectedServiceQuotaGaugeViewModel = {
            serviceId: 'openai-codex',
            providerDisplayName: 'OpenAI Codex',
            activeAccountDisplayLabel: 'Work account',
            remainingPct: 18,
            usedPct: 82,
            primaryValueSemantics: 'remaining',
            valueLabel: '18%',
            ringValueLabel: '18',
            badgeLabel: '18%',
            scopePrefix: 'w.',
            detailRightLabel: '18% left',
            usedLimitLabel: '82/100 used',
            resetLabel: null,
            tone: 'warning',
            isStale: false,
            recoveryCreditSummary: {
                availableCount: 1,
                nextExpiresAtMs: null,
                providerCreditId: null,
            },
            effectiveMeter: {
                meterId: 'weekly',
                label: 'Weekly',
                used: 82,
                limit: 100,
                unit: 'count',
                utilizationPct: null,
                remainingPct: 18,
                resetsAt: null,
                status: 'ok',
                details: {},
            },
            allMeterRows: [{
                meterId: 'weekly',
                label: 'Weekly',
                remainingPct: 18,
                usedPct: 82,
                detailRightSemantics: 'remaining',
                detailRightLabel: '18% left',
                usedLimitSemantics: 'used',
                usedLimitLabel: '82/100 used',
                resetLabel: null,
                tone: 'warning',
            }],
        };
        const onProviderUsageRecoveryCreditPress = vi.fn();

        try {
            const screen = await renderScreen(
                <AgentInput
                    value=""
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    autocompletePrefixes={[]}
                    autocompleteSuggestions={async () => []}
                    instrumentQuota={{
                        viewModel: providerUsageGauge,
                        onRecoveryCreditPress: onProviderUsageRecoveryCreditPress,
                    }}
                />,
            );

            const badge = screen.findByTestId('session-instrument-quota-ring');
            expect(badge).toBeTruthy();
            expect(screen.findByTestId('session-instrument-quota-ring-arc')).toBeTruthy();

            act(() => {
                badge?.props.onPress?.({} as never);
            });

            expect(screen.findByTestId('session-instrument-quota-popover')).toBeTruthy();
            expect(screen.findByTestId('session-instrument-quota-meter:weekly')).toBeTruthy();
            const recoveryCreditAction = screen.findByTestId('session-instrument-quota-recovery-credit-action');
            expect(recoveryCreditAction).toBeTruthy();
            act(() => {
                recoveryCreditAction?.props.onPress?.({} as never);
            });
            expect(onProviderUsageRecoveryCreditPress).toHaveBeenCalledTimes(1);
            expect(capturedFloatingOverlayProps.last?.scrollEnabled).toBe(false);
        } finally {
            if (previousWindowDescriptor) {
                Object.defineProperty(globalThis, 'window', previousWindowDescriptor);
            } else {
                delete (globalThis as { window?: unknown }).window;
            }
        }
    });

    it('renders status badges and keeps their popovers click-persistent', async () => {
        const { AgentInput } = await import('./AgentInput');
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

        try {
            const screen = await renderScreen(
                <AgentInput
                    value=""
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    autocompletePrefixes={[]}
                    autocompleteSuggestions={async () => []}
                    connectionStatus={{
                        text: 'online',
                        color: 'green',
                        dotColor: 'green',
                    }}
                    statusBadges={[{
                        key: 'work-state',
                        label: 'Goal: ship',
                        testID: 'session-work-state-status-badge',
                        renderPopover: (ctx) => ctx.open
                            ? React.createElement('WorkStatePopover', {
                                testID: 'session-work-state-popover',
                                onRequestClose: ctx.onRequestClose,
                            })
                            : null,
                    }]}
                />,
            );

            expect(screen.findByTestId('session-work-state-popover')).toBeNull();

            const badge = screen.findByTestId('session-work-state-status-badge');
            expect(badge).toBeTruthy();

            act(() => {
                badge?.props.onPress?.({} as never);
            });
            expect(screen.findByTestId('session-work-state-popover')).toBeTruthy();

            act(() => {
                screen.findByTestId('session-work-state-popover')?.props.onRequestClose();
            });
            expect(screen.findByTestId('session-work-state-popover')).toBeNull();
        } finally {
            consoleError.mockRestore();
        }
    });
});
