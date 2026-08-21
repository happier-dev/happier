import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { t } from '@/text';
import type { AgentEvent } from '@/sync/typesRaw';

import { TranscriptEventRow } from '@/components/sessions/transcript/events/TranscriptEventRow';

const MARK_TEST_ID_PREFIX = 'transcript-agent-transition-divider-mark-';
const DIVIDER_LOCAL_ID = 'agent-transition:local-1';

/**
 * The divider's label, read the way it is laid out: every word in order, with
 * `mark:<agentId>` standing in for an Agent's logo wherever one is drawn.
 *
 * Reading the run rather than a single string is the point — the request is
 * about WHERE each mark sits, and a rendered-text snapshot cannot tell a logo
 * beside the right name from a logo beside the wrong one.
 */
function titleRun(node: unknown): string[] {
    if (typeof node === 'string') return [node];
    if (Array.isArray(node)) return node.flatMap((child) => titleRun(child));
    if (!node || typeof node !== 'object') return [];
    const instance = node as { props?: Record<string, unknown>; children?: unknown };
    const testID = instance.props?.testID;
    if (typeof testID === 'string' && testID.startsWith(MARK_TEST_ID_PREFIX)) {
        return [`mark:${testID.slice(MARK_TEST_ID_PREFIX.length)}`];
    }
    return titleRun(instance.children);
}

// Genuine boundaries in the Node test runtime: the mark resolves bundled image
// and SVG assets this runtime cannot load, and the registry module that carries
// its per-Agent optical scale loads them with it. The row's own layout — which
// mark sits against which name — runs for real underneath both.
vi.mock('@/agents/registry/AgentIcon', () => ({
    AgentIcon: (props: Record<string, unknown>) => React.createElement('AgentIcon', props),
}));

vi.mock('@/agents/registry/registryUi', () => ({
    getAgentPickerIconScale: () => 1,
}));

vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
    createDefaultActionExecutor: () => ({ execute: vi.fn() }),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
    resolveServerIdForSessionIdFromLocalCache: () => 'server-1',
    resolvePreferredServerIdForSessionId: () => 'server-1',
}));

type ShownHandedOverContextModal = Readonly<{
    props: Readonly<{
        sessionId: string;
        sourceCutoffSeqInclusive: number;
        returningAgentLastSeenSeqInclusive: number | null;
        onJumpToCutoff: unknown;
    }>;
}>;

const modalMock = vi.hoisted(() => ({
    show: vi.fn((_config: unknown) => 'modal-id'),
}));

function shownModals(): readonly ShownHandedOverContextModal[] {
    return modalMock.show.mock.calls.map(([config]) => config as ShownHandedOverContextModal);
}

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { show: modalMock.show } }).module;
});

/**
 * The divider is written as an ordinary informational message so that a reader
 * predating the feature still shows something truthful. A reader that knows the
 * sidecar must not settle for that: the row marks where the Session changed
 * Agent, and the transcript renders boundaries as separators.
 *
 * It is also the only place a reader can ask what crossed the boundary, so the
 * chip opens the handed-over context card.
 */
