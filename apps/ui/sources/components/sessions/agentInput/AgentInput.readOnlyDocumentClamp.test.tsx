import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';
import type { AgentInputExtraActionChip } from './agentInputContracts';

installAgentInputCommonModuleMocks();
vi.mock('@/components/ui/popover', async (importOriginal) =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));
installDisconnectedServerSocketBoundary();
const { installSessionPaneRuntimeTestHarness } = await import('@/components/sessions/panes/sessionPaneRuntimeTestHarness');
const runtime = installSessionPaneRuntimeTestHarness();

/** A built-in's long engineering prompt, kept byte for byte (DESIGN-4 M4). */
const LONG_PROMPT = Array.from({ length: 15 }, (_, line) => `Line ${line + 1} of the verify-and-fix instructions.`).join('\n');

async function renderReadOnly(panelPresentation?: 'document', props: Partial<React.ComponentProps<typeof import('./AgentInput').AgentInput>> = {}) {
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
            {...props}
        />,
        { wrapper: runtime.Wrapper },
    );
}

const layout = (height: number) => ({ nativeEvent: { layout: { x: 0, y: 0, width: 400, height } } });

const flat = (style: unknown): Record<string, unknown> => Array.isArray(style)
    ? style.reduce<Record<string, unknown>>((all, entry) => ({ ...all, ...flat(entry) }), {})
    : (style && typeof style === 'object' ? style as Record<string, unknown> : {});

describe('AgentInput read-only document clamp', () => {
    it.each([false, true])('keeps an overflow engine informational on a reading card with editing callback supplied: %s', async (supplyEditingCallback) => {
        const onAgentClick = vi.fn();
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        getStorage().getState().applyLocalSettings({ navigationSurfacePlacementsV1: { composer: {
            orderedIds: [], placements: { engine: 'overflow' },
        } } });
        const screen = await renderReadOnly('document', {
            agentType: 'codex', engineLabel: 'Current model',
            ...(supplyEditingCallback ? { onAgentClick } : {}),
        });
        expect(screen.findHostByTestId('agent-input-agent-chip')).toBeNull();
        await screen.pressByTestIdAsync('agent-input-action-menu-button');
        expect(screen.getTextContent()).toContain('Current model');
        const { SelectableRow } = await import('@/components/ui/lists/SelectableRow');
        const engineRow = screen.findAllByType(SelectableRow).find((row) => row.props.subtitle === 'Current model');
        expect(engineRow?.props.disabled).toBe(true);
        expect(engineRow?.props.onPress).toBeUndefined();
        expect(onAgentClick).not.toHaveBeenCalled();
    });

    it('uses saved individual control order and omits hidden controls on a reading card', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        getStorage().getState().applyLocalSettings({ navigationSurfacePlacementsV1: { composer: {
            orderedIds: ['shortcuts:second', 'engine', 'shortcuts:first', 'shortcuts:hidden'],
            placements: { 'shortcuts:first': 'pinned', 'shortcuts:second': 'pinned', 'shortcuts:hidden': 'hidden' },
        } } });
        const screen = await renderReadOnly('document', {
            agentType: 'codex', engineLabel: 'Engine',
            extraActionChips: ['first', 'hidden', 'second'].map((key) => ({
                key, controlId: 'shortcuts', placement: { id: `shortcuts:${key}`, title: key, defaultPlacement: 'pinned' },
                render: () => React.createElement('Pressable', { testID: `reading-${key}` }),
            } satisfies AgentInputExtraActionChip)),
        });
        const ids = ['reading-first', 'reading-second', 'reading-hidden', 'agent-input-agent-chip'];
        const controls = screen.findAll((node) => typeof node.type === 'string' && ids.includes(node.props.testID));
        expect(controls.map((node) => node.props.testID)).toEqual(['reading-second', 'agent-input-agent-chip', 'reading-first']);
    });

    it('keeps a reading card\'s default overflow control reachable through the shared action menu', async () => {
        const onOpen = vi.fn();
        const screen = await renderReadOnly('document', {
            extraActionChips: [{
                key: 'workflow-step-options', controlId: 'shortcuts',
                placement: { id: 'shortcuts:workflow-step-options', title: 'Step options', defaultPlacement: 'overflow' },
                render: () => null,
                collapsedAction: ({ dismiss }) => ({
                    id: 'workflow-step-options', testID: 'reading-step-options', label: 'Step options',
                    onPress: () => { dismiss(); onOpen(); },
                }),
            }],
        });
        expect(screen.findHostByTestId('agent-input-action-menu-button')).not.toBeNull();
        expect(onOpen).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('agent-input-action-menu-button');
        expect(screen.findHostByTestId('agent-input-action-menu-customize')).toBeNull();
        await screen.pressByTestIdAsync('reading-step-options');
        expect(onOpen).toHaveBeenCalledOnce();
    });

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

    it('reads a placed reference as its inline chip inside the prompt, never as a separate line', async () => {
        const { buildMentionRefV1 } = await import('@happier-dev/protocol/runtime/input/mentionRefV1');
        const { formatInlineReferenceTokenV1 } = await import('@happier-dev/protocol/runtime/input/inlineReferenceTokenV1');
        const ref = buildMentionRefV1('session', 'release-notes');
        const tokenText = formatInlineReferenceTokenV1({ label: 'Release notes', ref });
        const value = `Compare with ${tokenText} before answering`;
        const start = 'Compare with '.length;
        const screen = await renderReadOnly('document', { value, structuredInputMentions: [
            { kind: 'session', ref, label: 'Release notes', tokenText, start, end: start + tokenText.length },
        ] });
        const whole = screen.getTextContent();
        // One sentence: the chip label sits between the words around its token, and the raw token is gone.
        expect(whole.indexOf('Compare with')).toBeLessThan(whole.indexOf('Release notes'));
        expect(whole.indexOf('Release notes')).toBeLessThan(whole.indexOf('before answering'));
        expect(whole.includes(tokenText)).toBe(false);
        expect(whole.split('Release notes').length - 1).toBe(2); // the reading and its hidden clamp measure, never a third line
    });

    it('leaves a read-only session composer unclamped', async () => {
        const screen = await renderReadOnly();
        expect(screen.findHostByTestId('agent-input-read-only-text')).toBeNull();
        const whole = screen.findAll((node) => String(node.type) === 'Text' && node.props?.children === LONG_PROMPT);
        expect(whole.length).toBeGreaterThan(0);
        expect(whole.every((node) => node.props.numberOfLines === undefined)).toBe(true);
    });
});
