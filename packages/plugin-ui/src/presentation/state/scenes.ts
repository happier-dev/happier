import type { HappierStateSize } from './InfoState.js';

/**
 * Daybreak scenes (widgets plan A5 and its library extension; labs `.happier/design-lab/empty-states`
 * direction A and `.happier/design-lab/daybreak-library`).
 *
 * A scene is one moment of one day on one horizon, drawn in a single line ink, with the Daybreak dot
 * planet as the only colour. It is DATA — a composition of named parts from one registry:
 *
 *   `scene = { horizon, moment, planet, planetAt?, props[], sky[], accent? }`
 *
 * - **horizon**: the ground every prop stands on (11: sea, land, ridge, dock, desk, orbit, dunes,
 *   shore, field, city, none);
 * - **moment**: where the planet stands and how it is lit (7: predawn, rising, noon, golden, dusk,
 *   night, eclipse), plus the sky it brings;
 * - **planet**: the planet's state on top of the moment (7: resting, rising, pulsing, waiting, paired,
 *   homes, failed), or `false` for none;
 * - **props**: single-stroke line art from one catalog (51), each a component placed by `x`, `ground`,
 *   `scale` and `flip`, anchored bottom-centre on the ground;
 * - **sky**: weather marks (6: stars, haze, comet, rain, birds, clouds);
 * - **accent**: the one prop whose accent detail keeps its colour; every other accent falls to the ink.
 *
 * The registry enforces the composition rules per size (at most 3/2/1 props and 2/1/0 sky marks at
 * page/pane/thumb; detail drops at thumb). The built-in scenes are compositions of these parts, and
 * plugins compose theirs through the same API ({@link defineHappierScene}, {@link defineHappierSceneProp}).
 * Drawing is the host's (`renderScene` on the presentation host; the app's scene renderer in core): ink,
 * line widths, the planet itself, motion and theme stay host-owned, so a composition places parts but
 * never restyles them. Coordinates are in one 160 × 64 scene box.
 */

export const HAPPIER_SCENE_VIEWBOX = Object.freeze({ width: 160, height: 64 });
/** The default ground line every prop stands on. */
const GROUND = 46;

// ─── parts: public vocabulary ─────────────────────────────────────────────────────────────────────

export type HappierSceneHorizon = 'sea' | 'land' | 'ridge' | 'dock' | 'desk' | 'orbit' | 'dunes' | 'shore' | 'field' | 'city' | 'none';
export type HappierSceneMoment = 'predawn' | 'rising' | 'noon' | 'golden' | 'dusk' | 'night' | 'eclipse';
export type HappierSceneSky = 'stars' | 'haze' | 'comet' | 'rain' | 'birds' | 'clouds';
/** The planet on top of its moment: still, rising once, alive, waiting on you, paired, many Homes, failed. */
export type HappierScenePlanetState = 'resting' | 'rising' | 'pulsing' | 'waiting' | 'paired' | 'homes' | 'failed';

export type HappierScenePropId =
  | 'tower'
  | 'dish'
  | 'satellite'
  | 'beacon'
  | 'bell'
  | 'flag'
  | 'pin'
  | 'signpost'
  | 'tent'
  | 'tree'
  | 'plant'
  | 'path'
  | 'footprints'
  | 'bridge'
  | 'boat'
  | 'buoy'
  | 'sail'
  | 'crate'
  | 'boxes'
  | 'bench'
  | 'lamp'
  | 'lantern'
  | 'mug'
  | 'book'
  | 'mailbox'
  | 'note'
  | 'envelope'
  | 'checklist'
  | 'hourglass'
  | 'clock'
  | 'key'
  | 'lock'
  | 'shield'
  | 'magnifier'
  | 'folder'
  | 'prompt'
  | 'gear'
  | 'chart'
  | 'branch'
  | 'merge'
  | 'plug'
  | 'ladder'
  | 'windmill'
  | 'cloud'
  | 'kite'
  | 'balloon'
  | 'plane'
  | 'rocket'
  | 'comet'
  | 'machine'
  | 'telescope';

/** `ink` is the scene's line; `faint` is its quieter second line. Colour, width and caps stay the host's. */
export type HappierSceneTone = 'ink' | 'faint';

/** `dotted` reads as a path not taken yet; `dashed` as a place waiting for something. */
export type HappierSceneDash = 'dotted' | 'dashed';

/**
 * One mark of a plugin's prop, drawn around the prop's anchor (0, 0: bottom-centre on the ground, y up
 * is negative) in the scene's line ink. `accent: true` marks the prop's one accent detail, coloured only
 * when the scene names the prop as its accent.
 */
export type HappierSceneMark =
  | Readonly<{ shape: 'path'; d: string; tone?: HappierSceneTone; dash?: HappierSceneDash; accent?: boolean }>
  | Readonly<{ shape: 'circle'; cx: number; cy: number; r: number; tone?: HappierSceneTone; dash?: HappierSceneDash; filled?: boolean; accent?: boolean }>
  | Readonly<{ shape: 'rect'; x: number; y: number; width: number; height: number; radius?: number; tone?: HappierSceneTone; dash?: HappierSceneDash; accent?: boolean }>
  | Readonly<{ shape: 'ellipse'; cx: number; cy: number; rx: number; ry: number; rotate?: number; tone?: HappierSceneTone; dash?: HappierSceneDash; accent?: boolean }>;

/** A plugin's own reusable prop: named marks, placed like any catalog prop. `float` lifts a sky prop. */
export type HappierScenePropDefinition = Readonly<{ name: string; marks: readonly HappierSceneMark[]; float?: number }>;

/** One prop placed in a scene: a catalog prop or a plugin's own, at `x` on the `ground`. */
export type HappierScenePropPlacement = Readonly<{
  prop: HappierScenePropId | HappierScenePropDefinition;
  x: number;
  /** The ground line the prop stands on; defaults to the scene's. */
  ground?: number;
  scale?: number;
  /** Mirror the prop left to right. */
  flip?: boolean;
}>;

/** Where the moment's planet sits, when a scene moves it: `rise` is the share of its radius above the ground. */
export type HappierScenePlanetPlacement = Readonly<{ x?: number; y?: number; r?: number; rise?: number }>;

/** A scene as data. Built-in scenes and plugin scenes are both this composition. */
export type HappierSceneComposition = Readonly<{
  horizon?: HappierSceneHorizon;
  moment?: HappierSceneMoment;
  planet?: HappierScenePlanetState | false;
  planetAt?: HappierScenePlanetPlacement;
  /** The ground line's height (default 46). */
  ground?: number;
  props?: readonly HappierScenePropPlacement[];
  sky?: readonly HappierSceneSky[];
  /** The one prop (by id or plugin prop name) whose accent detail keeps its colour. */
  accent?: string;
}>;

