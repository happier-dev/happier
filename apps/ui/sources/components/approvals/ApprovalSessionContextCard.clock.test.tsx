import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { installSessionSubagentCommonModuleMocks } from '@/components/sessions/agents/sessionSubagentTestHelpers';

installSessionSubagentCommonModuleMocks({ text: async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key, values) => key === 'session.homeFreshness.lastUpdated'
        ? `Last updated ${values?.ago}` : key });
} });
// Navigation is the native SDK boundary; context facts and formatting remain real.
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
const { ApprovalSessionContextCard } = await import('./ApprovalSessionContextCard');
const { buildSessionContextFacts, projectSessionContextPresentation } = await import('@/sync/domains/session/presentation/sessionContextPresentation');
afterEach(async () => { await standardCleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Approval context age leaf', () => {
    it('advances a retained offline Home age without a source update or parent repaint', async () => {
        const now = Date.parse('2026-09-30T12:00:00.000Z');
        vi.useFakeTimers({ now });
        const facts = buildSessionContextFacts({ address: { serverId: 'home', sessionId: 'session' },
            homeName: 'Home', homeObservation: { phase: 'offline', lastSuccessAt: now - 60_000 } });
        const context = projectSessionContextPresentation(facts);
        const paints = vi.fn();
        function Parent() {
            paints();
            return <ApprovalSessionContextCard session={null} machine={null} serverId="home"
                context={context} contextFacts={facts} homeName="Home" requesterAgentId={null} requesterSurface="" />;
        }
        const screen = await renderScreen(<Parent />);
        expect(screen.getTextContent()).toContain('Last updated 1m');
        const before = paints.mock.calls.length;
        await act(async () => vi.advanceTimersByTime(60_000));
        expect(screen.getTextContent()).toContain('Last updated 2m');
        expect(screen.getTextContent()).toContain('session.homeFreshness.offline');
        expect(paints.mock.calls.length).toBe(before);
    });
});
