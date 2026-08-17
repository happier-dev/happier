import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { t } from '@/text';
import type { AgentEvent } from '@/sync/typesRaw';

import { TranscriptEventRow } from '@/components/sessions/transcript/events/TranscriptEventRow';

vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
    createDefaultActionExecutor: () => ({ execute: vi.fn() }),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
    resolveServerIdForSessionIdFromLocalCache: () => 'server-1',
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

/**
 * The divider is written as an ordinary informational message so that a reader
 * predating the feature still shows something truthful. A reader that knows the
 * sidecar must not settle for that: the row marks where the Session changed
 * Agent, and the transcript renders boundaries as separators.
 */
describe('Agent transition divider', () => {
    function dividerEvent(sidecar: unknown): AgentEvent {
        return {
            type: 'message',
            message: 'Continued with another Agent.',
            sessionAgentTransitionV1: sidecar,
        } as unknown as AgentEvent;
    }

    it('renders the boundary as a separator naming both Agents, not as an informational row', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow event={dividerEvent({ v: 1, fromAgentId: 'claude', toAgentId: 'codex' })} />,
        );

        expect(screen.findByTestId('transcript-agent-transition-divider')).not.toBeNull();
        expect(screen.findByTestId('transcript-agent-transition-divider-title')?.props.children)
            .toBe(t('session.agentContinuation.dividerTitle', {
                from: t('agentInput.agent.claude'),
                to: t('agentInput.agent.codex'),
            }));
        // The stored prose exists only for old readers and must not also appear.
        expect(JSON.stringify(screen.tree.toJSON())).not.toContain('Continued with another Agent.');
    });

    it('still names an Agent the catalog no longer knows, rather than dropping it', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow event={dividerEvent({ v: 1, fromAgentId: 'claude', toAgentId: 'retired-agent' })} />,
        );

        expect(screen.findByTestId('transcript-agent-transition-divider-title')?.props.children)
            .toBe(t('session.agentContinuation.dividerTitle', {
                from: t('agentInput.agent.claude'),
                to: 'retired-agent',
            }));
    });

    it('leaves an ordinary informational message on the generic arm', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow event={{ type: 'message', message: 'Just a note.' } as unknown as AgentEvent} />,
        );

        expect(screen.findByTestId('transcript-agent-transition-divider')).toBeNull();
    });

    it('refuses a malformed sidecar instead of rendering a half-named boundary', async () => {
        const screen = await renderScreen(
            <TranscriptEventRow event={dividerEvent({ v: 1, fromAgentId: 'claude' })} />,
        );

        expect(screen.findByTestId('transcript-agent-transition-divider')).toBeNull();
    });
});