/** The built-in scenes, one per recurring state (library gallery). */
export type HappierSceneId =
  | 'firstRun' | 'pairingDone' | 'agentFinished' | 'reviewApproved' | 'checksPassed' | 'checksFailed'
  | 'rateLimited' | 'syncConflict' | 'noMachines' | 'noPlugins' | 'noWorkflows' | 'inboxZero'
  | 'emptyBoard' | 'voiceIdle' | 'searchWaiting' | 'noMatch' | 'homeOffline' | 'reconnecting'
  | 'sessionStarting' | 'needsYou' | 'nothingListening' | 'noProjects' | 'shipped' | 'noAttachments'
  | 'noNotes' | 'noAutomations' | 'invitePeople' | 'notAllowed' | 'connectAccount' | 'noTerminal'
  | 'archiveEmpty' | 'handoff' | 'treeClean' | 'notificationsOff' | 'exploring' | 'ideas' | 'manyHomes';

/**
 * A named scene for a plugin's own state: a built-in scene (`base`) with the plugin's props added and
 * any part replaced, or a whole composition.
 */
export type HappierSceneDefinition = Readonly<{
  /** A stable name, namespaced by the plugin ("acme.no-deploys"). */
  name: string;
  base?: HappierSceneId;
}> & HappierSceneComposition;

export type HappierSceneInput = HappierSceneId | HappierSceneDefinition;

// ─── sizes, rules, and which states draw a scene ──────────────────────────────────────────────────

/** The sizes a scene is drawn at: the sized state steps, plus `thumb` for previews. */
export type HappierSceneArtSize = HappierStateSize | 'thumb';

/**
 * Scene width per size, the line width there, the gap to the state's title, and the composition tier
 * whose rules apply. The height follows the 160 × 64 box.
 */
export const HAPPIER_SCENE_ART_METRICS: Readonly<Record<HappierSceneArtSize, Readonly<{ widthPx: number; strokePx: number; gapPx: number; tier: 'page' | 'pane' | 'thumb' }>>> = Object.freeze({
  page: Object.freeze({ widthPx: 232, strokePx: 1.45, gapPx: 20, tier: 'page' }),
  details: Object.freeze({ widthPx: 196, strokePx: 1.45, gapPx: 16, tier: 'pane' }),
  pane: Object.freeze({ widthPx: 176, strokePx: 1.3, gapPx: 14, tier: 'pane' }),
  phone: Object.freeze({ widthPx: 204, strokePx: 1.3, gapPx: 16, tier: 'pane' }),
  thumb: Object.freeze({ widthPx: 96, strokePx: 1.2, gapPx: 8, tier: 'thumb' }),
});

/** Composition rules per tier: the focal prop comes first; sky marks drop before props; detail drops at thumb. */
export const HAPPIER_SCENE_RULES = Object.freeze({
  maxProps: Object.freeze({ page: 3, pane: 2, thumb: 1 }),
  sky: Object.freeze({ page: 2, pane: 1, thumb: 0 }),
  detail: Object.freeze({ page: 2, pane: 2, thumb: 1 }),
});

/**
 * Whether a state draws the scene its caller chose, and at what size. Art belongs to a state with room
 * around it (≥ ~220 px): a page, pane, details or phone state, or the centred column a whole pane
 * holds (drawn at pane size). A compact line or inline state keeps its text and glyph.
 */
export function resolveHappierSceneArtSize(input: Readonly<{
  size?: HappierStateSize | 'line';
  layout?: 'centered' | 'page' | 'line' | 'inline';
}>): HappierStateSize | null {
  if (input.layout === 'line' || input.layout === 'inline' || input.size === 'line') return null;
  if (input.layout === 'page') return 'page';
  return input.size ?? 'pane';
}

// ─── resolved scene (what the host draws) ─────────────────────────────────────────────────────────

/** A mark ready to draw: tones are final (an accent the scene did not name is already ink). */
export type HappierResolvedSceneMark =
  | Readonly<{ shape: 'path'; d: string; tone: HappierSceneTone | 'accent'; dash?: string; opacity?: number; strokeScale?: number }>
  | Readonly<{ shape: 'circle'; cx: number; cy: number; r: number; tone: HappierSceneTone | 'accent'; filled?: boolean; dash?: string; opacity?: number }>
  | Readonly<{ shape: 'rect'; x: number; y: number; width: number; height: number; radius: number; tone: HappierSceneTone | 'accent'; dash?: string }>
  | Readonly<{ shape: 'ellipse'; cx: number; cy: number; rx: number; ry: number; rotate?: number; tone: HappierSceneTone | 'accent'; dash?: string }>;

/**
 * A group of marks at a placement. `fade` fades the group out towards both ends of that x range (every
 * ground line); `front` groups (props) draw over the planet, the rest under it.
 */
export type HappierResolvedSceneLayer = Readonly<{
  name: string;
  x: number;
  y: number;
  scale: number;
  flip: boolean;
  fade?: readonly [number, number];
  front: boolean;
  marks: readonly HappierResolvedSceneMark[];
}>;

/**
 * One Daybreak dot planet: centre and radius in the scene box, its lattice rows, pose and light, hidden
 * below `clipY`. `ink` draws it as a half-strength ink disc (out of reach); `rises` marks the planet the
 * host brings up once when the scene appears.
 */
export type HappierResolvedScenePlanet = Readonly<{
  cx: number;
  cy: number;
  r: number;
  rows: number;
  pose: 'ready' | 'shadow' | 'eclipse' | 'shade';
  energy: number;
  /** Daybreak's light for explicit progress (0 night … 1 full day); absent, the pose's own light. */
  progress?: number;
  /** Golden hour: warmed towards the sun. */
  warm: boolean;
  ink: boolean;
  clipY?: number;
  rises: boolean;
}>;

export type HappierResolvedScene = Readonly<{
  name: string;
  layers: readonly HappierResolvedSceneLayer[];
  planets: readonly HappierResolvedScenePlanet[];
}>;

/**
 * What a host's scene renderer receives: the resolved scene, its size, and whether it must stay still
 * (reduced motion, or a surface the viewer is not looking at). Motion is the renderer's: a rising
 * planet comes up once, then rests.
 */
export type HappierSceneRenderRequest = Readonly<{
  scene: HappierResolvedScene;
  size: HappierSceneArtSize;
  still: boolean;
  testID?: string;
}>;