describe('Agent transition divider', () => {
    function dividerEvent(sidecar: unknown): AgentEvent {
        return {
            type: 'message',
            message: 'Continued with another Agent.',
            sessionAgentTransitionV1: sidecar,
        } as unknown as AgentEvent;
    }

    const CLAUDE = t('agentInput.agent.claude');
    const CODEX = t('agentInput.agent.codex');

    function sentence(from: string, to: string): string {
        return t('session.agentContinuation.dividerTitle', { from, to });
    }

    it('renders the boundary as a separator naming both Agents, not as an informational row', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow localId={DIVIDER_LOCAL_ID} event={dividerEvent({ v: 1, fromAgentId: 'claude', toAgentId: 'codex', sourceCutoffSeqInclusive: 29_979 })} />,
        );

        expect(screen.findByTestId('transcript-agent-transition-divider')).not.toBeNull();
        const run = titleRun(screen.findByTestId('transcript-agent-transition-divider-title'));
        expect(run.filter((token) => !token.startsWith('mark:')).join(' ')).toBe(sentence(CLAUDE, CODEX));
        // The stored prose exists only for old readers and must not also appear.
        expect(JSON.stringify(screen.tree.toJSON())).not.toContain('Continued with another Agent.');
    });

    /**
     * The boundary is between two Agents, and an Agent is recognised by its mark
     * long before its name is read. Each mark therefore belongs to the name it
     * introduces — not collected at one end of the sentence, where the reader
     * would have to work out which logo went with which Agent.
     */
    it('sets each Agent’s logo immediately before that Agent’s name', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow localId={DIVIDER_LOCAL_ID} event={dividerEvent({ v: 1, fromAgentId: 'claude', toAgentId: 'codex', sourceCutoffSeqInclusive: 29_979 })} />,
        );

        const run = titleRun(screen.findByTestId('transcript-agent-transition-divider-title'));
        expect(run[run.indexOf(CLAUDE) - 1]).toBe('mark:claude');
        expect(run[run.indexOf(CODEX) - 1]).toBe('mark:codex');
        // Order follows the sentence, so the source Agent's mark comes first.
        expect(run.filter((token) => token.startsWith('mark:'))).toEqual(['mark:claude', 'mark:codex']);
    });

    it('still names an Agent the catalog no longer knows, rather than dropping it', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow localId={DIVIDER_LOCAL_ID} event={dividerEvent({ v: 1, fromAgentId: 'claude', toAgentId: 'retired-agent', sourceCutoffSeqInclusive: 12 })} />,
        );

        const run = titleRun(screen.findByTestId('transcript-agent-transition-divider-title'));
        expect(run.filter((token) => !token.startsWith('mark:')).join(' '))
            .toBe(sentence(CLAUDE, 'retired-agent'));
        // No mark to draw and none invented: the name still carries the boundary.
        expect(run.filter((token) => token.startsWith('mark:'))).toEqual(['mark:claude']);
    });

    /**
     * A screen reader gets no marks and no segmentation, so the chip has to
     * carry the whole sentence as one accessible name however the label is
     * laid out.
     */
    it('keeps the whole sentence as the chip’s accessible name', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow localId={DIVIDER_LOCAL_ID} event={dividerEvent({ v: 1, fromAgentId: 'claude', toAgentId: 'codex', sourceCutoffSeqInclusive: 29_979 })} />,
        );

        expect(screen.findByTestId('transcript-agent-transition-divider-chip')?.props.accessibilityLabel)
            .toContain(sentence(CLAUDE, CODEX));
    });

    it('leaves an ordinary informational message on the generic arm', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow event={{ type: 'message', message: 'Just a note.' } as unknown as AgentEvent} />,
        );

        expect(screen.findByTestId('transcript-agent-transition-divider')).toBeNull();
    });

    it('does not trust a valid divider sidecar on an ordinary localId', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow
                localId="ordinary-local-id"
                event={dividerEvent({
                    v: 1,
                    fromAgentId: 'claude',
                    toAgentId: 'codex',
                    sourceCutoffSeqInclusive: 29_979,
                })}
            />,
        );

        expect(screen.findByTestId('transcript-agent-transition-divider')).toBeNull();
    });

    it('refuses a malformed sidecar instead of rendering a half-named boundary', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow localId={DIVIDER_LOCAL_ID} event={dividerEvent({ v: 1, fromAgentId: 'claude' })} />,
        );

        expect(screen.findByTestId('transcript-agent-transition-divider')).toBeNull();
    });

    /**
     * The seed text is blanked the instant the target accepts it, so the only
     * place the reader can still ask "what did the new Agent actually get?" is
     * this boundary. The chip must therefore be a control, and its accessible
     * name has to say so — a screen reader gets no caret.
     */
    it('opens the handed-over context card, carrying the recorded cutoff', async () => {
        modalMock.show.mockClear();
        const screen = await renderScreen(
            <TranscriptEventRow
                sessionId="sess-1"
                localId={DIVIDER_LOCAL_ID}
                event={dividerEvent({
                    v: 1,
                    fromAgentId: 'claude',
                    toAgentId: 'codex',
                    sourceCutoffSeqInclusive: 29_979,
                })}
            />,
        );

        const chip = screen.findByTestId('transcript-agent-transition-divider-chip');
        expect(chip?.props.accessibilityRole).toBe('button');
        expect(chip?.props.accessibilityLabel)
            .toContain(t('session.agentContinuation.handedOver.open'));

        screen.pressByTestId('transcript-agent-transition-divider-chip');

        expect(modalMock.show).toHaveBeenCalledTimes(1);
        const shown = shownModals()[0];
        expect(shown?.props.sessionId).toBe('sess-1');
        expect(shown?.props.sourceCutoffSeqInclusive).toBe(29_979);
        // A fresh-target boundary had no lower bound, and none is invented.
        expect(shown?.props.returningAgentLastSeenSeqInclusive).toBeNull();
        expect(typeof shown?.props.onJumpToCutoff).toBe('function');
    });

    /**
     * A NATIVE RETURN handed over only the away-delta, and the divider is the
     * only surviving record of the bound that produced it — the device-local
     * departure record it came from is overwritten by the next departure. If the
     * row drops it here, the card rebuilds the FULL prefix and shows the reader
     * more than was actually handed over.
     */
    it('carries a native return’s recorded delta bound through to the card', async () => {
        modalMock.show.mockClear();
        const screen = await renderScreen(
            <TranscriptEventRow
                sessionId="sess-1"
                localId={DIVIDER_LOCAL_ID}
                event={dividerEvent({
                    v: 1,
                    fromAgentId: 'codex',
                    toAgentId: 'claude',
                    sourceCutoffSeqInclusive: 29_979,
                    returningAgentLastSeenSeqInclusive: 29_130,
                })}
            />,
        );
        screen.pressByTestId('transcript-agent-transition-divider-chip');

        const shown = shownModals()[0];
        expect(shown?.props.returningAgentLastSeenSeqInclusive).toBe(29_130);
        expect(shown?.props.sourceCutoffSeqInclusive).toBe(29_979);
    });

    /**
     * `0` is a recorded cutoff meaning "nothing was carried over" — a fact, not
     * an absence — so it must survive to the card, which says a different
     * sentence for it. It offers no jump: there is no earlier message to land on.
     */
    it('carries a recorded empty cutoff through as a fact, with no jump', async () => {
        modalMock.show.mockClear();
        const emptyScreen = await renderScreen(
            <TranscriptEventRow
                sessionId="sess-1"
                localId={DIVIDER_LOCAL_ID}
                event={dividerEvent({
                    v: 1,
                    fromAgentId: 'claude',
                    toAgentId: 'codex',
                    sourceCutoffSeqInclusive: 0,
                })}
            />,
        );
        emptyScreen.pressByTestId('transcript-agent-transition-divider-chip');

        const props = shownModals().map((shown) => shown.props);
        expect(props[0]?.sourceCutoffSeqInclusive).toBe(0);
        expect(props[0]?.onJumpToCutoff).toBeNull();
    });

    it('stays an inert boundary where the host renders the event without Session context', async () => {
        // Without a Session there is nothing to rebuild against, and a chip that
        // opens a card which can only fail is worse than no chip.
        const screen = await renderScreen(
            <TranscriptEventRow localId={DIVIDER_LOCAL_ID} event={dividerEvent({ v: 1, fromAgentId: 'claude', toAgentId: 'codex', sourceCutoffSeqInclusive: 29_979 })} />,
        );

        expect(screen.findByTestId('transcript-agent-transition-divider-chip')?.props.accessibilityRole)
            .not.toBe('button');
    });
});
