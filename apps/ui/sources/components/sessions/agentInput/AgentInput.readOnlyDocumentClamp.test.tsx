import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';

installAgentInputCommonModuleMocks();
const runtime = installSessionPaneRuntimeTestHarness();

/** A built-in's long engineering prompt, kept byte for byte (DESIGN-4 M4). */
const LONG_PROMPT = Array.from({ length: 15 }, (_, line) => `Line ${line + 1} of the verify-and-fix instructions.`).join('\n');

async function renderReadOnly(panelPresentation?: 'document') {
    const { AgentInput } = await import('./AgentInput');
    return renderScreen(
        <AgentInput
            value={LONG_PROMPT}
            placeholder="p"
            autocompleteKinds={[]}
            autocompleteSuggestions={async () => []}
            disabled
            showAbortButton={false}
            {...(panelPresentation === undefined ? {} : { panelPresentation })}
        />,
        { wrapper: runtime.Wrapper },
    );
}

const layout = (height: number) => ({ nativeEvent: { layout: { x: 0, y: 0, width: 400, height } } });

const flat = (style: unknown): Record<string, unknown> => Array.isArray(style)
    ? style.reduce<Record<string, unknown>>((all, entry) => ({ ...all, ...flat(entry) }), {})
    : (style && typeof style === 'object' ? style as Record<string, unknown> : {});

describe('AgentInput read-only document clamp', () => {
    it('clamps a long reading-document prompt to three whole lines, no ellipsis, with More / Less on its last line', async () => {
        const screen = await renderReadOnly('document');
        const frame = () => screen.findHostByTestId('agent-input-read-only-frame')!;
        const text = () => screen.findHostByTestId('agent-input-read-only-text')!;
        // The prompt is whole (never shortened) and never ellipsized after its period.
        expect(text().props.children).toBe(LONG_PROMPT);
        expect(text().props.numberOfLines).toBeUndefined();
        // Nothing hidden yet is known: no toggle until the full layout is taller than three lines.
        expect(screen.findHostByTestId('agent-input-read-only-toggle')).toBeNull();
        await act(async () => {
            screen.findHostByTestId('agent-input-read-only-line')!.props.onLayout(layout(22));
            screen.findHostByTestId('agent-input-read-only-measure')!.props.onLayout(layout(330));
        });
        expect(flat(frame().props.style).maxHeight).toBe(66);
        // The toggle shares the clamped text's row, at its last line.
        const toggle = screen.findHostByTestId('agent-input-read-only-toggle')!;
        let shared = toggle.parent;
        while (shared !== null && shared.findAll((node) => node.props?.testID === 'agent-input-read-only-frame').length === 0) shared = shared.parent;
        expect(flat(shared?.props.style).flexDirection).toBe('row');
        const moreLabel = toggle.props.accessibilityLabel;
        await screen.pressByTestIdAsync('agent-input-read-only-toggle');
        expect(flat(frame().props.style).maxHeight).toBeUndefined();
        expect(screen.findHostByTestId('agent-input-read-only-toggle')?.props.accessibilityLabel).not.toBe(moreLabel);
        await screen.pressByTestIdAsync('agent-input-read-only-toggle');
        expect(flat(frame().props.style).maxHeight).toBe(66);
    });

    it('never clamps to zero: an unmeasurable line shows the prompt whole, and the probe is a real glyph (DESIGN-6 N13)', async () => {
        const screen = await renderReadOnly('document');
        const probe = screen.findHostByTestId('agent-input-read-only-line')!;
        // react-native-web lays a whitespace-only line out at 0 px; the probe must carry a glyph.
        expect(String(probe.props.children).trim().length).toBeGreaterThan(0);
        await act(async () => {
            probe.props.onLayout(layout(0));
            screen.findHostByTestId('agent-input-read-only-measure')!.props.onLayout(layout(352));
        });
        const frame = flat(screen.findHostByTestId('agent-input-read-only-frame')!.props.style);
        expect(frame.maxHeight === undefined || (typeof frame.maxHeight === 'number' && frame.maxHeight > 0)).toBe(true);
        expect(frame.maxHeight).not.toBe(0);
    });

    it('shows a short prompt whole with no toggle', async () => {
        const screen = await renderReadOnly('document');
        await act(async () => {
            screen.findHostByTestId('agent-input-read-only-line')!.props.onLayout(layout(22));
            screen.findHostByTestId('agent-input-read-only-measure')!.props.onLayout(layout(44));
        });
        expect(screen.findHostByTestId('agent-input-read-only-toggle')).toBeNull();
        expect(flat(screen.findHostByTestId('agent-input-read-only-frame')!.props.style).maxHeight).toBeUndefined();
    });

    it('leaves a read-only session composer unclamped', async () => {
        const screen = await renderReadOnly();
        expect(screen.findHostByTestId('agent-input-read-only-text')).toBeNull();
        const whole = screen.findAll((node) => String(node.type) === 'Text' && node.props?.children === LONG_PROMPT);
        expect(whole.length).toBeGreaterThan(0);
        expect(whole.every((node) => node.props.numberOfLines === undefined)).toBe(true);
    });
});