// ─── drawing helpers ──────────────────────────────────────────────────────────────────────────────

type Tone = HappierSceneTone | 'accent';
type MarkExtra = Readonly<{ filled?: boolean; dash?: string; opacity?: number; strokeScale?: number }>;
const f2 = (value: number) => Math.round(value * 100) / 100;
const path = (d: string, tone: Tone = 'ink', extra: MarkExtra = {}): HappierResolvedSceneMark =>
  ({ shape: 'path', d, tone, ...(extra.dash ? { dash: extra.dash } : {}), ...(extra.opacity !== undefined ? { opacity: extra.opacity } : {}), ...(extra.strokeScale ? { strokeScale: extra.strokeScale } : {}) });
const circle = (cx: number, cy: number, r: number, tone: Tone = 'ink', extra: MarkExtra = {}): HappierResolvedSceneMark =>
  ({ shape: 'circle', cx, cy, r, tone, ...(extra.filled ? { filled: true } : {}), ...(extra.dash ? { dash: extra.dash } : {}), ...(extra.opacity !== undefined ? { opacity: extra.opacity } : {}) });
const rect = (x: number, y: number, width: number, height: number, radius: number, tone: Tone = 'ink', extra: MarkExtra = {}): HappierResolvedSceneMark =>
  ({ shape: 'rect', x, y, width, height, radius, tone, ...(extra.dash ? { dash: extra.dash } : {}) });
const ellipse = (cx: number, cy: number, rx: number, ry: number, rotate: number, tone: Tone = 'ink', extra: MarkExtra = {}): HappierResolvedSceneMark =>
  ({ shape: 'ellipse', cx, cy, rx, ry, ...(rotate ? { rotate } : {}), tone, ...(extra.dash ? { dash: extra.dash } : {}) });

const layer = (name: string, marks: readonly HappierResolvedSceneMark[], fade?: readonly [number, number]): HappierResolvedSceneLayer =>
  ({ name, x: 0, y: 0, scale: 1, flip: false, front: false, marks, ...(fade ? { fade } : {}) });
/** A ground line faded out at both ends. */
const line = (name: string, y: number, x1 = 6, x2 = 154): HappierResolvedSceneLayer => layer(name, [path(`M${x1} ${y}H${x2}`)], [x1, x2]);

type SceneContext = Readonly<{ y: number; px: number; detail: number }>;

// ─── horizons ─────────────────────────────────────────────────────────────────────────────────────

const HORIZONS: Readonly<Record<HappierSceneHorizon, (c: SceneContext) => readonly HappierResolvedSceneLayer[]>> = Object.freeze({
  // a horizon over water; the planet reflects
  sea: (c) => [line('sea', c.y), ...(c.detail > 1 ? [layer('sea.reflection', [path(`M${f2(c.px - 10)} ${f2(c.y + 5.5)}h20M${f2(c.px - 6)} ${f2(c.y + 10)}h12M${f2(c.px - 2.5)} ${f2(c.y + 14)}h5`, 'faint')])] : [])],
  // firm ground, a few blades
  land: (c) => [line('land', c.y), ...(c.detail > 1 ? [layer('land.blades', [path(`M30 ${c.y}l-1-2.6M33 ${c.y}l.8-2.2M118 ${c.y}l-.8-2.4M121.5 ${c.y}l1-3M124 ${c.y}l.4-1.6`, 'faint')])] : [])],
  // hills behind the line
  ridge: (c) => [line('ridge', c.y), layer('ridge.hills', [
    path(`M8 ${c.y}L26 ${c.y - 9}L36 ${c.y - 5}L52 ${c.y - 15}L66 ${c.y - 6}L76 ${c.y - 9}L92 ${c.y}`, 'faint'),
    path(`M104 ${c.y}L120 ${c.y - 7}L132 ${c.y - 3}L144 ${c.y - 10}L156 ${c.y}`, 'faint', { opacity: 0.7 }),
  ], [6, 154])],
  // a boardwalk out over still water
  dock: (c) => [line('dock', c.y + 4), layer('dock.deck', [
    path(`M6 ${c.y - 1}H74`), path(`M6 ${f2(c.y + 1.4)}H74`, 'faint'), path(`M14 ${c.y - 1}v9M34 ${c.y - 1}v9M54 ${c.y - 1}v9M72 ${c.y - 1}v9`),
    ...(c.detail > 1 ? [path(`M10 ${c.y + 9}h8M30 ${c.y + 9}h8M50 ${c.y + 9}h8M68 ${c.y + 9}h8`, 'faint')] : []),
  ])],
  // the bench your agents work at
  desk: (c) => [line('desk', c.y), layer('desk.edge', [path(`M6 ${f2(c.y + 2.6)}H154`, 'faint')], [6, 154]), layer('desk.legs', [path(`M24 ${f2(c.y + 2.6)}v14M136 ${f2(c.y + 2.6)}v14`, 'faint')])],
  // no ground: a path through space
  orbit: (c) => [layer('orbit', [ellipse(80, c.y - 8, 74, 12, 0, 'faint', { dash: '1 3.2' })], [4, 156])],
  // soft overlapping curves
  dunes: (c) => [layer('dunes', [
    path(`M6 ${c.y}C30 ${c.y - 6} 52 ${c.y - 6} 78 ${c.y}S122 ${c.y + 4} 154 ${c.y - 2}`),
    path(`M40 ${c.y + 6}C64 ${c.y + 2} 90 ${c.y + 2} 116 ${c.y + 7}`, 'faint'),
  ], [6, 154])],
  // land meets sea in one curve
  shore: (c) => [layer('shore', [path(`M6 ${c.y - 4}C30 ${c.y - 4} 44 ${c.y} 60 ${c.y}H154`)], [6, 154]),
    ...(c.detail > 1 ? [layer('shore.ripples', [path(`M64 ${c.y + 5}h16M86 ${c.y + 9}h12M70 ${c.y + 12}h8`, 'faint')])] : [])],
  // furrows running to the line
  field: (c) => [line('field', c.y), layer('field.furrows', [
    path(`M60 64L74 ${c.y + 1}M100 64L86 ${c.y + 1}M40 64L68 ${c.y + 1}M120 64L92 ${c.y + 1}`, 'faint', { dash: '1 2.6' }),
  ], [6, 154])],
  // a low town far away
  city: (c) => [line('city', c.y), layer('city.skyline', [
    path(`M14 ${c.y}v-5h6v-3h5v8M28 ${c.y}v-9h7v9M38 ${c.y}v-4h4v-4h3v8M118 ${c.y}v-6h5v-4h4v10M130 ${c.y}v-8h7v8M140 ${c.y}v-4h6v4`, 'faint'),
  ], [6, 154])],
  none: () => [],
});

