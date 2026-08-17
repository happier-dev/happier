/**
 * The model picker's ARIA pattern must not move while the popup is open.
 *
 * `OptionPickerOverlay` declares `optionsHostInlineControls` from the presence
 * of `onSelectOptionControlValue` — the surface's WIRING. That declaration is
 * only static if the wiring itself is static, and this adapter used to withdraw
 * the handler whenever the selection was a provider-connection model, which
 * made the declaration selection-derived after all. It was masked in production
 * because both shipped call sites ALSO pass `multiColumn`, and the columns prop
 * forces the grid on its own.
 *
 * So the discriminating probe is single column: `multiColumn` off, where the
 * handler is the ONLY input to the pattern.
 */
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

const BODY_TEST_ID = 'model-picker-overlay-selection-list:body';
const CONTROLS_TEST_ID = 'model-picker-overlay-selected-controls';

const connectionId = ProviderConnectionIdSchema.parse('pc_pattern');

const nativeSelection = {
    agentTargetKey: 'backend:codex',
    providerConnectionId: null,
    modelId: 'gpt-5.6-sol',
} as const;

const providerSelection = {
    agentTargetKey: 'backend:codex',
    providerConnectionId: connectionId,
    modelId: 'listed',
} as const;

const providerGroups = [{
    connectionId,
    providerName: 'Gateway',
    connectionName: 'Work',
    connectionRole: 'named' as const,
    connectionDisplayNameMode: 'custom' as const,
    connectionRevision: 1,
    authorization: { authorized: true as const },
    manualModelPolicy: 'catalog-only' as const,
    supportsFreeformModelIds: false,
    suppressedConnectedServiceIds: [],
    modelLoadAction: 'descriptor_absent' as const,
    rows: [{
        ref: providerSelection,
        descriptor: { id: 'listed', name: 'Listed' },
        sources: { manual: false, static: true, probe: false },
        confidence: 'verified_static' as const,
        compatibility: {
            result: {
                status: 'verified' as const,
                selectedProtocol: 'openai-responses' as const,
                evidence: { sourceUrls: ['https://example.test'], verifiedAt: '2026-07-12' },
            },
            compatibilityFingerprint: 'compatibility:v1:pattern',
            confirmed: true,
        },
        endpointHealth: 'available' as const,
        catalog: { stale: false },
        loadState: 'unknown' as const,
        visibility: 'visible' as const,
    }],
}];

const optionControls = [{
    option: {
        id: 'reasoning_effort',
        name: 'Thinking',
        type: 'select' as const,
        currentValue: 'medium',
        options: [
            { value: 'low', name: 'Low' },
            { value: 'high', name: 'High' },
        ],
    },
    effectiveValue: 'medium',
    isPending: false,
}];

describe('SessionModelPicker — the popup pattern survives every selection, single column', () => {
    it('holds the grid pattern across a provider-connection selection and a full control withdrawal', async () => {
        const { SessionModelPicker } = await import('./SessionModelPicker');
        const onSelectOptionControlValue = vi.fn();
        const element = (
            selected: typeof nativeSelection | typeof providerSelection,
            controls: typeof optionControls | undefined,
        ) => (
            <SessionModelPicker
                agentTargetKey="backend:codex"
                nativeModels={[{ value: 'gpt-5.6-sol', label: '5.6 Sol' }]}
                providerGroups={providerGroups}
                providerProjectionAuthoritative
                selected={selected}
                effectiveLabel="5.6 Sol"
                selectedOptionControls={controls}
                onSelectOptionControlValue={onSelectOptionControlValue}
                onSelect={() => {}}
            />
        );

        const screen = await renderScreen(element(nativeSelection, optionControls));
        // Single column: nothing but the wired handler can produce the grid.
        expect(screen.findByTestId(BODY_TEST_ID)?.props['aria-colcount']).toBe(1);
        expect(screen.findByTestId(BODY_TEST_ID)?.props.role).toBe('grid');
        expect(screen.findByTestId(CONTROLS_TEST_ID)).not.toBeNull();

        // Selecting a provider-connection model withdraws the CONTROLS — those
        // options do not exist for it — but the widget the user is standing in
        // may not change shape underneath them.
        await screen.update(element(providerSelection, optionControls));
        expect(screen.findByTestId(CONTROLS_TEST_ID)).toBeNull();
        expect(screen.findByTestId(BODY_TEST_ID)?.props.role).toBe('grid');

        // Same for a caller that withdraws the control set entirely.
        await screen.update(element(nativeSelection, undefined));
        expect(screen.findByTestId(CONTROLS_TEST_ID)).toBeNull();
        expect(screen.findByTestId(BODY_TEST_ID)?.props.role).toBe('grid');

        // …and back, without a pattern flip in either direction.
        await screen.update(element(nativeSelection, optionControls));
        expect(screen.findByTestId(BODY_TEST_ID)?.props.role).toBe('grid');
        expect(screen.findByTestId(CONTROLS_TEST_ID)).not.toBeNull();
    });

    it('keeps the plain listbox for a picker that wires no option controls at all', async () => {
        const { SessionModelPicker } = await import('./SessionModelPicker');
        const screen = await renderScreen(
            <SessionModelPicker
                agentTargetKey="backend:codex"
                nativeModels={[{ value: 'gpt-5.6-sol', label: '5.6 Sol' }]}
                providerGroups={[]}
                providerProjectionAuthoritative
                selected={nativeSelection}
                effectiveLabel="5.6 Sol"
                onSelect={() => {}}
            />,
        );
        expect(screen.findByTestId(BODY_TEST_ID)?.props.role).toBe('listbox');
    });
});
