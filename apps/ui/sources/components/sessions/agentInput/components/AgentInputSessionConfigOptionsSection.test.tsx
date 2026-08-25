import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { SessionConfigOptionInput } from '@/sync/domains/sessionControl/configOptionsControl';
import { lightTheme } from '@/theme';

import { installAgentInputCommonModuleMocks } from '../agentInputTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installAgentInputCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key, params) => (params
                ? `${key}(${Object.entries(params).map(([name, value]) => `${name}=${String(value)}`).join(',')})`
                : key),
        });
    },
});

vi.mock('@/components/ui/text/Text', async () => {
    const { createUiTextModuleMock } = await import('@/dev/testkit/mocks/uiText');
    return createUiTextModuleMock();
});

vi.mock('@/components/ui/forms/Switch', async () => {
    const { createPassThroughModule } = await import('@/dev/testkit/mocks/components');
    return createPassThroughModule(['Switch']);
});

/**
 * The section renders whatever the config-option derivation hands it, so the tests drive the real
 * `computeSessionConfigOptionControlsForProvider` rather than hand-writing controls: a literal
 * could carry an `overriddenEffectiveValue` production never produces (one the option cannot even
 * render), which is exactly the case the rendering rule exists to survive.
 */
const EFFORT_OPTION = {
    id: 'reasoning_effort',
    name: 'Thinking',
    description: 'How hard the model thinks.',
    type: 'select',
    currentValue: 'low',
    options: [
        { value: 'low', name: 'Low' },
        { value: 'high', name: 'High' },
        { value: 'xhigh', name: 'XHigh' },
    ],
} as const;

/** Claude's ultracode: while on, the agent really runs reasoning_effort at xhigh. */
const ULTRACODE_OPTION = {
    id: 'ultracode',
    name: 'Ultracode',
    type: 'boolean',
    currentValue: 'false',
    overridesWhenOn: { optionIds: ['reasoning_effort'], forcedValue: 'xhigh' },
} as const;

type RenderedScreen = Awaited<ReturnType<typeof renderScreen>>;

function flattenStyle(style: unknown): Record<string, unknown> {
    if (typeof style === 'function') {
        return flattenStyle((style as (state: Readonly<{ pressed: boolean; hovered: boolean; focused: boolean }>) => unknown)({
            pressed: false,
            hovered: false,
            focused: false,
        }));
    }
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>((acc, entry) => ({ ...acc, ...flattenStyle(entry) }), {});
    }
    return (style ?? {}) as Record<string, unknown>;
}

async function buildControls(params: Readonly<{
    configOptions: ReadonlyArray<SessionConfigOptionInput>;
    ultracodeOn: boolean;
}>) {
    const { computeSessionConfigOptionControlsForProvider } = await import('@/sync/domains/sessionControl/configOptionsControl');
    const controls = computeSessionConfigOptionControlsForProvider({
        providerId: 'claude',
        configOptions: params.configOptions,
        overrides: params.ultracodeOn ? { ultracode: { value: 'true' } } : null,
    });
    expect(controls).not.toBeNull();
    return controls!;
}

async function renderSection(params: Readonly<{
    configOptions: ReadonlyArray<SessionConfigOptionInput>;
    ultracodeOn: boolean;
    onSelectValue?: (configId: string, valueId: string) => void;
}>) {
    const [{ AgentInputSessionConfigOptionsSection }, controls] = await Promise.all([
        import('./AgentInputSessionConfigOptionsSection'),
        buildControls({ configOptions: params.configOptions, ultracodeOn: params.ultracodeOn }),
    ]);

    return renderScreen(
        <AgentInputSessionConfigOptionsSection
            controls={controls}
            onSelectValue={params.onSelectValue}
        />,
    );
}

function requireChoice(screen: RenderedScreen, optionId: string, value: string) {
    const testID = `agent-input-config-option-option:${JSON.stringify([optionId, value])}`;
    const pill = screen.findByTestId(testID);
    expect(pill, `expected a choice pill for ${optionId}/${value}`).toBeTruthy();
    return pill!;
}

/**
 * The pill's highlight is carried by the active-radio border plus the primary label colour; an
 * unhighlighted pill keeps the default border and the secondary label colour.
 */
function isChoiceHighlighted(screen: RenderedScreen, optionId: string, value: string): boolean {
    const pill = requireChoice(screen, optionId, value);
    const pillStyle = flattenStyle(pill.props.style);
    const labelStyle = flattenStyle(pill.findByType('Text' as never).props.style);
    const borderHighlighted = pillStyle.borderColor === lightTheme.colors.radio.active;
    const labelHighlighted = labelStyle.color === lightTheme.colors.text.primary;
    expect(
        borderHighlighted,
        `pill border and label disagree about highlight for ${optionId}/${value}`,
    ).toBe(labelHighlighted);
    return borderHighlighted;
}

function highlightedChoices(screen: RenderedScreen, optionId: string, values: readonly string[]): string[] {
    return values.filter((value) => isChoiceHighlighted(screen, optionId, value));
}