// ─── sky ──────────────────────────────────────────────────────────────────────────────────────────

const STARS: readonly (readonly [number, number, number])[] = [[22, 13, 0.8], [38, 24, 0.6], [64, 8, 0.7], [96, 17, 0.55], [134, 9, 0.75], [146, 27, 0.6], [112, 30, 0.45]];
const SKY: Readonly<Record<HappierSceneSky, (c: SceneContext) => HappierResolvedSceneLayer>> = Object.freeze({
  stars: (c) => layer('sky.stars', STARS.filter((_, index) => c.detail > 1 || index % 2 === 0).map(([x, y, r]) => circle(x, y, r, 'ink', { filled: true, opacity: 0.5 }))),
  haze: (c) => layer('sky.haze', [path(`M18 ${c.y - 10}h30M30 ${c.y - 6}h22M104 ${c.y - 12}h34M118 ${c.y - 7}h20`, 'faint', { opacity: 0.8 })]),
  comet: () => layer('sky.comet', [path('M44 30C66 20 86 14 110 11', 'faint', { dash: '0 2.6' }), circle(112, 10.6, 1.25, 'ink', { filled: true }), path('M107.2 10.4l3.2.2')]),
  rain: () => layer('sky.rain', [24, 40, 56, 72, 88, 104, 120, 136].map((x, index) => path(`M${x + (index % 2) * 4} ${8 + (index % 3) * 4}l-3 18`, 'faint', { dash: '0 3.2' }))),
  birds: () => layer('sky.birds', [path('M60.5 14.5q1.6-1.8 3.2 0q1.6-1.8 3.2 0M70 9.5q1.2-1.4 2.4 0q1.2-1.4 2.4 0', 'ink', { strokeScale: 0.77 })]),
  clouds: () => layer('sky.clouds', [path('M24 22h22M32 27h18M118 14h16', 'faint')]),
});

// ─── moments and planet states ────────────────────────────────────────────────────────────────────

type MomentPlanet = Readonly<{ x: number; r: number; rise?: number; y?: number; pose?: 'ready' | 'shadow' | 'eclipse'; progress?: number; warm?: boolean; outline?: boolean }>;
const MOMENTS: Readonly<Record<HappierSceneMoment, Readonly<{ planet: MomentPlanet | null; sky?: readonly HappierSceneSky[] }>>> = Object.freeze({
  // only the halo shows
  predawn: { planet: { x: 80, rise: -0.62, r: 14, pose: 'shadow' }, sky: ['stars'] },
  // half up, warming
  rising: { planet: { x: 52, rise: 0.12, r: 11 } },
  // high and whole
  noon: { planet: { x: 108, y: 18, r: 11 } },
  // low, long reflection
  golden: { planet: { x: 118, rise: 0.7, r: 12, warm: true } },
  // setting, lit from the side
  dusk: { planet: { x: 122, rise: 0.25, r: 12, progress: 0.38 } },
  // set; the sky keeps the stars
  night: { planet: null, sky: ['stars'] },
  // out of reach, outlined
  eclipse: { planet: { x: 80, rise: 0.75, r: 12, pose: 'eclipse', outline: true } },
});

/** Scene planets keep a finer lattice than marks: one dot per 1.25 scene units of the dot box. */
const planetRows = (r: number) => Math.max(9, Math.round(r / 0.4 / 1.25));
/** The "needs you" beacon on a waiting planet, and the dotted link between paired planets. */
const BEACON_R = 1.5;
/** Many Homes: one planet per Home along the ground. */
const HOMES: readonly (readonly [number, number, 'ready' | 'shadow'])[] = [[38, 7, 'ready'], [80, 9.5, 'ready'], [124, 6.5, 'shadow']];

function resolvePlanets(spec: MomentPlanet | null, state: HappierScenePlanetState, ground: number): Readonly<{ planets: HappierResolvedScenePlanet[]; marks: HappierResolvedSceneMark[] }> {
  if (!spec) return { planets: [], marks: [] };
  const clipY = spec.y !== undefined ? undefined : f2(ground - 0.4);
  const cy = f2(spec.y ?? ground - (spec.rise ?? 0) * spec.r);
  const base = {
    pose: state === 'waiting' ? 'shadow' as const : state === 'failed' ? 'shade' as const : spec.pose ?? 'ready' as const,
    energy: state === 'pulsing' ? 0.55 : 0,
    ...(spec.progress !== undefined ? { progress: spec.progress } : {}),
    warm: spec.warm === true,
    ink: false,
    ...(clipY !== undefined ? { clipY } : {}),
  };
  if (state === 'homes') {
    return { planets: HOMES.map(([x, r, pose]) => ({ ...base, pose, cx: x, cy: f2(ground - r * 0.55), r, rows: planetRows(r), rises: false })), marks: [] };
  }
  const planets: HappierResolvedScenePlanet[] = [];
  const marks: HappierResolvedSceneMark[] = [];
  if (state === 'paired') {
    const x2 = spec.x < 80 ? spec.x + 62 : spec.x - 62;
    const r2 = f2(spec.r * 0.62);
    const y2 = f2(ground - r2 * 0.6);
    marks.push(path(`M${spec.x} ${f2(cy - spec.r - 3)}Q${f2((spec.x + x2) / 2)} ${f2(Math.min(cy, y2) - spec.r - 16)} ${x2} ${f2(y2 - r2 - 3)}`, 'faint', { dash: '0 3' }));
    planets.push({ ...base, cx: x2, cy: y2, r: r2, rows: planetRows(r2), clipY: f2(ground - 0.4), rises: false });
  }
  if (spec.outline) {
    marks.push(circle(spec.x, cy, spec.r, 'ink', { dash: '2.1 2.7' }));
    planets.push({ ...base, pose: 'ready', ink: true, cx: spec.x, cy, r: spec.r, rows: planetRows(spec.r), rises: false });
  } else {
    planets.push({ ...base, cx: spec.x, cy, r: spec.r, rows: planetRows(spec.r), rises: state === 'rising' });
  }
  if (state === 'waiting') marks.push(circle(f2(spec.x + spec.r * 0.72), f2(cy - spec.r * 0.72), BEACON_R, 'accent', { filled: true }));
  return { planets, marks };
}

