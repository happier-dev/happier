import { afterEach, describe, expect, it } from 'vitest';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { atmosphereStageStore, useAtmosphereStage } from './atmosphereStage';

afterEach(() => { standardCleanup(); atmosphereStageStore.clearStage(-1); atmosphereStageStore.clearStage(-2); });
it('publishes the frame’s existing picture and replacement without acquiring it again', async () => {
    const first = { kind: 'picture' as const, bytes: 'file:///first.jpg' };
    const second = { kind: 'picture' as const, bytes: 'file:///second.jpg' };
    const hook = await renderHook(({ backdrop }) => useAtmosphereStage('home', null, true, true, backdrop), { initialProps: { backdrop: first } });
    expect(atmosphereStageStore.get().stage?.backdrop).toBe(first);
    await hook.rerender({ backdrop: second });
    expect(atmosphereStageStore.get().stage?.backdrop).toBe(second);
});

describe('one shell atmosphere across visible panes', () => {
    it('keeps scroll local to each stage and preserves it when focus changes', () => {
        const home = { id: -1, surface: 'home' as const, geometry: null };
        const project = { id: -2, surface: { project: { serverId: 'home-a', projectKey: 'project-a' } }, geometry: null };
        atmosphereStageStore.setStage(home, true);
        atmosphereStageStore.setStage(project, false);
        atmosphereStageStore.setScrollY(home.id, 137);
        expect(atmosphereStageStore.getScrollY(home.id)).toBe(137);
        expect(atmosphereStageStore.getScrollY(project.id)).toBe(0);
        atmosphereStageStore.setStage(home, false);
        atmosphereStageStore.setStage(project, true);
        atmosphereStageStore.setScrollY(project.id, 42);
        atmosphereStageStore.setStage(project, false);
        atmosphereStageStore.setStage(home, true);
        expect(atmosphereStageStore.getScrollY(home.id)).toBe(137);
        expect(atmosphereStageStore.getScrollY(project.id)).toBe(42);
        atmosphereStageStore.clearStage(home.id);
        expect(atmosphereStageStore.getScrollY(home.id)).toBe(0);
    });
    it('keeps opaque transcript geometry in the common scene without letting that pane select an atmosphere', () => {
        const project = { id: -1, surface: { project: { serverId: 'home-a', projectKey: 'project-a' } }, geometry: null };
        const transcript = { id: -2, surface: 'home' as const, geometry: null };
        atmosphereStageStore.setStage(project, true);
        atmosphereStageStore.setStage(transcript, false, false);
        expect(atmosphereStageStore.get().panes).toEqual([project, transcript]);
        expect(atmosphereStageStore.get().stage?.surface).toEqual(project.surface);
        atmosphereStageStore.clearStage(project.id);
        expect(atmosphereStageStore.get().stage).toBeNull();
        expect(atmosphereStageStore.get().panes).toEqual([transcript]);
    });
    it('retains the visible Project scene when an opaque transcript takes focus, then returns to Home', () => {
        const home = { id: -1, surface: 'home' as const, geometry: null };
        const project = { id: -2, surface: { project: { serverId: 'home-a', projectKey: 'project-a' } }, geometry: null };
        atmosphereStageStore.setStage(home, false);
        atmosphereStageStore.setStage(project, true);
        expect(atmosphereStageStore.get().stage?.surface).toEqual(project.surface);
        atmosphereStageStore.setStage(project, false);
        expect(atmosphereStageStore.get().stage?.surface).toEqual(project.surface);
        atmosphereStageStore.clearStage(project.id);
        expect(atmosphereStageStore.get().stage?.surface).toBe('home');
        atmosphereStageStore.clearStage(home.id);
        expect(atmosphereStageStore.get().stage).toBeNull();
    });
});
