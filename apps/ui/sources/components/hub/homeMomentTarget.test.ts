import { describe, expect, it } from 'vitest';

import { horizonPlanetGeometry } from '@happier-dev/brand/planet-placement';
import { planetGlyphLayer } from '@happier-dev/brand/glyph-scene';

import { resolveHomeMomentTarget } from './homeMomentTarget';

const pane = { width: 1150, height: 900 };
const layer = planetGlyphLayer({ geometry: horizonPlanetGeometry(pane), intensity: 'quiet', digits: true });
const planetHome = { heroActive: true, planetSource: true, layer, pane } as const;

describe('resolveHomeMomentTarget', () => {
    it('has no target while Home does not know what it shows yet', () => {
        expect(resolveHomeMomentTarget({ guidanceKind: 'loading', ...planetHome })).toBeNull();
    });
    it.each(['select_session', 'connect_machine'] as const)("lands on Home's planet when the hub (which draws it) is Home (%s)", (guidanceKind) => {
        expect(resolveHomeMomentTarget({ guidanceKind, ...planetHome })).toEqual({ kind: 'planet', layer, pane });
    });
    it('ends centred when the reconnect guidance is Home: it draws no planet to land on', () => {
        expect(resolveHomeMomentTarget({ guidanceKind: 'start_daemon', ...planetHome })).toEqual({ kind: 'none' });
    });
    it('ends centred when Home shows no planet at all', () => {
        expect(resolveHomeMomentTarget({ guidanceKind: 'select_session', ...planetHome, planetSource: false })).toEqual({ kind: 'none' });
    });
});
