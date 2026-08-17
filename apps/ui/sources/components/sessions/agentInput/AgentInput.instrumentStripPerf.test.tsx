/**
 * F-UI-11 perf ship-gate host proof (L5 T1.3), on the REAL AgentInput.
 *
 * The claim: after the strip extraction, a usage tick (context snapshot change
 * in the store) re-renders ONLY the SessionInstrumentStrip — the memoized
 * 3k-line AgentInput body does NOT re-execute, because no per-tick prop exists.
 *
 * Probe: the (mocked) MultiTextInput leaf is rendered unconditionally by
 * AgentInput's body, so counting its render invocations counts AgentInput body
 * executions — a strict React.memo bail-out never reaches the leaf.
 *
 * The second case is the permanent positive control (the RED mechanism): the
 * SAME tick delivered as an AgentInput prop DOES re-render the body, proving
 * the probe bites and the flat count in case one is not vacuous.
 */
import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { ComposerSuggestionKindId } from '@/components/autocomplete/composerSuggestionKinds';
import type { SessionContextUsageSnapshotV1 } from '@happier-dev/protocol';

import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Reactive usage store: push() simulates a token_count tick reaching `useSessionUsage`. */
const usageStore = vi.hoisted(() => {
    const state = { current: null as unknown };
    const listeners = new Set<() => void>();
    return {
        state,
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        getSnapshot: () => state.current,
        push(next: unknown) {
            state.current = next;
            listeners.forEach((listener) => listener());
        },
    };
});

const renderCounts = vi.hoisted(() => ({ multiTextInput: 0 }));

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
        const [{ createStorageModuleStub, createUseSettingMock }, { settingsDefaults }] = await Promise.all([
            import('@/dev/testkit/mocks/storage'),
            import('@/sync/domains/settings/settings'),
        ]);
        return {
            ...actual,
            ...createStorageModuleStub({
                // Real defaults so `contextGaugeStyle` resolves to 'gauge'.
                useSetting: createUseSettingMock({ fallback: (key) => settingsDefaults[key] }),
                useSettings: () => settingsDefaults,
                useSessionMessagesById: () => ({}),
                useSessionMessagesVersion: () => 0,
                useSessionTranscriptIds: () => ({ ids: [], isLoaded: true }),
                useSessionMessagesReducerState: () => null,
            }),
            // The strip's own subscription — the seam under test is REAL:
            // ticks flow store → useSessionUsage → useInstrumentStripModel → strip.
            useSessionUsage: () => React.useSyncExternalStore(usageStore.subscribe, usageStore.getSnapshot),
            useSessionProjectScmSnapshot: () => null,
        };
    },
});

vi.mock('expo-image', () => ({ Image: 'Image' }));

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

vi.mock('@/hooks/session/useUserMessageHistory', () => ({
    useUserMessageHistory: () => ({ reset: () => {}, moveUp: () => {}, moveDown: () => {}, setText: () => {} }),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/hooks/ui/useKeyboardHeight', () => ({
    useKeyboardHeight: () => 0,
}));

