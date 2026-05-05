import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NarrativeLayer } from './NarrativeLayer';
import type { ScenarioBeat } from '../timeline/scenarioTypes';

function createBeat(label: string): ScenarioBeat {
    return {
        id: 'beat-1',
        at: 0,
        atMs: 0,
        duration: 4_000,
        durationMs: 4_000,
        focus: 'terminal',
        visibleSurfaces: ['terminal'],
        state: {
            sessionTitle: 'Demo session',
            sessionMeta: 'Running',
            messageCount: 0,
            messages: [],
            permission: null,
            terminal: [],
            activityChip: null,
            phoneNotification: null,
            syncPulseKey: 0,
            syncDirection: 'forward',
        },
        label,
    };
}

function readTopPx(markup: string): number {
    const match = markup.match(/top:([0-9.]+)px/);
    expect(match).not.toBeNull();
    return Number(match?.[1]);
}

describe('NarrativeLayer', () => {
    it('places terminal captions higher than desktop captions so the terminal chrome does not cover the copy', () => {
        const activeBeat = createBeat('Your agent gets to work.');

        const terminalMarkup = renderToStaticMarkup(
            createElement(NarrativeLayer, { activeBeat, hero: 'terminal' }),
        );
        const desktopMarkup = renderToStaticMarkup(
            createElement(NarrativeLayer, { activeBeat, hero: 'desktop' }),
        );

        expect(readTopPx(terminalMarkup)).toBeLessThan(readTopPx(desktopMarkup));
    });
});
