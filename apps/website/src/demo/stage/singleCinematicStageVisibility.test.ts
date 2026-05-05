import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SingleCinematicStage } from './variants/SingleCinematicStage';
import type { ScenarioStagePrep } from './useScenarioStage';

function createPrep(
    overrides: Partial<ScenarioStagePrep> = {},
): ScenarioStagePrep {
    return {
        demoId: 'test-demo',
        scenario: {
            id: 'handoff',
            title: 'Test scenario',
            durationMs: 10_000,
            totalDuration: 10_000,
            initialBridgeState: {},
            beats: [],
        },
        state: {
            sessionTitle: 'Demo session',
            sessionMeta: '',
            messageCount: 0,
            messages: [],
            permission: null,
            terminal: [],
            activityChip: null,
            phoneNotification: null,
            syncPulseKey: 0,
            syncDirection: 'forward',
        },
        focus: 'phone',
        activeBeat: {
            id: 'beat-1',
            at: 0,
            atMs: 0,
            duration: 4_000,
            durationMs: 4_000,
            focus: 'phone',
            visibleSurfaces: ['phone-new-session', 'desktop-new-session'],
            state: {
                sessionTitle: 'Demo session',
                sessionMeta: '',
                messageCount: 0,
                messages: [],
                permission: null,
                terminal: [],
                activityChip: null,
                phoneNotification: null,
                syncPulseKey: 0,
                syncDirection: 'forward',
            },
            label: 'Phone plus desktop',
        },
        beatIndex: 0,
        totalBeats: 1,
        surfaceVisibility: {
            showTerminal: false,
            showPhone: true,
            showDesktop: true,
            resolvedPhoneView: 'phone-new-session',
            resolvedDesktopView: 'desktop-new-session',
        },
        terminalTitle: 'Terminal Slot Title',
        desktopTitle: 'Desktop Slot Title',
        phoneView: 'phone-new-session',
        desktopView: 'desktop-new-session',
        stageRef: createRef<HTMLDivElement>(),
        inView: false,
        ...overrides,
    };
}

function isHiddenSlot(markup: string, marker: string): boolean {
    const markerIndex = markup.indexOf(marker);
    expect(markerIndex).toBeGreaterThan(-1);

    const slotClass = 'class="pointer-events-auto absolute left-1/2 top-1/2"';
    const slotStart = markup.lastIndexOf(slotClass, markerIndex);
    expect(slotStart).toBeGreaterThan(-1);

    const slotOpenTag = markup.slice(
        slotStart,
        markup.indexOf('>', slotStart) + 1,
    );
    return slotOpenTag.includes('aria-hidden="true"');
}

function findOpeningTag(markup: string, marker: string): string {
    const start = markup.indexOf(marker);
    expect(start).toBeGreaterThan(-1);
    const tagStart = markup.lastIndexOf('<div', start);
    expect(tagStart).toBeGreaterThan(-1);
    const tagEnd = markup.indexOf('>', start);
    expect(tagEnd).toBeGreaterThan(-1);
    return markup.slice(tagStart, tagEnd + 1);
}

describe('SingleCinematicStage', () => {
    it('keeps the terminal offstage when a beat only exposes phone and desktop surfaces', () => {
        const prep = createPrep();
        const markup = renderToStaticMarkup(
            createElement(SingleCinematicStage, {
                prep,
                phoneSurface: createElement(
                    'div',
                    { 'data-surface': 'phone-marker' },
                    'Phone Marker',
                ),
                desktopSurface: createElement(
                    'div',
                    { 'data-surface': 'desktop-marker' },
                    'Desktop Marker',
                ),
            }),
        );

        expect(isHiddenSlot(markup, 'Terminal Slot Title')).toBe(true);
        expect(isHiddenSlot(markup, 'Phone Marker')).toBe(false);
        expect(isHiddenSlot(markup, 'Desktop Marker')).toBe(false);
    });

    it('takes the intrinsic stage out of normal flow so the scaled shell can own the section height', () => {
        const prep = createPrep();
        const markup = renderToStaticMarkup(
            createElement(SingleCinematicStage, {
                prep,
                phoneSurface: createElement('div', null, 'Phone Marker'),
                desktopSurface: createElement('div', null, 'Desktop Marker'),
            }),
        );

        const stageShell = findOpeningTag(markup, 'class="relative mx-auto"');
        const intrinsicStage = findOpeningTag(markup, 'class="relative w-[1180px] overflow-hidden"');

        expect(stageShell).toContain('height:660px');
        expect(stageShell).not.toContain('min-height:660px');
        expect(intrinsicStage).toContain('position:absolute');
        expect(intrinsicStage).toContain('left:0');
        expect(intrinsicStage).toContain('top:0');
    });
});