// AgentInput-body render counter: this leaf renders iff the AgentInput body ran.
vi.mock('@/components/ui/forms/MultiTextInput', () => ({
    MultiTextInput: (props: Record<string, unknown>) => {
        renderCounts.multiTextInput += 1;
        return React.createElement('MultiTextInput', props, null);
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
    findModelOptionForEffectiveModelId: () => null,
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

function contextSnapshot(usedTokens: number): SessionContextUsageSnapshotV1 {
    return {
        v: 1,
        modelId: null,
        usedTokens,
        windowTokens: 200_000,
        totalProcessedTokens: null,
        baselineTokens: null,
        isAutoCompactEnabled: null,
        categories: null,
        observedAtMs: 1,
        source: 'provider_turn',
    };
}

function usageTick(usedTokens: number) {
    return {
        contextSize: usedTokens,
        contextSnapshot: contextSnapshot(usedTokens),
    };
}

const BASE_PROPS = {
    value: '',
    placeholder: 'Type',
    onChangeText: () => {},
    onSend: () => {},
    autocompleteKinds: [] as ComposerSuggestionKindId[],
    autocompleteSuggestions: async () => [],
} as const;

describe('AgentInput instrument-strip perf (F-UI-11 ship gate, host half)', () => {
    it('usage ticks update the strip WITHOUT re-executing the real AgentInput body', async () => {
        const { AgentInput } = await import('./AgentInput');
        usageStore.state.current = usageTick(80_000); // 40%

        const screen = await renderScreen(
            <AgentInput sessionId="s-perf" {...BASE_PROPS} />,
        );

        // Sanity: the strip rendered the gauge from the store subscription.
        expect(screen.findByTestId('session-instrument-context-gauge')).toBeTruthy();
        const baseline = renderCounts.multiTextInput;
        expect(baseline).toBeGreaterThan(0); // probe wired

        // Two streaming token ticks through the REAL store seam.
        act(() => usageStore.push(usageTick(100_000))); // 50%
        act(() => usageStore.push(usageTick(120_000))); // 60%

        // The strip updated (fresh % visible)…
        const hasText = (needle: string) => screen.root.findAll((node) => {
            const children = node.props?.children;
            return children === needle
                || (Array.isArray(children) && children.some((child: unknown) => child === needle));
        }).length > 0;
        expect(hasText('60%')).toBe(true);
        // …while the 3k-line composer body never re-executed.
        expect(renderCounts.multiTextInput).toBe(baseline);
    });

    it('turn-state churn: a stable (useEventCallback) onSend keeps the body flat across parent re-renders', async () => {
        const { AgentInput } = await import('./AgentInput');
        const { useEventCallback } = await import('@/hooks/ui/useEventCallback');
        usageStore.state.current = usageTick(80_000);

        // Mirrors the SessionView R1 fix: the parent re-renders on every
        // turn-state commit, but onSend is a permanently-stable wrapper that
        // forwards to the latest closure — so AgentInput's memo must hold.
        let commitTurnState: (() => void) | null = null;
        function TurnStateParent() {
            const [turnState, setTurnState] = React.useState('idle');
            commitTurnState = () => setTurnState((current) => (current === 'idle' ? 'streaming' : 'idle'));
            // The closure closes over changing turn state, yet the identity is stable.
            const onSend = useEventCallback(() => { void turnState; });
            return <AgentInput sessionId="s-perf" {...BASE_PROPS} onSend={onSend} />;
        }

        await renderScreen(<TurnStateParent />);
        const baseline = renderCounts.multiTextInput;
        expect(baseline).toBeGreaterThan(0);

        act(() => commitTurnState?.());
        act(() => commitTurnState?.());

        // Parent re-rendered on turn-state changes, but the composer body did not.
        expect(renderCounts.multiTextInput).toBe(baseline);
    });

    it('positive control: the SAME tick as an AgentInput prop DOES re-render the body (probe bites)', async () => {
        const { AgentInput } = await import('./AgentInput');
        usageStore.state.current = usageTick(80_000);

        // Pre-fix shape: a parent subscribes and forwards a per-tick prop —
        // exactly what the removed `usageData` prop used to do.
        function LegacyPropPlumbing() {
            const usage = React.useSyncExternalStore(usageStore.subscribe, usageStore.getSnapshot) as
                | { contextSize: number }
                | null;
            return (
                <AgentInput
                    sessionId="s-perf"
                    {...BASE_PROPS}
                    placeholder={`ctx:${usage?.contextSize ?? 0}`}
                />
            );
        }

        await renderScreen(<LegacyPropPlumbing />);
        const baseline = renderCounts.multiTextInput;
        expect(baseline).toBeGreaterThan(0);

        act(() => usageStore.push(usageTick(120_000)));

        expect(renderCounts.multiTextInput).toBeGreaterThan(baseline);
    });
});
