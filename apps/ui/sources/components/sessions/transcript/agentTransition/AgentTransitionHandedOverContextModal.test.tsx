import { describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { t } from '@/text';

/**
 * A brief in the shape the seed builder actually produces: a framing sentence
 * outside every container, named containers around the recording, and a
 * replayed turn flattened to one line with its newline written out.
 *
 * @see packages/agents/src/sessions/replay/happierReplayPrompt.ts
 */
const SEED = [
    'Recording of past messages in this session, not a live turn.',
    '<session_context session_id="sess-1">',
    '- Original agent: Claude Code',
    '</session_context>',
    '',
    '<recent_transcript>',
    'User: fix the parser\\nit throws on empty input',
    '</recent_transcript>',
    '',
    'Continue from here.',
].join('\n');

/** Every distinct string the card actually put on screen, in render order. */
function renderedText(node: unknown): string[] {
    const collect = (current: unknown): string[] => {
        if (typeof current === 'string') return [current];
        if (Array.isArray(current)) return current.flatMap((child) => collect(child));
        if (current && typeof current === 'object' && 'children' in current) {
            return collect((current as { children?: unknown }).children);
        }
        return [];
    };
    return [...new Set(collect(node))];
}

const previewMock = vi.hoisted(() => ({ preview: vi.fn() }));

vi.mock('@/sync/ops/sessionAgentTransitionBriefPreview', () => ({
    previewSessionAgentTransitionBriefOnMachine: previewMock.preview,
}));

const { AgentTransitionHandedOverContextModal } = await import('./AgentTransitionHandedOverContextModal');

/**
 * The card claims to show what one Agent handed the next. Nothing was stored,
 * so every assertion here is about the card being TRUTHFUL about that: it says
 * it is a reconstruction, and it never turns an unreadable source into
 * "nothing was carried over".
 */
describe('Agent transition handed-over context card', () => {
    const BASE = {
        onClose: () => {},
        sessionId: 'sess-1',
        machineId: 'machine-1',
        serverId: 'server-1',
        onJumpToCutoff: null,
        sourceAgentId: 'claude',
        targetAgentId: 'codex',
    } as const;

    async function renderRebuilt(briefText: string) {
        previewMock.preview.mockResolvedValueOnce({
            status: 'answered',
            preview: { type: 'rebuilt', protocolVersion: 1, briefText },
        });
        const screen = await renderScreen(
            <AgentTransitionHandedOverContextModal {...BASE} sourceCutoffSeqInclusive={29_979} />,
        );
        await flushHookEffects();
        return screen;
    }

    it('always says the brief is rebuilt now rather than stored at the time', async () => {
        const screen = await renderRebuilt(SEED);

        expect(screen.findByTestId('agent-transition-handed-over-notice')?.props.children)
            .toBe(t('session.agentContinuation.handedOver.reconstructed'));
        expect(screen.findByTestId('agent-transition-handed-over-brief')).not.toBeNull();
    });

    /**
     * The seed's containers are how the framer tells the target Agent where the
     * recording starts and stops. Printed verbatim they are markup at a reader
     * who asked a plain question, so the card shows them as the structure they
     * are — and no tag text is left on screen.
     */
    it('shows the seed’s containers as sections instead of printing their tags', async () => {
        const screen = await renderRebuilt(SEED);

        const text = renderedText(screen.findByTestId('agent-transition-handed-over-brief'));
        expect(text.join('\u0000')).not.toContain('<session_context');
        expect(text.join('\u0000')).not.toContain('</recent_transcript>');
        expect(text).toContain('Session context');
        expect(text).toContain('Recent transcript');
        // The container's own attribute is a fact about the handoff, so it is
        // shown rather than swallowed with the tag that carried it.
        expect(text).toContain('session_id="sess-1"');
    });

    /**
     * A replayed turn is flattened to one line before it is sent, so a card that
     * prints it verbatim shows `\n` where the message had a line break. Reversing
     * that is exact — the producer doubles every backslash first — so it recovers
     * the message rather than rewriting it.
     */
    it('restores the line breaks the seed wrote out, and keeps every other byte', async () => {
        const screen = await renderRebuilt(SEED);

        const text = renderedText(screen.findByTestId('agent-transition-handed-over-brief'));
        expect(text).toContain('User: fix the parser\nit throws on empty input');
        expect(text).toContain('Recording of past messages in this session, not a live turn.');
        expect(text).toContain('- Original agent: Claude Code');
        expect(text).toContain('Continue from here.');
    });

    /** A brief this card cannot read structure in is still shown, verbatim. */
    it('falls back to the whole brief when it carries no containers', async () => {
        const screen = await renderRebuilt('plain brief, no containers');

        const text = renderedText(screen.findByTestId('agent-transition-handed-over-brief'));
        expect(text).toEqual(['plain brief, no containers']);
    });

    it('asks the machine for the divider’s own cutoff, not the Session head', async () => {
        previewMock.preview.mockClear();
        previewMock.preview.mockResolvedValueOnce({
            status: 'answered',
            preview: { type: 'empty', protocolVersion: 1 },
        });

        const screen = await renderScreen(
            <AgentTransitionHandedOverContextModal {...BASE} sourceCutoffSeqInclusive={1_234} />,
        );
        await flushHookEffects();

        expect(previewMock.preview).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'sess-1',
            machineId: 'machine-1',
            sourceCutoffSeqInclusive: 1_234,
            sourceAgentId: 'claude',
            targetAgentId: 'codex',
        }));
    });

    it('reports an empty source and an unreadable one as different facts', async () => {
        previewMock.preview.mockResolvedValueOnce({
            status: 'answered',
            preview: { type: 'empty', protocolVersion: 1 },
        });
        const emptyScreen = await renderScreen(
            // Cutoff `0` is the recorded fact that nothing crossed the boundary.
            <AgentTransitionHandedOverContextModal {...BASE} sourceCutoffSeqInclusive={0} />,
        );
        await flushHookEffects();
        expect(emptyScreen.findByTestId('agent-transition-handed-over-status')?.props.children)
            .toBe(t('session.agentContinuation.handedOver.empty'));

        previewMock.preview.mockResolvedValueOnce({
            status: 'answered',
            preview: { type: 'unavailable', reason: 'source_unreadable' },
        });
        const unreadableScreen = await renderScreen(
            <AgentTransitionHandedOverContextModal {...BASE} sourceCutoffSeqInclusive={7} />,
        );
        await flushHookEffects();
        expect(unreadableScreen.findByTestId('agent-transition-handed-over-status')?.props.children)
            .toBe(t('session.agentContinuation.handedOver.unavailableSource'));
    });

    it('does not claim nothing was carried when the rebuild simply cannot reach it any more', async () => {
        // The divider recorded a cutoff above zero, so context DID cross this
        // boundary. An empty rebuild today is retention or a rollback, not a
        // fact about the past.
        previewMock.preview.mockResolvedValueOnce({
            status: 'answered',
            preview: { type: 'empty', protocolVersion: 1 },
        });

        const screen = await renderScreen(
            <AgentTransitionHandedOverContextModal {...BASE} sourceCutoffSeqInclusive={7} />,
        );
        await flushHookEffects();

        expect(screen.findByTestId('agent-transition-handed-over-status')?.props.children)
            .toBe(t('session.agentContinuation.handedOver.notRebuildable'));
    });

    it('keeps the rebuild status in one polite live region so the answer is announced', async () => {
        previewMock.preview.mockResolvedValueOnce({
            status: 'answered',
            preview: { type: 'unavailable', reason: 'source_unreadable' },
        });

        const screen = await renderScreen(
            <AgentTransitionHandedOverContextModal {...BASE} sourceCutoffSeqInclusive={7} />,
        );
        await flushHookEffects();

        const region = screen.findByTestId('agent-transition-handed-over-status-region');
        expect(region?.props.accessibilityLiveRegion).toBe('polite');
        expect(region?.props['aria-live']).toBe('polite');
        expect(screen.findByTestId('agent-transition-handed-over-status')?.props.children)
            .toBe(t('session.agentContinuation.handedOver.unavailableSource'));
    });

    it('never turns a failed call into “nothing was carried over”', async () => {
        previewMock.preview.mockResolvedValueOnce({ status: 'indeterminate' });

        const screen = await renderScreen(
            <AgentTransitionHandedOverContextModal {...BASE} sourceCutoffSeqInclusive={7} />,
        );
        await flushHookEffects();

        expect(screen.findByTestId('agent-transition-handed-over-status')?.props.children)
            .toBe(t('session.agentContinuation.handedOver.unreachable'));
        expect(screen.findByTestId('agent-transition-handed-over-retry')).not.toBeNull();
    });

    it('does not reach for a machine it does not have', async () => {
        previewMock.preview.mockClear();

        const screen = await renderScreen(
            <AgentTransitionHandedOverContextModal
                {...BASE}
                machineId={null}
                sourceCutoffSeqInclusive={7}
            />,
        );
        await flushHookEffects();

        expect(previewMock.preview).not.toHaveBeenCalled();
        expect(screen.findByTestId('agent-transition-handed-over-status')?.props.children)
            .toBe(t('session.agentContinuation.handedOver.unreachable'));
    });

    it('offers the jump only when the caller supplied one, and closes behind it', async () => {
        previewMock.preview.mockResolvedValueOnce({
            status: 'answered',
            preview: { type: 'rebuilt', protocolVersion: 1, briefText: SEED },
        });
        const jump = vi.fn();
        const close = vi.fn();

        const screen = await renderScreen(
            <AgentTransitionHandedOverContextModal
                {...BASE}
                onClose={close}
                onJumpToCutoff={jump}
                sourceCutoffSeqInclusive={29_979}
            />,
        );
        await flushHookEffects();

        screen.pressByTestId('agent-transition-handed-over-jump');
        expect(jump).toHaveBeenCalledTimes(1);
        expect(close).toHaveBeenCalledTimes(1);
    });
});