function isCardDimmed(screen: RenderedScreen, optionId: string): boolean {
    const card = screen.findByTestId(`agent-input-config-option:${optionId}`);
    expect(card).toBeTruthy();
    return flattenStyle(card!.props.style).opacity === 0.5;
}

describe('AgentInputSessionConfigOptionsSection', () => {
    it('highlights the stored value and stays interactive while nothing overrides it', async () => {
        const onSelectValue = vi.fn();
        const screen = await renderSection({
            configOptions: [EFFORT_OPTION, ULTRACODE_OPTION],
            ultracodeOn: false,
            onSelectValue,
        });

        expect(highlightedChoices(screen, 'reasoning_effort', ['low', 'high', 'xhigh'])).toEqual(['low']);
        expect(isCardDimmed(screen, 'reasoning_effort')).toBe(false);
        expect(screen.findByTestId('agent-input-config-option-overridden:reasoning_effort')).toBeNull();

        for (const value of ['low', 'high', 'xhigh'] as const) {
            expect(requireChoice(screen, 'reasoning_effort', value).props.disabled).not.toBe(true);
        }

        await screen.pressByTestIdAsync(`agent-input-config-option-option:${JSON.stringify(['reasoning_effort', 'high'])}`);
        expect(onSelectValue).toHaveBeenCalledWith('reasoning_effort', 'high');
    });

    // The section used to highlight the stored value even while overridden, so the row claimed the
    // agent was thinking at `low` while ultracode actually ran it at `xhigh`.
    it('highlights the forced running value, dims, and refuses interaction while overridden', async () => {
        const screen = await renderSection({
            configOptions: [EFFORT_OPTION, ULTRACODE_OPTION],
            ultracodeOn: true,
            onSelectValue: vi.fn(),
        });

        // The value the agent is ACTUALLY running — not the stored intent.
        expect(highlightedChoices(screen, 'reasoning_effort', ['low', 'high', 'xhigh'])).toEqual(['xhigh']);
        expect(isCardDimmed(screen, 'reasoning_effort')).toBe(true);

        for (const value of ['low', 'high', 'xhigh'] as const) {
            expect(requireChoice(screen, 'reasoning_effort', value).props.disabled).toBe(true);
        }

        // …and the row says which option took control.
        const overriddenNote = screen.findByTestId('agent-input-config-option-overridden:reasoning_effort');
        expect(overriddenNote?.props.children).toBe('agentInput.acp.optionOverriddenBy(name=Ultracode)');

        // The overriding toggle itself stays live.
        const ultracodeRow = screen.find((node) => (
            typeof node.props?.onValueChange === 'function'
            && Object.prototype.hasOwnProperty.call(node.props, 'value')
        ));
        expect(ultracodeRow.props.disabled).not.toBe(true);
    });

    // The option name sits beside the switch as plain text, which names nothing: an adjacent label
    // is not a programmatic one, so the control announced as a bare "switch, on".
    it('announces a boolean option switch by the option name', async () => {
        const screen = await renderSection({
            configOptions: [EFFORT_OPTION, ULTRACODE_OPTION],
            ultracodeOn: false,
            onSelectValue: vi.fn(),
        });

        const switchHosts = screen.findAll((node) => String(node.type) === 'Switch');
        expect(switchHosts).toHaveLength(1);
        expect(switchHosts[0]!.props.accessibilityLabel).toBe('Ultracode');
    });

    // A model whose choice set has no `xhigh` must not point at a segment that does not exist.
    it('dims without highlighting any segment when the forced value is not one of the choices', async () => {
        const screen = await renderSection({
            configOptions: [
                { ...EFFORT_OPTION, options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
                ULTRACODE_OPTION,
            ],
            ultracodeOn: true,
            onSelectValue: vi.fn(),
        });

        expect(highlightedChoices(screen, 'reasoning_effort', ['low', 'high'])).toEqual([]);
        expect(isCardDimmed(screen, 'reasoning_effort')).toBe(true);
        expect(screen.findByTestId('agent-input-config-option-overridden:reasoning_effort')).toBeTruthy();
    });

    // The override is a display channel only: the stored intent it hid must come straight back.
    it('returns the highlight to the stored value once the override lifts', async () => {
        const overridden = await renderSection({
            configOptions: [EFFORT_OPTION, ULTRACODE_OPTION],
            ultracodeOn: true,
            onSelectValue: vi.fn(),
        });
        expect(highlightedChoices(overridden, 'reasoning_effort', ['low', 'high', 'xhigh'])).toEqual(['xhigh']);

        const restored = await renderSection({
            configOptions: [EFFORT_OPTION, ULTRACODE_OPTION],
            ultracodeOn: false,
            onSelectValue: vi.fn(),
        });
        expect(highlightedChoices(restored, 'reasoning_effort', ['low', 'high', 'xhigh'])).toEqual(['low']);
        expect(isCardDimmed(restored, 'reasoning_effort')).toBe(false);
    });
});