// ─── props ────────────────────────────────────────────────────────────────────────────────────────

type CatalogProp = Readonly<{ group: string; float: number; marks: readonly HappierResolvedSceneMark[] }>;
const prop = (group: string, float: number, marks: readonly HappierResolvedSceneMark[]): CatalogProp => ({ group, float, marks });

/** The catalog: original single-stroke props, anchored bottom-centre on the ground, ~10–26 units tall. */
const PROPS: Readonly<Record<HappierScenePropId, CatalogProp>> = Object.freeze({
  tower: prop('signals', 0, [path('M-6 0L0-27L6 0'), path('M-3.9-9.5h7.8M-2-18h4'), circle(0, -29.2, 1.7), path('M-5.2-33.5a7.2 7.2 0 0 0 0 8.6M5.2-33.5a7.2 7.2 0 0 1 0 8.6', 'faint', { dash: '1 2.4' })]),
  dish: prop('signals', 0, [path('M-1 0h8M3 0v-7'), path('M-6-19a12 12 0 0 0 15 10z'), path('M1.5-13.5l5-5'), circle(7, -19, 1.1)]),
  satellite: prop('signals', 10, [path('M-3-24h6v6h-6z'), path('M-3-21h-10M3-21h10'), path('M-13-24v6h-0M-9-24v6M9-24v6M13-24v6', 'faint'), path('M0-18v3'), circle(0, -14, 1)]),
  beacon: prop('signals', 0, [path('M-2.6 0L-1.6-20h3.2L2.6 0'), rect(-2.8, -25.5, 5.6, 5.5, .8), path('M-3.6-25.5h7.2L0-29z'), path('M5.5-22.8h6M-5.5-22.8h-6', 'accent', { dash: '1.6 2' })]),
  bell: prop('signals', 4, [path('M-6-8c0-8 2-12 6-12s6 4 6 12l2 2h-16z'), path('M-2-4.5a2 2 0 0 0 4 0'), path('M0-20v-2.5')]),
  flag: prop('places', 0, [path('M0 0V-25'), path('M.6-24.2l13 4.4-13 4.4')]),
  pin: prop('places', 0, [path('M0 0c-4.6-6.4-7-10-7-13.4a7 7 0 0 1 14 0C7-10 4.6-6.4 0 0z'), circle(0, -13.4, 2.4)]),
  signpost: prop('places', 0, [path('M0 0V-24'), path('M0-22h10l2.6 2.6L10-16.8H0M0-13H-10l-2.6 2.6L-10-7.8H0')]),
  tent: prop('places', 0, [path('M-13 0L0-17L13 0'), path('M0-17L-4 0M0-17l4 0'), path('M-15 0h30', 'faint'), path('M0-17v-3')]),
  tree: prop('places', 0, [path('M0 0v-10'), path('M-1.2-10c-5.4 0-8-3.6-6.6-7.4-1-4.4 2.8-8.2 7.8-7.6 5-.6 8.8 3.2 7.8 7.6 1.4 3.8-1.2 7.4-6.6 7.4z'), path('M0-10v-6M0-13.4l2.8-2.6', 'faint')]),
  plant: prop('places', 0, [path('M-4.5 0l-1.4-7h11.8L4.5 0z'), path('M.2-7.2c-.4-5 2-8.4 6.4-9.6-.4 4.4-2.8 7.6-6.4 9.6zM0-7.2c-3-1.8-4.4-4.8-3.4-8 2.8 1.2 4 4.4 3.4 8z', 'accent')]),
  path: prop('places', 0, [path('M-14 0C-6-1.6 0-3.4 4-6.4S10-11 16-12.4', 'faint', { dash: '0 3.2' })]),
  footprints: prop('places', 0, [ellipse(-13, 0.5, .75, 1.3, 62, 'faint'), ellipse(-8, -3.7, .75, 1.3, 62, 'faint'), ellipse(-3, -2.9, .75, 1.3, 62, 'faint'), ellipse(2, -7.1, .75, 1.3, 62, 'faint'), ellipse(7, -6.3, .75, 1.3, 62, 'faint'), ellipse(12, -10.5, .75, 1.3, 62, 'faint')]),
  bridge: prop('places', 0, [path('M-20-8h40'), path('M-15 0a15 9 0 0 1 30 0'), path('M-20-12h40M-16-12v4M-8-12v4M0-12v4M8-12v4M16-12v4', 'faint')]),
  boat: prop('water', 0, [path('M-10-3h20l-3.4 3h-13.2z'), path('M0-3V-21'), path('M.7-20.2L9.4-5.4H.7z'), path('M-1.2-18.4L-6.6-6.4h5.4', 'faint')]),
  buoy: prop('water', 0, [path('M-4 0l1.2-8h5.6L4 0'), path('M-1.6-8v-5h3.2v5'), circle(0, -15, 1.3, 'accent', { filled: true }), path('M-8 2.4h16', 'faint')]),
  sail: prop('water', 0, [path('M0 0V-22'), path('M.8-21.2C7-15 9-8 8.6-2H.8z'), path('M-7-2h16l-2 2H-5z')]),
  crate: prop('objects', 0, [rect(-7, -12, 14, 12, .8), path('M-7-8.6h14M-7-3.4h14'), path('M-3.6-12v12M3.6-12v12', 'faint')]),
  boxes: prop('objects', 0, [rect(-11, -9, 10, 9, .6), rect(1, -11, 10, 11, .6), rect(-6, -19, 10, 10, .6), path('M-11-4.5h10M1-5.5h10M-6-14h10', 'faint')]),
  bench: prop('objects', 0, [path('M-12-6h24'), path('M-10-6v6M10-6v6'), path('M-12-14.5c8-1.2 16-1.2 24 0'), path('M-12-11c8-1 16-1 24 0', 'faint'), path('M-8.6-14.3V-6M8.6-14.3V-6')]),
  lamp: prop('objects', 0, [path('M-6 0h12'), path('M-2-.6L4-15l12 4'), circle(4, -15, 1.3), path('M13.6-12.4l10 3.4-4.2 5.6z')]),
  lantern: prop('objects', 0, [path('M-4 0h8M-3.4 0v-9h6.8V0'), path('M-4.2-9h8.4L2-13h-4z'), path('M0-13a2.6 2.6 0 0 1 0-0M-2-13a2 2 0 0 1 4 0'), circle(0, -4.6, 1.3, 'accent', { filled: true })]),
  mug: prop('objects', 0, [path('M-6-13h11v10.5A2.5 2.5 0 0 1 2.5 0h-6A2.5 2.5 0 0 1-6-2.5z'), path('M5-10.5a3.6 3.6 0 0 1 0 7'), path('M-2-16.5c-1.6-2.2 1.6-3.4 0-6M2.6-16c-1.6-2.2 1.6-3.4 0-6', 'accent')]),
  book: prop('objects', 0, [path('M-11-2c4-1.6 7.6-1.6 11 0 3.4-1.6 7-1.6 11 0V-14c-4-1.6-7.6-1.6-11 0-3.4-1.6-7-1.6-11 0z'), path('M0-14V-2'), path('M-8-10.8c2-.6 4-.6 6 0M3-10.8c2-.6 4-.6 6 0', 'faint')]),
  mailbox: prop('objects', 0, [path('M0 0V-12'), path('M-9-12v-8.5a6 6 0 0 1 6-6h12a6 6 0 0 1 6 6v8.5z'), path('M-3-26.5a6 6 0 0 1 6 6v8.5', 'faint'), path('M15-20.5h6.5v4H15', 'accent')]),
  note: prop('objects', 3, [path('M-7-18h14v10l-5 5h-9z'), path('M2-3v-5h5', 'faint'), path('M-4-14h8M-4-10.6h5', 'faint')]),
  envelope: prop('objects', 3, [rect(-9, -13, 18, 12, 1.2), path('M-9-12.4l9 6.6 9-6.6')]),
  checklist: prop('objects', 0, [rect(-8, -21, 16, 21, 1.6), path('M-3-22.6h6v3h-6z'), path('M-4.6-14.4l1.2 1.2 2.2-2.4M-4.6-8.4l1.2 1.2 2.2-2.4'), path('M1-14h4M1-8h4M-4.6-3h9.6', 'faint')]),
  hourglass: prop('objects', 0, [path('M-6-20h12M-6 0h12'), path('M-4.6-20c0 5 4.6 6 4.6 10s-4.6 5-4.6 10M4.6-20c0 5-4.6 6-4.6 10S4.6-5 4.6 0'), path('M-2.4-1.2h4.8', 'accent'), circle(0, -8, .5, 'ink', { filled: true })]),
  clock: prop('objects', 2, [circle(0, -10, 9), path('M0-15.5V-10l3.6 2.4')]),
  key: prop('objects', 0, [circle(-7, -5, 4.4), path('M-2.6-5H11M7-5v3.6M10-5v2.6')]),
  lock: prop('objects', 0, [rect(-7, -12, 14, 12, 2), path('M-4.4-12v-3.6a4.4 4.4 0 0 1 8.8 0V-12'), path('M0-7.4v2.6')]),
  shield: prop('objects', 0, [path('M0-22l-8 3.4v6c0 6 3.4 10.4 8 12.6 4.6-2.2 8-6.6 8-12.6v-6z'), path('M-3.4-11l2.4 2.4 4.4-4.8', 'accent')]),
  magnifier: prop('objects', 0, [circle(-2, -14, 7.4), path('M3.4-8.6L10 0'), path('M-6-17a5 5 0 0 1 3.2-2.6', 'accent')]),
  folder: prop('work', 0, [path('M-11 0v-15h7l2.4 2.6H11V0z'), path('M-11-10h22', 'faint')]),
  prompt: prop('work', 0, [rect(-12, -17, 24, 17, 2), path('M-12-13h24', 'faint'), path('M-8-9.4l3 2.4-3 2.4M-3.4-4.4h5'), path('M3.2-4.4h2.6', 'accent')]),
  gear: prop('work', 2, [path('M8 -10L7.39 -6.94L5.54 -7.7L4.24 -5.76L5.66 -4.34L3.06 -2.61L2.3 -4.46L0 -4L0 -2L-3.06 -2.61L-2.3 -4.46L-4.24 -5.76L-5.66 -4.34L-7.39 -6.94L-5.54 -7.7L-6 -10L-8 -10L-7.39 -13.06L-5.54 -12.3L-4.24 -14.24L-5.66 -15.66L-3.06 -17.39L-2.3 -15.54L0 -16L0 -18L3.06 -17.39L2.3 -15.54L4.24 -14.24L5.66 -15.66L7.39 -13.06L5.54 -12.3L6 -10Z'), circle(0, -10, 2.6)]),
  chart: prop('work', 0, [path('M-11 0h22', 'faint'), path('M-8 0v-6M-3 0v-11M2 0v-8M7 0v-16'), path('M-8-9L-3-14L2-11L7-19', 'faint', { dash: '0 2.2' }), circle(7, -19.6, 1.3, 'accent', { filled: true })]),
  branch: prop('work', 0, [path('M-5 0V-24'), path('M-5-7c0-6 10-6 10-12v-5'), circle(-5, -25.6, 1.6), circle(5, -25.6, 1.6), circle(-5, -7, 1.1, 'ink', { filled: true })]),
  merge: prop('work', 0, [path('M-9 0c0-9 9-10 9-19M9 0c0-9-9-10-9-19V-24'), circle(0, -25.6, 1.8, 'accent', { filled: true }), circle(-9, 0, 1, 'ink', { filled: true }), circle(9, 0, 1, 'ink', { filled: true })]),
  plug: prop('work', 0, [path('M-16 0c6 0 8-9 14-9'), rect(-2, -12, 8, 6, 1.2), path('M6-10.6h4M6-7.4h4')]),
  ladder: prop('work', 0, [path('M-5 0L-2-26M5 0L8-26'), path('M-4.2-5h9.6M-3.4-11h9.6M-2.6-17h9.6M-1.8-23h9.6')]),
  windmill: prop('work', 0, [path('M-1.6 0L-.6-22h1.2L1.6 0'), circle(0, -22, 1), path('M0-22l-1.8-11M0-22l10 4M0-22l-8.6 6.8')]),
  cloud: prop('sky', 10, [path('M-12-2h22a5 5 0 0 0-1-9.8 7 7 0 0 0-13.2-1.4A5.4 5.4 0 0 0-12-2z')]),
  kite: prop('sky', 4, [path('M0-30l6 8-6 10-6-10z'), path('M-6-22h12M0-30v18', 'faint'), path('M0-12c-3 4 3 7 0 11s2 6 0 8', 'faint', { dash: '1 2.4' }), path('M-1.6-7l3.2 1.2M-1.4-1.6l3 1', 'accent')]),
  balloon: prop('sky', 6, [path('M0-12c-6-3-9-8-9-13a9 9 0 0 1 18 0c0 5-3 10-9 13z'), path('M0-34v22M-5.2-30.6c2 4 2 10.6 3 18M5.2-30.6c-2 4-2 10.6-3 18', 'faint'), path('M-2.6-12h5.2v4h-5.2z')]),
  plane: prop('sky', 10, [path('M-10-14L12-22 4-6l-5-4z'), path('M-1-10l13-12'), path('M-12-6c-6 2-10 1-14-1', 'faint', { dash: '0 2.6' })]),
  rocket: prop('sky', 0, [path('M0-30c4 4 5 10 4 18h-8c-1-8 0-14 4-18z'), circle(0, -20, 1.8), path('M-4-14l-3.6 4h3.4M4-14l3.6 4H4.2'), path('M-1.6-9.2l1.6 4 1.6-4', 'accent')]),
  comet: prop('sky', 0, [circle(10, -24, 1.6), path('M7.6-22.6C-2-18-8-12-14-4', 'faint', { dash: '0 2.6' })]),
  machine: prop('signals', 0, [path('M0 0V-6'), rect(-5.5, -13.5, 11, 7.5, 1.4), path('M-3 0h6', 'faint'), circle(0, -9.8, 1.1, 'accent', { filled: true })]),
  telescope: prop('signals', 0, [path('M-5 0L1-11L7 0M1-11V0'), path('M-10-12.6L13.6-24.4l2.6 4.8-23.6 11.8z'), path('M-12.6-11.4l3-1.5 1.5 2.9-3 1.5z')]),});

