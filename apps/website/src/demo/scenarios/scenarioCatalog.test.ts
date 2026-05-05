import { describe, expect, it } from 'vitest';
import { scenarios } from './index';
import { createScenarioEngine } from '../timeline/scenarioEngine';
import { createTerminalCommandRail } from '../frames/TerminalFrame';

describe('website demo scenario catalog', () => {
    it('includes the final scenario order with remote launch before direct sessions', () => {
        expect(Object.keys(scenarios)).toEqual([
            'handoff',
            'remoteLaunch',
            'directSessions',
            'voice',
            'parallel',
        ]);
    });

    it('cycles through every supported provider via the terminal typewriter', () => {
        // The cinematic hero beat uses a real typing animation (typewriter
        // prompt) rather than a static command rail. The intent is the same:
        // show the viewer that `happier` works with every provider.
        const cycleBeat = scenarios.handoff.beats.find(
            (beat) => beat.terminal?.typingPrompt != null,
        );

        expect(cycleBeat?.terminal?.typingPrompt?.prefix).toBe('happier ');
        expect(cycleBeat?.terminal?.typingPrompt?.tokens).toEqual([
            'claude',
            'codex',
            'opencode',
            'claude',
        ]);
    });

    it('still renders the static command rail when beats provide a commands list', () => {
        // Pillar scenarios that aren't using the typewriter still use the
        // command-rail renderer. Spot-check the helper is intact.
        expect(createTerminalCommandRail(['happier claude', 'happier codex'])).toBe(
            'happier claude → happier codex',
        );
    });

    it('orders the handoff arc as finish-notification → refinement → all-three → permission → desktop-approve', () => {
        const handoff = scenarios.handoff;
        const finishBeatIndex = handoff.beats.findIndex(
            (beat) => beat.state.phoneNotification?.phase === 'arriving',
        );
        const refineBeatIndex = handoff.beats.findIndex(
            (beat) => beat.state.phoneNotification?.phase === 'opened',
        );
        const permissionBeatIndex = handoff.beats.findIndex(
            (beat) => beat.id === 'permission-lands',
        );
        const approveDesktopBeatIndex = handoff.beats.findIndex(
            (beat) => beat.id === 'approve-desktop',
        );

        // 9-beat arc fits inside 25s (target ~24s with 2s rest).
        expect(handoff.durationMs).toBeLessThanOrEqual(25_000);
        expect(finishBeatIndex).toBeGreaterThan(-1);
        expect(refineBeatIndex).toBeGreaterThan(finishBeatIndex);
        expect(permissionBeatIndex).toBeGreaterThan(refineBeatIndex);
        expect(approveDesktopBeatIndex).toBeGreaterThan(permissionBeatIndex);

        const finishBeat = handoff.beats[finishBeatIndex];
        const permissionBeat = handoff.beats[permissionBeatIndex];
        const approveBeat = handoff.beats[approveDesktopBeatIndex];

        // Finish notification is NOT a permission — it's a "your agent is done" alert.
        expect(finishBeat?.state.permission ?? null).toBe(null);
        expect(finishBeat?.state.phoneNotification?.title).toMatch(/finished/i);

        // Permission beat has it pending and shows on every device (terminal + phone + desktop).
        expect(permissionBeat?.state.permission?.state).toBe('pending');
        expect(permissionBeat?.visibleSurfaces).toEqual(
            expect.arrayContaining(['terminal', 'phone-session', 'desktop-session']),
        );

        // Approve beat focuses on desktop and flips permission to approved.
        expect(approveBeat?.focus).toBe('desktop');
        expect(approveBeat?.state.permission?.state).toBe('approved');
    });

    it('publishes the phone follow-up into bridge transcript state', () => {
        const engine = createScenarioEngine(scenarios.handoff);

        // refine-sent beat lands a bit past 11s in the retimed scenario
        // and is the first beat that publishes the follow-up message.
        engine.seek(11_600);

        expect((engine.getState() as { messagesBySession: Record<string, unknown[]> }).messagesBySession['s-auth-skeleton']).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'm-follow-up',
                    role: 'user',
                    text: expect.stringContaining('skeleton loader'),
                }),
            ]),
        );
    });

    it('keeps the handoff bridge transcript complete through the approval beats', () => {
        const engine = createScenarioEngine(scenarios.handoff);

        // Seek into the approve-desktop beat — transcript should still
        // include the follow-up that beat 6 (refine-sent) introduced.
        engine.seek(16_000);

        expect((engine.getState() as { messagesBySession: Record<string, unknown[]> }).messagesBySession['s-auth-skeleton']).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ id: 'm-follow-up' }),
            ]),
        );
    });

    it('publishes remote-launch stream output into the launched session transcript', () => {
        const engine = createScenarioEngine(scenarios.remoteLaunch);

        engine.seek(18_500);

        expect((engine.getState() as { messagesBySession: Record<string, unknown[]> }).messagesBySession['s-opencode-auth']).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    role: 'agent',
                    text: expect.stringContaining('OpenCode'),
                }),
            ]),
        );
    });

    it('keeps the remote-launch bridge transcript complete on absolute attach seeks', () => {
        const engine = createScenarioEngine(scenarios.remoteLaunch);

        engine.seek(23_700);

        expect((engine.getState() as { messagesBySession: Record<string, unknown[]> }).messagesBySession['s-opencode-auth']).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'remote-opencode-stream',
                }),
            ]),
        );
    });

    it('keeps remote launch terminal hidden until the attach beat', () => {
        const remoteLaunch = scenarios.remoteLaunch;
        const firstTerminalBeatIndex = remoteLaunch.beats.findIndex((beat) =>
            beat.visibleSurfaces.includes('terminal'),
        );

        expect(firstTerminalBeatIndex).toBeGreaterThan(0);
        expect(remoteLaunch.beats[firstTerminalBeatIndex]?.id).toContain('attach');
        expect(remoteLaunch.beats[0]?.visibleSurfaces).toContain('phone-new-session');
        expect(remoteLaunch.beats[0]?.visibleSurfaces).toContain('desktop-new-session');
        expect(remoteLaunch.beats[0]?.visibleSurfaces).not.toContain('terminal');
    });

    it('shows a provider attach terminal beat after remote background launch', () => {
        const attachBeat = scenarios.remoteLaunch.beats.find(
            (beat) => beat.id === 'attach-terminal',
        );

        expect(attachBeat?.visibleSurfaces).toContain('terminal');
        expect(attachBeat?.terminal?.attachedSessionId).toBe('s-opencode-auth');
        expect(attachBeat?.terminal?.commands).toContain('happier attach s-opencode-auth');
        expect(attachBeat?.terminal?.lines.some((line) => line.text.includes('opencode attach'))).toBe(
            true,
        );
    });

    it('keeps the handoff beat clock monotonic and preserves minimum visibility for key work beats', () => {
        const handoff = scenarios.handoff;
        const beatStarts = handoff.beats.map((beat) => beat.atMs);
        const sortedBeatStarts = [...beatStarts].sort((left, right) => left - right);
        const claudeWorksIndex = handoff.beats.findIndex((beat) => beat.id === 'claude-works');
        const stepAwayIndex = handoff.beats.findIndex((beat) => beat.id === 'step-away');
        const claudeWorks = handoff.beats[claudeWorksIndex];
        const stepAway = handoff.beats[stepAwayIndex];
        const claudeWorksVisibleMs =
            handoff.beats[claudeWorksIndex + 1].atMs - claudeWorks.atMs;
        const stepAwayVisibleMs = handoff.beats[stepAwayIndex + 1].atMs - stepAway.atMs;

        expect(beatStarts).toEqual(sortedBeatStarts);
        expect(claudeWorksVisibleMs).toBeGreaterThanOrEqual(claudeWorks.durationMs);
        expect(stepAwayVisibleMs).toBeGreaterThanOrEqual(1_000);
    });

    it('starts direct sessions with an outside-Happier terminal proof', () => {
        const firstBeat = scenarios.directSessions.beats[0];

        expect(firstBeat?.visibleSurfaces).toContain('terminal');
        expect(firstBeat?.visibleSurfaces).toContain('direct-browse');
        // The active provider was switched to Codex when we wired the real
        // codex-atlas asciinema cast in; the cast shows the actual `codex`
        // CLI running outside Happier.
        expect(firstBeat?.terminal?.commands).toEqual(['codex']);
        expect(firstBeat?.terminal?.lines.some((line) => line.text.includes('Started without Happier'))).toBe(
            true,
        );
    });

    it('presents parallel work as independent sessions in one inbox', () => {
        expect(scenarios.parallel.initialBridgeState.sessions).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ provider: 'Claude', title: 'Refactor shell' }),
                expect.objectContaining({ provider: 'Codex', title: 'Stabilize tests' }),
                expect.objectContaining({ provider: 'OpenCode', title: 'Docs build' }),
            ]),
        );

        const permissionBeat = scenarios.parallel.beats.find((beat) => beat.id === 'round-robin-permissions');
        expect(permissionBeat?.bridgePatch?.permissionsBySession).toEqual({
            's-parallel-claude': expect.objectContaining({
                id: 'p-refactor',
                agent: 'Claude',
                state: 'pending',
            }),
            's-parallel-codex': expect.objectContaining({
                id: 'p-tests',
                agent: 'Codex',
                state: 'pending',
            }),
            's-parallel-opencode': expect.objectContaining({
                id: 'p-docs',
                agent: 'OpenCode',
                state: 'pending',
            }),
        });

        const finalBeat = scenarios.parallel.beats.find((beat) => beat.id === 'parallel-clear');
        expect(finalBeat?.bridgePatch?.permissionsBySession).toEqual({});
    });
});
