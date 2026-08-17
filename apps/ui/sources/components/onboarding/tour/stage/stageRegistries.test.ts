import { describe, expect, it } from 'vitest';

import { JOURNEY_STORY_SURFACE, getJourneyBeatsForSurface } from '../state/journeyBeats';
import { STAGE_SURFACE_IDS, stageSurfaces } from './stageSurfaces';
import {
    resolveStageFrameDevice,
    resolveStageFramesForHostDevice,
    stageFrames,
    type StageFrame,
} from './stageFrames';

const TIER_A_SURFACE_IDS = ['sessions-list', 'session-view', 'relay-settings', 'machines-settings'] as const;

function frameById(frameId: string): StageFrame {
    const frame = stageFrames.find((candidate) => candidate.id === frameId);
    if (!frame) throw new Error(`Unknown stage frame: ${frameId}`);
    return frame;
}

describe('stage surface registry', () => {
    it('registers the four Tier-A surfaces plus the feature-showcase Tier-B surfaces', () => {
        expect(STAGE_SURFACE_IDS).toEqual([
            'sessions-list',
            'session-view',
            'relay-settings',
            'machines-settings',
            'subagents',
            'review',
            'source-control',
            'voice',
            'mcp-servers',
            'connected-services',
            'theme-profiles',
        ]);
        expect(stageSurfaces.map((surface) => ({
            id: surface.id,
            tier: surface.tier,
            devices: surface.devices,
        }))).toEqual([
            { id: 'sessions-list', tier: 'A', devices: ['desktop', 'phone'] },
            { id: 'session-view', tier: 'A', devices: ['desktop', 'phone'] },
            { id: 'relay-settings', tier: 'A', devices: ['desktop'] },
            { id: 'machines-settings', tier: 'A', devices: ['desktop'] },
            { id: 'subagents', tier: 'B', devices: ['desktop'] },
            { id: 'review', tier: 'B', devices: ['desktop'] },
            { id: 'source-control', tier: 'B', devices: ['desktop'] },
            { id: 'voice', tier: 'B', devices: ['desktop'] },
            { id: 'mcp-servers', tier: 'B', devices: ['desktop'] },
            { id: 'connected-services', tier: 'B', devices: ['desktop', 'phone'] },
            { id: 'theme-profiles', tier: 'B', devices: ['desktop'] },
        ]);
    });

    it('keeps every frame attached to a registered surface and valid camera data', () => {
        const surfaceIds = new Set(STAGE_SURFACE_IDS);

        for (const frame of stageFrames) {
            expect(surfaceIds.has(frame.surface)).toBe(true);
            expect(frame.zoom).toBeGreaterThanOrEqual(1);
            expect(frame.zoom).toBeLessThanOrEqual(2.25);
            expect(frame.dim).toBeGreaterThanOrEqual(0);
            expect(frame.dim).toBeLessThanOrEqual(0.55);
        }
    });

    it('gives every registered surface at least one frame', () => {
        for (const surfaceId of STAGE_SURFACE_IDS) {
            expect(stageFrames.some((frame) => frame.surface === surfaceId)).toBe(true);
        }
    });

    it('provides one hero and one spotlight frame per Tier-A surface', () => {
        for (const surfaceId of TIER_A_SURFACE_IDS) {
            const heroFrame = stageFrames.find((frame) => frame.id === `${surfaceId}.hero`);
            expect(heroFrame).toMatchObject({
                surface: surfaceId,
                zoom: 1,
            });
            expect(heroFrame).not.toHaveProperty('spotlight');
            expect(stageFrames.find((frame) => frame.id === `${surfaceId}.spotlight`)).toMatchObject({
                surface: surfaceId,
                spotlight: expect.any(String),
            });
        }
    });

    it('gives each feature-showcase Tier-B surface a deliberate camera frame', () => {
        const tierBSurfaceIds = stageSurfaces.filter((surface) => surface.tier === 'B').map((surface) => surface.id);
        for (const surfaceId of tierBSurfaceIds) {
            const frames = stageFrames.filter((frame) => frame.surface === surfaceId);
            expect(frames.length).toBeGreaterThanOrEqual(1);
        }
    });

    it('provides a phone session frame for the A4 cockpit beat', () => {
        expect(stageFrames.find((frame) => frame.id === 'session-view.phone')).toMatchObject({
            surface: 'session-view',
            device: 'phone',
            zoom: 1,
            dim: 0,
        });
    });

    it('hosts every dream beat of the phone story cut on the phone canvas', () => {
        // The presentation that a phone-width viewport gets cannot host the
        // desktop window canvas (it lands near 0.2 scale, so the shell is
        // unreadable). Every beat the story cut still plays must therefore
        // resolve to a phone frame.
        const framesById = new Map<string, StageFrame>(
            resolveStageFramesForHostDevice('phone').map((frame) => [frame.id, frame]),
        );
        const storyDreamBeats = getJourneyBeatsForSurface(JOURNEY_STORY_SURFACE).filter((beat) => beat.act === 'dream');

        expect(storyDreamBeats.length).toBeGreaterThan(0);
        for (const beat of storyDreamBeats) {
            expect(framesById.get(beat.frameId)?.device).toBe('phone');
        }
    });

    it('swaps only the canvas when hosting a frame on the phone, keeping ids, order and camera data', () => {
        const phoneFrames = resolveStageFramesForHostDevice('phone');

        expect(phoneFrames.map((frame) => frame.id)).toEqual(stageFrames.map((frame) => frame.id));
        expect(phoneFrames.find((frame) => frame.id === 'session-view.spotlight')).toEqual({
            id: 'session-view.spotlight',
            surface: 'session-view',
            device: 'phone',
            spotlight: 'session-composer-queue',
            zoom: 1.35,
            dim: 0.55,
        });
    });

    it('leaves the desktop-width presentation verbatim, including the deliberate phone-in-desktop cockpit frame', () => {
        expect(resolveStageFramesForHostDevice('desktop')).toBe(stageFrames);
        expect(resolveStageFrameDevice(frameById('session-view.phone'), 'desktop')).toBe('phone');
    });

    it('keeps a frame on its own canvas when its surface registers no phone support', () => {
        // `voice` registers the desktop canvas only, so it is never downgraded
        // into an unsupported phone render; the story cut curates it out instead.
        expect(resolveStageFrameDevice(frameById('voice.hero'), 'phone')).toBe('desktop');
    });

    it('targets the real queue composer and attention group for A6 and A7', () => {
        expect(stageFrames.find((frame) => frame.id === 'session-view.spotlight')).toMatchObject({
            spotlight: 'session-composer-queue',
            zoom: 1.35,
        });
        expect(stageFrames.find((frame) => frame.id === 'sessions-list.spotlight')).toMatchObject({
            spotlight: 'session-list-attention-group',
            zoom: 1.35,
        });
    });
});