// ─── built-in scenes ──────────────────────────────────────────────────────────────────────────────

const at = (propId: HappierScenePropId, x: number, extra: Readonly<{ ground?: number; scale?: number; flip?: boolean }> = {}): HappierScenePropPlacement =>
  ({ prop: propId, x, ...extra });

/** The built-in scenes: one line of registry each (library gallery). */
const BUILT_IN_SCENES: Readonly<Record<HappierSceneId, HappierSceneComposition>> = Object.freeze({
  firstRun: { horizon: 'land', moment: 'rising', planet: 'rising', props: [at('signpost', 106), at('path', 84, { scale: 1.2 })] },
  pairingDone: { horizon: 'sea', moment: 'noon', planet: 'paired', planetAt: { x: 52, y: 24 } },
  agentFinished: { horizon: 'desk', moment: 'golden', props: [at('checklist', 52), at('mug', 76)], accent: 'checklist' },
  reviewApproved: { horizon: 'land', moment: 'noon', planetAt: { x: 112 }, props: [at('merge', 52)], accent: 'merge' },
  checksPassed: { horizon: 'field', moment: 'noon', props: [at('shield', 56)], accent: 'shield' },
  checksFailed: { horizon: 'ridge', moment: 'dusk', planet: 'failed', props: [at('chart', 56)] },
  rateLimited: { horizon: 'dunes', moment: 'golden', props: [at('hourglass', 54)], accent: 'hourglass' },
  syncConflict: { horizon: 'land', moment: 'noon', planetAt: { x: 116 }, props: [at('signpost', 58), at('footprints', 82)] },
  noMachines: { horizon: 'land', moment: 'predawn', planet: 'resting', props: [at('plug', 104)] },
  noPlugins: { horizon: 'dock', moment: 'rising', planetAt: { x: 122 }, props: [at('boxes', 46, { ground: 45 })] },
  noWorkflows: { horizon: 'land', moment: 'noon', planetAt: { x: 116 }, props: [at('gear', 52), at('ladder', 74)] },
  inboxZero: { horizon: 'sea', moment: 'golden', props: [at('mailbox', 54)] },
  emptyBoard: { horizon: 'orbit', moment: 'noon', planetAt: { x: 118, y: 26 }, props: [at('note', 48, { ground: 40 }), at('pin', 72, { ground: 42 })], accent: 'pin' },
  voiceIdle: { horizon: 'sea', moment: 'rising', planet: 'pulsing', planetAt: { x: 80, r: 13 } },
  searchWaiting: { horizon: 'land', moment: 'night', props: [at('telescope', 54)] },
  noMatch: { horizon: 'city', moment: 'noon', planetAt: { x: 112 }, props: [at('magnifier', 58)], accent: 'magnifier' },
  homeOffline: { horizon: 'land', moment: 'eclipse' },
  reconnecting: { horizon: 'sea', moment: 'predawn', planet: 'waiting' },
  sessionStarting: { horizon: 'desk', moment: 'rising', planet: 'rising', planetAt: { x: 112 }, props: [at('lamp', 48)] },
  needsYou: { horizon: 'sea', moment: 'rising', planet: 'waiting', planetAt: { x: 56, r: 14 }, props: [at('beacon', 108)], accent: 'beacon' },
  nothingListening: { horizon: 'land', moment: 'dusk', props: [at('tower', 64)] },
  noProjects: { horizon: 'land', moment: 'rising', planetAt: { x: 124, r: 8 }, props: [at('flag', 62), at('path', 44)] },
  shipped: { horizon: 'land', moment: 'noon', planetAt: { x: 118 }, props: [at('rocket', 58)], accent: 'rocket' },
  noAttachments: { horizon: 'land', moment: 'noon', planetAt: { x: 112 }, props: [at('envelope', 56)] },
  noNotes: { horizon: 'desk', moment: 'golden', props: [at('book', 56), at('lantern', 80)], accent: 'lantern' },
  noAutomations: { horizon: 'ridge', moment: 'night', props: [at('windmill', 108)] },
  invitePeople: { horizon: 'land', moment: 'golden', props: [at('bench', 60), at('tree', 84)] },
  notAllowed: { horizon: 'land', moment: 'noon', planetAt: { x: 112 }, props: [at('lock', 58)] },
  connectAccount: { horizon: 'land', moment: 'rising', planetAt: { x: 116 }, props: [at('key', 60)] },
  noTerminal: { horizon: 'desk', moment: 'noon', planetAt: { x: 114 }, props: [at('prompt', 56)], accent: 'prompt' },
  archiveEmpty: { horizon: 'land', moment: 'golden', props: [at('crate', 56)] },
  handoff: { horizon: 'orbit', moment: 'noon', planet: 'paired', planetAt: { x: 46, y: 30 }, props: [at('plane', 82, { ground: 40 })] },
  treeClean: { horizon: 'ridge', moment: 'noon', planetAt: { x: 116 }, props: [at('tree', 56)] },
  notificationsOff: { horizon: 'sea', moment: 'dusk', props: [at('beacon', 60)] },
  exploring: { horizon: 'sea', moment: 'golden', props: [at('boat', 60), at('buoy', 86, { ground: 49 })], accent: 'buoy' },
  ideas: { horizon: 'field', moment: 'noon', planetAt: { x: 120 }, props: [at('kite', 60)], accent: 'kite' },
  manyHomes: { horizon: 'land', moment: 'noon', planet: 'homes' },
});

