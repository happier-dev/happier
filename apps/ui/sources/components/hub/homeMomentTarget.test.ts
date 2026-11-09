import { describe, expect, it } from 'vitest';

import { homePlanetGeometry, homePlanetSceneOptions } from '@/components/atmosphere/homePlanetPlacement';

import { resolveHomeMomentTarget } from './homeMomentTarget';

const pane = { width: 1150, height: 900 };
const options = homePlanetSceneOptions(homePlanetGeometry('corner', pane), pane, { theme: 'light', style: 'balanced', digits: true });
const planetHome = { heroActive: true, planetSource: true, options, fade: { from: 0.8, to: 1 } } as const;

describe('resolveHomeMomentTarget', () => {
    it('has no target while Home does not know what it shows yet', () => {
        expect(resolveHomeMomentTarget({ guidanceKind: 'loading', ...planetHome })).toBeNull();
    });
    it.each(['select_session', 'connect_machine'] as const)("lands on Home's planet when the hub (which draws it) is Home (%s)", (guidanceKind) => {
        expect(resolveHomeMomentTarget({ guidanceKind, ...planetHome })).toMatchObject({ kind: 'planet', options });
    });
    it('ends centred when the reconnect guidance is Home: it draws no planet to land on', () => {
        expect(resolveHomeMomentTarget({ guidanceKind: 'start_daemon', ...planetHome })).toEqual({ kind: 'none' });
    });
    it('ends centred when Home shows no planet at all', () => {
        expect(resolveHomeMomentTarget({ guidanceKind: 'select_session', ...planetHome, planetSource: false })).toEqual({ kind: 'none' });
    });
});
