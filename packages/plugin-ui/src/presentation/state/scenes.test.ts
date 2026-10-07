import { describe, expect, it } from 'vitest';

import {
  HAPPIER_SCENE_IDS,
  HAPPIER_SCENE_PROP_IDS,
  defineHappierScene,
  defineHappierSceneProp,
  resolveHappierScene,
  resolveHappierSceneArtSize,
  type HappierResolvedScene,
} from './scenes.js';

const propLayers = (scene: HappierResolvedScene) => scene.layers.filter((layer) => layer.front);
const tones = (scene: HappierResolvedScene, name: string) => scene.layers.find((layer) => layer.name === name)!.marks.map((mark) => mark.tone);

/**
 * Widgets plan A5 + the Daybreak library: one registry of parts (horizons, moments, planet states, props,
 * sky) behind the state-mark slot; built-in and plugin scenes are compositions of the same parts.
 */
describe('Daybreak scene registry', () => {
  it('resolves every built-in scene and every catalog prop through the same composition', () => {
    expect(HAPPIER_SCENE_IDS).toHaveLength(37);
    expect(HAPPIER_SCENE_PROP_IDS).toHaveLength(51);
    for (const id of HAPPIER_SCENE_IDS) expect(resolveHappierScene(id, 'page').name).toBe(id);
    for (const prop of HAPPIER_SCENE_PROP_IDS) {
      const layer = propLayers(resolveHappierScene({ name: `test.${prop}`, props: [{ prop, x: 80 }] }))[0]!;
      expect(layer.name).toBe(prop);
      expect(layer.marks.length).toBeGreaterThan(0);
    }
    expect(() => resolveHappierScene('noSuchScene' as never)).toThrow(TypeError);
  });

  it('applies the composition rules per size: focal prop first, sky before props, detail at thumb', () => {
    const crowd = { name: 'test.crowd', horizon: 'sea', moment: 'rising', sky: ['birds', 'clouds'], props: [{ prop: 'flag', x: 92 }, { prop: 'tent', x: 116 }, { prop: 'tree', x: 136 }, { prop: 'bench', x: 72 }] } as const;
    const count = (size: 'page' | 'pane' | 'thumb') => {
      const scene = resolveHappierScene(crowd, size);
      return { props: propLayers(scene).map((layer) => layer.name), sky: scene.layers.filter((layer) => layer.name.startsWith('sky.')).length, reflection: scene.layers.some((layer) => layer.name === 'sea.reflection') };
    };
    expect(count('page')).toEqual({ props: ['flag', 'tent', 'tree'], sky: 2, reflection: true });
    expect(count('pane')).toEqual({ props: ['flag', 'tent'], sky: 1, reflection: true });
    expect(count('thumb')).toEqual({ props: ['flag'], sky: 0, reflection: false });
    // night's own stars outlast the size's sky budget
    expect(resolveHappierScene('searchWaiting', 'thumb').layers.some((layer) => layer.name === 'sky.stars')).toBe(true);
  });

  it('keeps one accent: only the named prop keeps its colour, every other accent falls to the ink', () => {
    const scene = resolveHappierScene({ name: 'test.accent', moment: 'noon', props: [{ prop: 'buoy', x: 50 }, { prop: 'plant', x: 76 }], accent: 'buoy' });
    expect(tones(scene, 'buoy')).toContain('accent');
    expect(tones(scene, 'plant')).not.toContain('accent');
    expect(tones(resolveHappierScene({ name: 'test.none', props: [{ prop: 'buoy', x: 50 }] }), 'buoy')).not.toContain('accent');
  });

  it('places and lights the planet by moment and state', () => {
    expect(resolveHappierScene({ name: 'a', moment: 'rising', planet: 'rising' }).planets).toEqual([
      expect.objectContaining({ cx: 52, cy: 44.68, r: 11, clipY: 45.6, pose: 'ready', rises: true }),
    ]);
    const noon = resolveHappierScene({ name: 'b', moment: 'noon' }).planets[0]!;
    expect(noon).toMatchObject({ cx: 108, cy: 18, rises: false });
    expect(noon.clipY).toBeUndefined();
    expect(resolveHappierScene({ name: 'c', moment: 'golden' }).planets[0]).toMatchObject({ warm: true });
    expect(resolveHappierScene({ name: 'd', moment: 'dusk' }).planets[0]).toMatchObject({ progress: 0.38 });
    expect(resolveHappierScene({ name: 'e', moment: 'night' }).planets).toEqual([]);
    expect(resolveHappierScene('voiceIdle').planets[0]).toMatchObject({ energy: 0.55, r: 13, cx: 80 });
    expect(resolveHappierScene('checksFailed').planets[0]).toMatchObject({ pose: 'shade' });
    // out of reach: the planet in ink inside a dashed outline
    const offline = resolveHappierScene('homeOffline');
    expect(offline.planets[0]).toMatchObject({ ink: true, pose: 'ready' });
    expect(offline.layers.find((layer) => layer.name === 'planet')!.marks[0]).toMatchObject({ shape: 'circle', dash: '2.1 2.7' });
    // waiting on you: the shadowed planet and the one amber beacon
    const waiting = resolveHappierScene('reconnecting');
    expect(waiting.planets[0]).toMatchObject({ pose: 'shadow' });
    expect(waiting.layers.find((layer) => layer.name === 'planet')!.marks).toEqual([expect.objectContaining({ shape: 'circle', tone: 'accent', filled: true })]);
    expect(resolveHappierScene('pairingDone').planets).toHaveLength(2);
    expect(resolveHappierScene('manyHomes').planets).toHaveLength(3);
  });

  it('stands a prop on its ground at x, scaled and mirrored, with a sky prop lifted by its own float', () => {
    const [boxes, satellite] = propLayers(resolveHappierScene({
      name: 'test.place',
      props: [{ prop: 'boxes', x: 46, ground: 45, scale: 1.5, flip: true }, { prop: 'satellite', x: 100, scale: 2 }],
    }, 'page'));
    expect(boxes).toMatchObject({ x: 46, y: 45, scale: 1.5, flip: true, front: true });
    expect(satellite).toMatchObject({ x: 100, y: 46 - 10 * 2, scale: 2 });
  });

  it('lets a plugin add its own prop into a built-in scene and name it as the accent', () => {
    const bubble = defineHappierSceneProp({
      name: 'channels.bubble',
      float: 6,
      marks: [
        { shape: 'path', d: 'M-9-18h18v12h-18z' },
        { shape: 'circle', cx: 4, cy: -12, r: 0.9, filled: true, accent: true },
        { shape: 'path', d: 'M-4-6h8', tone: 'faint', dash: 'dotted' },
      ],
    });
    const base = resolveHappierScene('nothingListening', 'page');
    const scene = resolveHappierScene(defineHappierScene({
      name: 'channels.no-bot',
      base: 'nothingListening',
      props: [{ prop: bubble, x: 114, ground: 36 }],
      accent: 'channels.bubble',
    }), 'page');
    expect(scene.name).toBe('channels.no-bot');
    expect(scene.planets).toEqual(base.planets);
    const added = propLayers(scene).at(-1)!;
    expect(added).toMatchObject({ name: 'channels.bubble', x: 114, y: 30 });
    expect(added.marks.map((mark) => mark.tone)).toEqual(['ink', 'accent', 'faint']);
    expect(added.marks[2]).toMatchObject({ dash: '0 3.2' });
    expect(() => defineHappierScene({ name: '' })).toThrow(TypeError);
    expect(() => defineHappierScene({ name: 'acme.bad', base: 'noSuchScene' as never })).toThrow(TypeError);
  });
});

describe('which states draw a scene', () => {
  it('draws art only where a state has room for it; compact states keep their text', () => {
    expect(resolveHappierSceneArtSize({ size: 'pane' })).toBe('pane');
    expect(resolveHappierSceneArtSize({ size: 'details', layout: 'centered' })).toBe('details');
    expect(resolveHappierSceneArtSize({ layout: 'page' })).toBe('page');
    // the centred column of a whole pane draws at pane size
    expect(resolveHappierSceneArtSize({ layout: 'centered' })).toBe('pane');
    expect(resolveHappierSceneArtSize({ size: 'line' })).toBeNull();
    expect(resolveHappierSceneArtSize({ layout: 'line' })).toBeNull();
    expect(resolveHappierSceneArtSize({ layout: 'inline', size: 'page' })).toBeNull();
  });
});