/** Every built-in scene id, in the library gallery's order. */
export const HAPPIER_SCENE_IDS: readonly HappierSceneId[] = Object.freeze(Object.keys(BUILT_IN_SCENES) as HappierSceneId[]);
/** Every catalog prop id. */
export const HAPPIER_SCENE_PROP_IDS: readonly HappierScenePropId[] = Object.freeze(Object.keys(PROPS) as HappierScenePropId[]);

export function isHappierSceneId(value: unknown): value is HappierSceneId {
  return typeof value === 'string' && Object.hasOwn(BUILT_IN_SCENES, value);
}

// ─── definitions and resolution ───────────────────────────────────────────────────────────────────

const DASHES: Readonly<Record<HappierSceneDash, string>> = Object.freeze({ dotted: '0 3.2', dashed: '2.2 2.6' });

/** A plugin's mark: the shape and tone are the plugin's, the look is the host's. */
function resolveMark(mark: HappierSceneMark): HappierResolvedSceneMark {
  const tone: Tone = mark.accent ? 'accent' : mark.tone ?? 'ink';
  const extra: MarkExtra = mark.dash ? { dash: DASHES[mark.dash] } : {};
  switch (mark.shape) {
    case 'path': return path(mark.d, tone, extra);
    case 'circle': return circle(mark.cx, mark.cy, mark.r, tone, { ...extra, filled: mark.filled });
    case 'rect': return rect(mark.x, mark.y, mark.width, mark.height, mark.radius ?? 0.8, tone, extra);
    case 'ellipse': return ellipse(mark.cx, mark.cy, mark.rx, mark.ry, mark.rotate ?? 0, tone, extra);
  }
}

