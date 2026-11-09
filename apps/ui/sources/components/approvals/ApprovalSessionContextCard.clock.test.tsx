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
const { removeServerProfile, upsertServerProfile } = await import('@/sync/domains/server/serverProfiles');
afterEach(async () => { await standardCleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Approval context age leaf', () => {
    it('advances a retained offline Home age only at its display boundary without a source update or parent repaint', async () => {
        const now = Date.parse('2026-09-30T12:00:00.000Z');
        vi.useFakeTimers({ now });
        let clockFires = 0;
        const timeout = globalThis.setTimeout, interval = globalThis.setInterval;
        const ownsTimer = () => /[\\/](agentActivityClock|sessionListRuntimeClock)\.ts:/.test(new Error().stack ?? '');
        vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
            const owned = ownsTimer();
            return timeout(() => { if (owned) clockFires += 1; callback(...args); }, delay);
        });
        vi.spyOn(globalThis, 'setInterval').mockImplementation((callback, delay, ...args) => {
            const owned = ownsTimer();
            return interval(() => { if (owned) clockFires += 1; callback(...args); }, delay);
        });
        const facts = buildSessionContextFacts({ address: { serverId: 'home', sessionId: 'session' },
            homeName: 'Home', homeObservation: { phase: 'offline', lastSuccessAt: now - 3_570_000 } });
        const context = projectSessionContextPresentation(facts);
        const paints = vi.fn();
        function Parent() {
            paints();
            return <ApprovalSessionContextCard session={null} sessionName={null} machineLabel={null} serverId="home"
                context={context} contextFacts={facts} homeName="Home" requesterAgentId={null} requesterSurface="" />;
        }
        const screen = await renderScreen(<Parent />);
        expect(screen.getTextContent()).toContain('Last updated 59m');
        const before = paints.mock.calls.length;
        await act(async () => { vi.advanceTimersByTime(30_000); });
        expect(screen.getTextContent()).toContain('Last updated 1h');
        await act(async () => { vi.advanceTimersByTime(270_000); });
        expect(clockFires).toBe(1);
        expect(screen.getTextContent()).toContain('session.homeFreshness.offline');
        expect(paints.mock.calls.length).toBe(before);
        await screen.update(<ApprovalSessionContextCard session={null} sessionName={null} machineLabel={null} serverId="home"
            context={context} homeName="Home" requesterAgentId={null} requesterSurface="" />);
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('Requested by main line', () => {
    it('leads with the asking Home when no session asked', async () => {
        const screen = await renderScreen(<ApprovalSessionContextCard session={null} sessionName={null} machineLabel={null} serverId="home"
            context={null} homeName="Studio Mac" requesterSessionId={null} requesterAgentId={null} requesterSurface="cli" />);
        const title = screen.findByTestId('approvals.requester-title');
        expect(title?.props.children).toBe('Studio Mac');
        // The Home is the main line, so it is not repeated as a "Home: …" fact beneath it.
        expect(screen.getTextContent()).not.toContain('actionConfirmations.homeTarget');
    });
});

describe('Requested by a session titled by its whole first prompt', () => {
    it('stops the title at two lines and keeps the whole prompt as its text', async () => {
        const prompt = 'Use Happier Action tools only: action_options_resolve and action_execute with {"controllerMachineId":"58f6e63a-cd69-4302-83f1-325d10da7ec3"}';
        const screen = await renderScreen(<ApprovalSessionContextCard session={null} sessionName={prompt} machineLabel={null} serverId="home"
            context={null} homeName="Studio Mac" requesterSessionId="session-1" requesterAgentId={null} requesterSurface="cli" />);
        const title = screen.findByTestId('approvals.requester-title');
        expect(title?.props.numberOfLines).toBe(2);
        expect(title?.props.children).toBe(prompt);
    });
});

describe('Requested by while the asking session resolves', () => {
    it('holds the session line as a neutral placeholder, never claiming the session is elsewhere or promoting the Home', async () => {
        const screen = await renderScreen(<ApprovalSessionContextCard session={null} sessionName={null} machineLabel={null} serverId="home"
            context={null} homeName="Studio Mac" requesterSessionId="session-1" requesterStatus="resolving"
            requesterAgentId={null} requesterSurface="cli" />);
        expect(screen.findByTestId('approvals.requester-title-resolving')).toBeTruthy();
        expect(screen.findByTestId('approvals.requester-title')).toBeFalsy();
        expect(screen.getTextContent()).not.toContain('detailPages.approval.sessionOnHome');
        expect(screen.getTextContent()).not.toContain('detailPages.approval.sessionElsewhere');
    });
});

describe('Requested by a session the Home no longer lists', () => {
    it('says the session is on this Home when the Home it asked from has no name of its own', async () => {
        // A saved Home known only by its address: the person is signed in to it, so "not on this device" would be false.
        const profile = await upsertServerProfile({ serverUrl: 'https://unnamed-home.example.test', name: 'unnamed-home.example.test' });
        try {
            const screen = await renderScreen(<ApprovalSessionContextCard session={null} sessionName={null} machineLabel={null} serverId={profile.id}
                context={null} homeName={null} homeDisplayId="settingsAccount.thisHomeTitle" requesterSessionId="session-1"
                requesterStatus="unavailable" requesterAgentId={null} requesterSurface="cli" />);
            const text = screen.getTextContent();
            expect(text).toContain('detailPages.approval.sessionOnHome');
            expect(text).not.toContain('detailPages.approval.sessionElsewhere');
            // The sentence already names the Home; it is not repeated as a "Home: ..." fact.
            expect(text).not.toContain('actionConfirmations.homeTarget');
        } finally {
            await removeServerProfile(profile.id);
        }
    });
});

describe('Requested by Happier Guard', () => {
    it('names Guard, not the Session or Home its work concerns, and says so in its own description', async () => {
        const screen = await renderScreen(<ApprovalSessionContextCard session={null} sessionName="Upgrade the editor" machineLabel={null} serverId="home"
            context={null} homeName="Studio Mac" homeDisplayId="settingsAccount.thisHomeTitle" requesterSessionId="session-1"
            requesterAgentId={null} requesterSurface="system" requestedByGuard />);
        expect(screen.findByTestId('approvals.requester-title')?.props.children).toBe('detailPages.approval.requesterGuard');
        const text = screen.getTextContent();
        expect(text).toContain('detailPages.approval.requesterGuardDescription');
        expect(text).not.toContain('detailPages.approval.contextDescription');
        expect(text).not.toContain('Upgrade the editor');
        expect(text).not.toContain('Studio Mac');
        expect(text).not.toContain('actionConfirmations.homeTarget');
        expect(text).not.toContain('detailPages.approval.origin.system');
    });
});