/** The scene's one accent: the named prop keeps its accent detail; every other accent is ink. */
function inkAccent(mark: HappierResolvedSceneMark): HappierResolvedSceneMark {
  return mark.tone === 'accent' ? { ...mark, tone: 'ink' } : mark;
}

function resolveProp(placement: HappierScenePropPlacement, ground: number, accent: string | undefined): HappierResolvedSceneLayer {
  const definition = typeof placement.prop === 'string' ? PROPS[placement.prop] : null;
  if (typeof placement.prop === 'string' && !definition) throw new TypeError(`Unknown scene prop "${placement.prop}".`);
  const name = typeof placement.prop === 'string' ? placement.prop : placement.prop.name;
  const marks = definition ? definition.marks : (placement.prop as HappierScenePropDefinition).marks.map(resolveMark);
  const float = definition ? definition.float : (placement.prop as HappierScenePropDefinition).float ?? 0;
  const scale = placement.scale ?? 1;
  return {
    name,
    x: placement.x,
    y: f2((placement.ground ?? ground) - float * scale),
    scale,
    flip: placement.flip === true,
    front: true,
    marks: accent === name ? marks : marks.map(inkAccent),
  };
}

/** Define a reusable prop of a plugin's own, placed in scenes like any catalog prop. */
export function defineHappierSceneProp(definition: HappierScenePropDefinition): HappierScenePropDefinition {
  if (typeof definition.name !== 'string' || definition.name.trim() === '') throw new TypeError('A scene prop needs a name.');
  return Object.freeze({ ...definition, marks: Object.freeze([...definition.marks]) });
}

/** Define a named scene for a plugin's own state; pass the result as a state's `scene`. */
export function defineHappierScene(definition: HappierSceneDefinition): HappierSceneDefinition {
  if (typeof definition.name !== 'string' || definition.name.trim() === '') throw new TypeError('A scene needs a name.');
  if (definition.base !== undefined && !isHappierSceneId(definition.base)) throw new TypeError(`Scene "${definition.name}" names an unknown base scene.`);
  if (definition.moment !== undefined && !Object.hasOwn(MOMENTS, definition.moment)) throw new TypeError(`Scene "${definition.name}" names an unknown moment.`);
  return Object.freeze({ ...definition });
}

/** The composition behind an id or definition: a base scene's parts, replaced and extended by the definition's. */
function compose(input: HappierSceneInput): HappierSceneComposition {
  if (typeof input === 'string') {
    if (!isHappierSceneId(input)) throw new TypeError(`Unknown scene "${String(input)}".`);
    return BUILT_IN_SCENES[input];
  }
  if (input.base === undefined) return input;
  const base = BUILT_IN_SCENES[input.base];
  return {
    ...base,
    ...input,
    props: [...(base.props ?? []), ...(input.props ?? [])],
    sky: [...(base.sky ?? []), ...(input.sky ?? [])],
  };
}

/**
 * The drawable scene for an id or a definition at a size: the one place a scene is resolved and the
 * composition rules are applied.
 */
export function resolveHappierScene(input: HappierSceneInput, size: HappierSceneArtSize = 'pane'): HappierResolvedScene {
  const scene = compose(input);
  const tier = HAPPIER_SCENE_ART_METRICS[size].tier;
  const moment = MOMENTS[scene.moment ?? 'rising'];
  const planet = scene.planet === false || !moment.planet ? null : { ...moment.planet, ...scene.planetAt };
  const ground = scene.ground ?? GROUND;
  const context: SceneContext = { y: ground, px: planet?.x ?? 80, detail: HAPPIER_SCENE_RULES.detail[tier] };
  // Sky marks drop before props; a moment's own sky (the stars of night) is kept one longer.
  const skyMarks = [...(moment.sky ?? []), ...(scene.sky ?? [])]
    .slice(0, HAPPIER_SCENE_RULES.sky[tier] + (moment.sky ? 1 : 0))
    .filter((mark, index, all) => all.indexOf(mark) === index);
  const planets = resolvePlanets(planet, typeof scene.planet === 'string' ? scene.planet : 'resting', ground);
  return {
    name: typeof input === 'string' ? input : input.name,
    layers: [
      ...skyMarks.map((mark) => SKY[mark](context)),
      ...HORIZONS[scene.horizon ?? 'sea'](context),
      ...(planets.marks.length ? [layer('planet', planets.marks)] : []),
      ...(scene.props ?? []).slice(0, HAPPIER_SCENE_RULES.maxProps[tier]).map((placement) => resolveProp(placement, ground, scene.accent)),
    ],
    planets: planets.planets,
  };
}
