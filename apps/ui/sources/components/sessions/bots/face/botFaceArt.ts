/**
 * Living Bot artwork: the bodies, colours and pixel sprites of the R6 shipped set
 * (`.happier/design-lab/living-bots/DECISIONS-R6.md`, engines `lb2-engine.js` + `lb3-engine.js`).
 *
 * These are artwork coordinates in the logo's 90-unit source space, ported verbatim from the lab; they are art, not
 * operational limits. Every body keeps the Happier logo's top (its 90-unit width and the centre notch). Geometry
 * (signed distance fields) lives in `botFaceGeometry.ts`; drawing in `botFaceRaster.ts` and `botFaceScene.ts`.
 */
import { PLANET_PALETTES } from '@happier-dev/brand/planet';
import {
  BotFaceBodySchema,
  BotFacePaletteSchema,
  type BotFaceBody,
  type BotFaceBodyArt,
  type BotFacePalette,
} from '@happier-dev/protocol/sessions/identity/sessionBotV1';

export type BotFaceRgb = readonly [number, number, number];
export type BotFaceTheme = 'light' | 'dark';

export type { BotFaceBodyArt };

const TOP =
  'M0,15 C0,6.716 6.716,0 15,0 L28.359,0 C30.703,0 32.109,1.406 32.109,3.75 L32.109,22.734 C32.109,29.766 32.578,30.469 37.734,30.469 L52.266,30.469 C57.891,30.469 57.891,29.063 57.891,22.031 L57.891,3.75 C57.891,1.406 59.297,0 61.641,0 L75,0 C83.284,0 90,6.716 90,15';
const NOTCH_CUT =
  'M32.109,-12 L32.109,25.5 C32.109,29.766 33.578,30.469 37.734,30.469 L52.266,30.469 C56.391,30.469 57.891,29.063 57.891,25.5 L57.891,-12 Z';
const T = (rest: string) => TOP + rest;
const headR = (yb: number, r: number) =>
  `L90,${yb - r} A${r},${r} 0 0 1 ${90 - r},${yb} L${r},${yb} A${r},${r} 0 0 1 0,${yb - r} Z`;
const circ = (cx: number, cy: number, r: number) =>
  `M${cx - r},${cy} a${r},${r} 0 1 0 ${2 * r},0 a${r},${r} 0 1 0 ${-2 * r},0 Z`;
const ell = (cx: number, cy: number, rx: number, ry: number) =>
  `M${cx - rx},${cy} a${rx},${ry} 0 1 0 ${2 * rx},0 a${rx},${ry} 0 1 0 ${-2 * rx},0 Z`;
const rr = (x: number, y: number, w: number, h: number, r: number) =>
  `M${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} L${x + r},${y + h} Q${x},${y + h} ${x},${y + h - r} L${x},${y + r} Q${x},${y} ${x + r},${y} Z`;
/** Mirror a path about the body's centre line (x → 90 − x). */
const mx = (p: string) =>
  p.replace(
    /(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g,
    (_, x: string, y: string) => `${+(90 - +x).toFixed(3)},${y}`,
  );
const both = (p: string, w: number): (readonly [string, number])[] => [
  [p, w],
  [mx(p), w],
];
const GHOST = T(
  'L90,84 A15,15 0 0 1 60,84 A15,15 0 0 1 30,84 A15,15 0 0 1 0,84 Z',
);

/** The Planet style's body: the moon circle with the logo notch. */
export const BOT_FACE_MOON: BotFaceBodyArt = {
  fill: ['M45,1 A46,46 0 1 1 44.99,1 Z'],
  cut: [NOTCH_CUT],
  mouth: [45, 55, 0.98],
};

/** Round 3's rosters (lab `B3` + the round-2 bodies they keep), in roster order. */
/**
 * The protocol's `BotFaceBodySchema` owns which bodies a Bot may choose; every id it lists must have art here (checked
 * at compile time below). Round-3 roster bodies beyond that list stay ready for the roster's widening.
 */
const BODY_ART = {
  // Invaders
  crab: {
    fill: [T(headR(66, 14))],
    stroke: [
      ...both('M4,40 C-12,40 -22,32 -22,20', 15),
      ...both('M-22,20 L-29,9', 12),
      ...both('M-22,20 L-13,8', 12),
      ...both('M20,62 L11,84', 14),
      ...both('M38,64 L35,86', 14),
    ],
    mouth: [45, 46, 0.86],
  },
  squid: {
    fill: [T(headR(62, 16))],
    stroke: [
      ...both('M12,56 C8,72 0,80 3,96', 14),
      ...both('M30,60 C30,78 24,88 27,104', 14),
      ['M45,60 L45,108', 14],
    ],
    mouth: [45, 45, 0.84],
  },
  octopus: {
    fill: [
      T(
        'L90,36 C100,46 106,56 106,66 C106,72 102,74 96,74 L-6,74 C-12,74 -16,72 -16,66 C-16,56 -10,46 0,36 Z',
      ),
    ],
    stroke: [
      ...both('M-6,70 C-14,80 -16,92 -6,98', 14),
      ...both('M16,72 C14,86 8,94 12,104', 14),
      ...both('M35,72 C35,88 31,96 35,108', 14),
    ],
    mouth: [45, 49, 0.92],
  },
  ufo: {
    fill: [T(headR(50, 12)), ell(45, 58, 64, 16)],
    stroke: [...both('M16,68 L6,86', 13)],
    mouth: [45, 40, 0.66],
  },
  specter: {
    fill: [GHOST],
    stroke: [...both('M3,50 C-10,52 -16,60 -18,70', 14)],
    mouth: [45, 52, 0.96],
  },
  ghost: { fill: [GHOST], mouth: [45, 52.5, 0.96] },
  // Critters
  beetle: {
    fill: [
      T('L90,56 C90,84 70,98 45,98 C20,98 0,84 0,56 Z'),
      circ(-10, -15, 9),
      circ(100, -15, 9),
    ],
    stroke: [
      ...both('M12,6 C6,-6 0,-10 -10,-15', 11),
      ...both('M4,52 L-14,46', 13),
      ...both('M2,68 L-16,70', 13),
      ...both('M10,84 L-6,96', 13),
    ],
    mouth: [45, 54, 0.95],
  },
  spider: {
    fill: [T(headR(68, 18))],
    stroke: [
      ...both('M2,34 L-16,22 L-28,40', 12),
      ...both('M2,48 L-20,46 L-30,66', 12),
      ...both('M8,62 L-12,68 L-20,90', 12),
    ],
    mouth: [45, 46, 0.86],
  },
  jelly: {
    fill: [T('L90,52 C90,60 84,64 76,64 L14,64 C6,64 0,60 0,52 Z')],
    stroke: [
      ...both('M14,60 C8,76 20,86 12,100 C8,108 14,116 12,122', 12),
      ...both('M34,62 C30,78 40,90 34,104 C30,112 34,118 32,124', 12),
    ],
    mouth: [45, 44, 0.8],
  },
  hopper: {
    fill: [
      T('L90,54 C90,64 84,68 76,68 L14,68 C6,68 0,64 0,54 Z'),
      ell(4, 75, 18, 8),
      ell(86, 75, 18, 8),
    ],
    stroke: [...both('M10,58 C-8,54 -14,66 -6,72', 14)],
    mouth: [45, 44, 0.8],
  },
  pup: {
    fill: [T(headR(70, 14))],
    stroke: [
      ...both('M14,66 L12,88', 15),
      ...both('M32,68 L32,88', 15),
      ['M88,48 C104,44 110,30 104,18', 12],
    ],
    mouth: [45, 47, 0.88],
  },
  drone: {
    fill: [T(headR(70, 14)), ell(-17, 4, 17, 6), ell(107, 4, 17, 6)],
    stroke: [...both('M4,26 L-17,6', 12)],
    mouth: [45, 47, 0.88],
  },
  // Robots and rockets
  robot: {
    fill: [
      T('L90,74 C90,78 88,80 84,80 L6,80 C2,80 0,78 0,74 Z'),
      rr(-11, 32, 13, 24, 3),
      rr(88, 32, 13, 24, 3),
      circ(-16, 96, 9),
      circ(106, 96, 9),
    ],
    stroke: [...both('M-3,60 C-13,68 -17,80 -16,92', 14)],
    mouth: [45, 52, 0.92],
  },
  walker: {
    fill: [T(headR(62, 12)), rr(8, 86, 32, 12, 5), rr(50, 86, 32, 12, 5)],
    stroke: [...both('M24,58 L24,90', 17)],
    mouth: [45, 44, 0.84],
  },
  rocket: {
    fill: [
      T('L90,96 C90,106 82,112 72,112 L18,112 C8,112 0,106 0,96 Z'),
      'M0,66 L-20,102 Q-23,112 -12,112 L0,112 Z',
      'M90,66 L110,102 Q113,112 102,112 L90,112 Z',
      'M31,110 C31,122 40,130 45,140 C50,130 59,122 59,110 Z',
    ],
    mouth: [45, 55.3, 1],
  },
  feet: {
    fill: [T('L90,70 C90,77.5 85,81 78,81 L12,81 C5,81 0,77.5 0,70 Z')],
    stroke: [
      ['M25,80 L25,92 L19,92', 9],
      ['M65,80 L65,92 L71,92', 9],
    ],
    mouth: [45, 50, 0.92],
  },
  tail: {
    fill: [T('L90,68 C90,82 80,88 66,88 L24,88 C10,88 0,82 0,68 Z')],
    stroke: [['M78,80 C90,90 103,84 102,72 C101.5,66 96,64 93,68', 8]],
    mouth: [43, 50, 0.92],
  },
  drip: {
    fill: [
      T(
        'L90,75 C90,83.284 83.284,90 75,90 L63,90 C58.5,90 57.5,92.5 57.5,97 C57.5,103.5 53.5,107 49,107 C44.5,107 41,103.5 41,98.5 C41,93 39,90 34,90 L15,90 C6.716,90 0,83.284 0,75 Z',
      ),
    ],
    mouth: [45, 53.5, 0.96],
  },
  // Code creatures
  bracelegs: {
    fill: [T(headR(64, 14))],
    stroke: [
      ...both(
        'M31,60 C21,60 22,68 22,74 C22,80 20,82 12,82 C20,82 22,84 22,90 C22,96 21,104 31,104',
        13,
      ),
    ],
    mouth: [45, 46, 0.86],
  },
  tagclaws: {
    fill: [T(headR(76, 14))],
    stroke: [...both('M2,32 L-22,52 L2,72', 14), ['M66,100 L80,72', 13]],
    mouth: [45, 50, 0.92],
  },
  cursortail: {
    fill: [T(headR(70, 14)), rr(92, 100, 17, 25, 2)],
    stroke: [['M80,64 C96,72 104,84 100,102', 12]],
    mouth: [45, 47, 0.88],
  },
  termbody: {
    fill: [
      TOP +
        'L90,22 L106,22 C110,22 112,24 112,28 L112,86 C112,90 110,92 106,92 L-16,92 C-20,92 -22,90 -22,86 L-22,28 C-22,24 -20,22 -16,22 L0,22 Z',
    ],
    cut: [['M-13,38 L103,38', 3.6]],
    stroke: [...both('M8,90 L6,104', 14)],
    mouth: [45, 62, 1.0],
  },
  antlers: {
    fill: [
      T(headR(80, 16)),
      circ(14, -26, 8),
      circ(-5, -25, 8),
      circ(76, -26, 8),
      circ(95, -25, 8),
    ],
    stroke: [
      ...both('M14,6 L14,-26', 12),
      ...both('M14,-4 C14,-14 -3,-12 -5,-25', 11),
    ],
    mouth: [45, 52, 0.95],
  },
  semi: {
    fill: [T(headR(68, 14)), circ(45, 80, 12)],
    stroke: [['M52,88 C54,100 48,110 37,116', 12]],
    mouth: [45, 46, 0.86],
  },
  brackets: {
    fill: [T(headR(74, 14))],
    stroke: [...both('M2,26 L-16,26 L-16,70 L2,70', 13)],
    mouth: [45, 50, 0.92],
  },
  cursor: {
    fill: [T('L90,68 C90,75 85,78 79,78 L11,78 C5,78 0,75 0,68 Z')],
    stroke: [['M5,92 L85,92', 9]],
    mouth: [45, 49, 0.9],
  },
  // Tall, wide, tiny
  bean: {
    fill: [T('L90,42 C90,50 85,54 76,54 L14,54 C5,54 0,50 0,42 Z')],
    stroke: [...both('M26,50 L24,62', 14)],
    mouth: [45, 41.5, 0.6],
  },
  squat: {
    fill: [T('L90,56 C90,65 84,70 75,70 L15,70 C6,70 0,65 0,56 Z')],
    mouth: [45, 45.5, 0.8],
  },
  bag: {
    fill: [
      T('L90,75 C90,83.284 83.284,90 75,90 L15,90 C6.716,90 0,83.284 0,75 Z'),
    ],
    mouth: [45, 55.3, 1],
  },
  loaf: {
    fill: [
      TOP +
        'L90,30 C104,30 116,40 116,56 L116,64 C116,76 108,82 96,82 L-6,82 C-18,82 -26,76 -26,64 L-26,56 C-26,40 -14,30 0,30 Z',
    ],
    mouth: [45, 54, 1.12],
  },
  puddle: {
    fill: [
      T(
        'L90,50 C90,60 96,64 106,68 C114,72 112,82 102,82 L-12,82 C-22,82 -24,72 -16,68 C-6,64 0,60 0,50 Z',
      ),
    ],
    mouth: [45, 49, 0.9],
  },
  tower: {
    fill: [T('L90,104 C90,112 84,116 76,116 L14,116 C6,116 0,112 0,104 Z')],
    stroke: [...both('M24,114 L24,128 L16,128', 13)],
    mouth: [45, 55.3, 1],
  },
  stilts: {
    fill: [T(headR(66, 14)), rr(6, 124, 28, 9, 4), rr(56, 124, 28, 9, 4)],
    stroke: [...both('M26,60 L21,126', 14)],
    mouth: [45, 46, 0.88],
  },
  tall: {
    fill: [T('L90,108 C90,118 82,124 72,124 L18,124 C8,124 0,118 0,108 Z')],
    mouth: [45, 55.3, 1],
  },
  // R8: the logo's two top lobes drawn up into big pointed ears (the notch is the dip between them), a compact
  // head-and-body, two paws and a short thick tail. Mouth only.
  cat: {
    fill: [
      'M0,34 L8,-16 Q12,-26 18,-18 L40,20 Q42,24 45,24 Q48,24 50,20 L72,-18 Q78,-26 82,-16 L90,34 L90,62 C90,72 84,78 74,78 L16,78 C6,78 0,72 0,62 Z',
      ell(22, 80, 13, 7),
      ell(68, 80, 13, 7),
    ],
    stroke: [['M84,68 C104,68 110,52 103,38', 18]],
    mouth: [45, 54, 0.86],
  },
} as const satisfies Record<string, BotFaceBodyArt>;

export type BotFaceBodyId = BotFaceBody;
export const BOT_FACE_BODIES: Readonly<Record<BotFaceBodyId, BotFaceBodyArt>> = BODY_ART;
/** Choosable bodies, in the protocol catalog's order. */
export const BOT_FACE_BODY_IDS: readonly BotFaceBodyId[] = BotFaceBodySchema.options;

/**
 * Limb poses (lab R3 `ALT`): the same body with its limbs moved. Dither and Solid heroes morph to them through the
 * distance field — working alternates with a step, needs you holds the alternate (claws up, a wave). Not choosable bodies.
 */
const MORPH_ART = {
  'crab~up': { fill: [T(headR(66, 14))], stroke: [...both('M4,40 C-14,34 -22,22 -20,4', 15), ...both('M-20,4 L-30,-6', 12), ...both('M-20,4 L-8,-8', 12), ...both('M20,62 L11,84', 14), ...both('M38,64 L35,86', 14)], mouth: [45, 46, 0.86] },
  'crab~step': { fill: [T(headR(66, 14))], stroke: [...both('M4,40 C-12,42 -22,36 -24,24', 15), ...both('M-24,24 L-31,14', 12), ...both('M-24,24 L-15,13', 12), ['M20,62 L16,86', 14], ['M70,62 L74,86', 14], ['M38,64 L30,84', 14], ['M52,64 L60,84', 14]], mouth: [45, 46, 0.86] },
  'robot~wave': { fill: [T('L90,74 C90,78 88,80 84,80 L6,80 C2,80 0,78 0,74 Z'), rr(-11, 32, 13, 24, 3), rr(88, 32, 13, 24, 3), circ(-20, 2, 9), circ(106, 96, 9)], stroke: [['M-3,44 C-14,36 -20,24 -20,8', 14], [mx('M-3,60 C-13,68 -17,80 -16,92'), 14]], mouth: [45, 52, 0.92] },
  'robot~step': { fill: [T('L90,74 C90,78 88,80 84,80 L6,80 C2,80 0,78 0,74 Z'), rr(-11, 32, 13, 24, 3), rr(88, 32, 13, 24, 3), circ(-20, 90, 9), circ(110, 90, 9)], stroke: [['M-3,60 C-14,66 -20,76 -20,86', 14], [mx('M-3,60 C-14,66 -20,76 -20,86'), 14]], mouth: [45, 52, 0.92] },
  'octopus~spread': { fill: [T('L90,36 C100,46 106,56 106,66 C106,72 102,74 96,74 L-6,74 C-12,74 -16,72 -16,66 C-16,56 -10,46 0,36 Z')], stroke: [...both('M-6,70 C-20,74 -28,82 -26,94', 14), ...both('M16,72 C8,84 0,90 -2,102', 14), ...both('M35,72 C33,88 26,96 24,108', 14)], mouth: [45, 49, 0.92] },
  'jelly~pulse': { fill: [T('L90,48 C92,58 96,62 96,66 L-6,66 C-6,62 -2,58 0,48 Z')], stroke: [...both('M12,62 C4,76 12,86 2,98 C-2,104 2,110 0,114', 12), ...both('M34,64 C28,78 36,88 28,100 C24,108 28,112 26,116', 12)], mouth: [45, 44, 0.8] },
  'walker~step': { fill: [T(headR(62, 12)), rr(0, 84, 32, 12, 5), rr(50, 86, 32, 12, 5)], stroke: [['M24,58 L16,88', 17], [mx('M24,58 L24,90'), 17]], mouth: [45, 44, 0.84] },
  'squid~curl': { fill: [T(headR(62, 16))], stroke: [...both('M12,56 C2,66 -6,80 6,94', 14), ...both('M30,60 C24,76 30,92 22,104', 14), ['M45,60 C45,80 52,92 45,108', 14]], mouth: [45, 45, 0.84] },
} as const satisfies Record<string, BotFaceBodyArt>;
export type BotFaceMorphId = keyof typeof MORPH_ART;
export const BOT_FACE_MORPH_ART: Readonly<Record<BotFaceMorphId, BotFaceBodyArt>> = MORPH_ART;
/** Which limb pose a body's working and needs-you moments morph to (lab `MORPH`); bodies without one stay rigid. */
export const BOT_FACE_MORPHS: Readonly<Partial<Record<BotFaceBodyId, Readonly<{ working: BotFaceMorphId; needsYou: BotFaceMorphId }>>>> = {
  crab: { working: 'crab~step', needsYou: 'crab~up' },
  robot: { working: 'robot~step', needsYou: 'robot~wave' },
  octopus: { working: 'octopus~spread', needsYou: 'octopus~spread' },
  jelly: { working: 'jelly~pulse', needsYou: 'jelly~pulse' },
  walker: { working: 'walker~step', needsYou: 'walker~step' },
  squid: { working: 'squid~curl', needsYou: 'squid~curl' },
};

/**
 * List hinting (18–32 px): a body with limbs is drawn with ~1.6× thicker strokes so claws, legs and antennae survive at
 * 18 px. The lab uses the hinted body for every list form and for the round-4/R6 heroes (Solid, Dots) too.
 */
export function hintBody(body: BotFaceBodyArt): BotFaceBodyArt {
  return body.stroke
    ? {
        ...body,
        stroke: body.stroke.map(
          ([p, w]) => [p, Math.min(24, w * 1.6)] as const,
        ),
      }
    : body;
}

/* ═══ colours: stops top → bottom, so a body reads lit from above. Daybreak is the Brand planet's own palette. ═══ */
type Stops = readonly (readonly [number, BotFaceRgb])[];
const hex = (h: string): BotFaceRgb => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];
const st = (...hs: string[]): Stops =>
  hs.map((h, i) => [i / (hs.length - 1), hex(h)] as const);
const fixed = (stops: Stops) => () => stops;

export const BOT_FACE_COLOURS = {
  daybreak: {
    stops: (theme: BotFaceTheme): Stops => PLANET_PALETTES[theme].body as Stops,
  },
  lagoon: {
    stops: fixed(st('#C8FFF1', '#55D9CB', '#1FA6CF', '#2357C2', '#1A2F86')),
  },
  orchid: {
    stops: fixed(st('#FFD3EE', '#F17CC9', '#B451E0', '#6A3FD6', '#2E2A93')),
  },
  aurora: {
    stops: fixed(st('#F1FFB0', '#8EE59A', '#33BFAE', '#2F7FD0', '#2E3DA6')),
  },
  indigo: {
    stops: fixed(st('#D5DAFF', '#8E98FF', '#5C63E8', '#3A3CB8', '#22216E')),
  },
  glacier: {
    stops: fixed(st('#FFFFFF', '#D6EEFF', '#86BDF7', '#4C7FE0', '#2C49A8')),
  },
  moss: {
    stops: fixed(st('#F3FFC7', '#B7E07A', '#62B072', '#2F8172', '#1D4F5A')),
  },
  sand: {
    stops: fixed(st('#FFF6D8', '#F6D88A', '#DDA75A', '#A8733E', '#6B4A2E')),
  },
  ink: {
    stops: (theme: BotFaceTheme): Stops =>
      theme === 'dark'
        ? st('#FFFFFF', '#F1EFEA', '#D9D6CF', '#B9B5AD')
        : st('#6A6674', '#3B3843', '#25232B', '#18171C'),
  },
} as const satisfies Record<
  BotFacePalette,
  Readonly<{ stops: (theme: BotFaceTheme) => Stops }>
>;

export type BotFaceColourId = BotFacePalette;
/** Choosable colours, in the protocol catalog's order. */
export const BOT_FACE_COLOUR_IDS: readonly BotFaceColourId[] = BotFacePaletteSchema.options;

/** A colour along a palette's stops (0 = top/lit, 1 = bottom/deep). */
export function botFaceGradient(
  stops: Stops,
  t: number,
): [number, number, number] {
  const x = Math.min(1, Math.max(0, t));
  for (let i = 1; i < stops.length; i++) {
    const [tb, b] = stops[i];
    const [ta, a] = stops[i - 1];
    if (x <= tb) {
      const u = (x - ta) / (tb - ta || 1);
      return [
        a[0] + (b[0] - a[0]) * u,
        a[1] + (b[1] - a[1]) * u,
        a[2] + (b[2] - a[2]) * u,
      ];
    }
  }
  const last = stops[stops.length - 1][1];
  return [last[0], last[1], last[2]];
}

/* ═══ Pixel: 12-wide sprites (32 px and heroes) and 8-wide micro sprites (18–24 px). Locked art (lab `SP`, `MI`). ═══ */
export const PIXEL_HEAD12 = [
  '.XXX....XXX.',
  'XXXX....XXXX',
  'XXXX....XXXX',
  'XXXX....XXXX',
  'XXXXXXXXXXXX',
  'XXXXXXXXXXXX',
  'XXXXXXXXXXXX',
];
export const PIXEL_FACE12 = {
  quiet: ['XX.XXXXXX.XX', 'XXX......XXX', 'XXXXXXXXXXXX'],
  working: ['XXXXXXXXXXXX', 'XX..X..X..XX', 'XXXXXXXXXXXX'],
  needsYou: ['XXXXX..XXXXX', 'XXXX.XX.XXXX', 'XXXXX..XXXXX'],
  done: ['X.XXXXXXXX.X', 'XX........XX', 'XXX......XXX'],
  failed: ['XXXXXXXXXXXX', 'XXXXXXXXXXXX', 'XXXX....XXXX'],
};
export const PIXEL_HEAD8 = ['.XX..XX.', 'XXX..XXX', 'XXXXXXXX'];
export const PIXEL_FACE8 = {
  quiet: ['X.XXXX.X', 'XX....XX'],
  working: ['XXXXXXXX', 'X.X.X.XX'],
  needsYou: ['XXX..XXX', 'XXX..XXX'],
  done: ['X.XXXX.X', 'X......X'],
  failed: ['XXXXXXXX', 'XXX..XXX'],
};
/**
 * The mutter's three steps of the working "…" (lab R9): one dot raised a sprite pixel at a time. An 8-wide sprite cannot
 * centre three single holes, so its dots sit half a sprite pixel left of centre.
 */
export const PIXEL_MUTTER12: readonly (readonly string[])[] = [
  ['XX..XXXXXXXX', 'XXXXX..X..XX', 'XXXXXXXXXXXX'],
  ['XXXXX..XXXXX', 'XX..XXXX..XX', 'XXXXXXXXXXXX'],
  ['XXXXXXXX..XX', 'XX..X..XXXXX', 'XXXXXXXXXXXX'],
];
export const PIXEL_MUTTER8: readonly (readonly string[])[] = [
  ['X.XXXXXX', 'XXX.X.XX'],
  ['XXX.XXXX', 'X.XXX.XX'],
  ['XXXXX.XX', 'X.X.XXXX'],
];
export const PIXEL_BODY8 = ['XXXXXXXX'];

type Sprite12 = Readonly<{
  W: number;
  ox?: number;
  body: readonly string[];
  below: readonly (readonly string[])[];
  above?: readonly (readonly string[])[];
  over?: readonly Readonly<Record<number, string>>[];
  alt?: readonly string[];
}>;
type Sprite8 = Readonly<{
  W: number;
  ox?: number;
  below?: readonly string[];
  above?: readonly string[];
  over?: Readonly<Record<number, string>>;
}>;

export const PIXEL_SPRITES12: Readonly<Record<string, Sprite12>> = {
  bag: { W: 12, body: ['XXXXXXXXXXXX', '.XXXXXXXXXX.'], below: [[]] },
  crab: {
    W: 18,
    ox: 3,
    body: ['XXXXXXXXXXXX', '.XXXXXXXXXX.'],
    over: [
      {
        0: 'XX..............XX',
        1: 'X................X',
        2: 'XX..............XX',
        3: '.XX............XX.',
        4: '..X............X..',
      },
      {
        0: 'X.X............X.X',
        1: 'X................X',
        2: 'XX..............XX',
        3: '.XX............XX.',
        4: '..X............X..',
      },
    ],
    below: [
      ['....X.X....X.X....', '...X...X..X...X...'],
      ['.....X.X..X.X.....', '....X..X..X..X....'],
    ],
  },
  squid: {
    W: 12,
    body: ['XXXXXXXXXXXX'],
    below: [
      ['XX.XX..XX.XX', 'X..X....X..X', '.X..X..X..X.'],
      ['XX.XX..XX.XX', '.X..X..X..X.', 'X..X....X..X'],
    ],
  },
  octopus: {
    W: 16,
    ox: 2,
    body: ['XXXXXXXXXXXX'],
    over: [
      { 8: '.X............X.', 9: 'XX............XX', 10: 'XX............XX' },
    ],
    below: [
      ['XX.XX.XXXX.XX.XX', 'X..X..X..X..X..X', '.X..X......X..X.'],
      ['XX.XX.XXXX.XX.XX', '.X..X..XX..X..X.', 'X..X........X..X'],
    ],
  },
  ufo: {
    W: 18,
    ox: 3,
    body: ['XXXXXXXXXXXX', '.XXXXXXXXXX.'],
    over: [
      {
        9: '..XXXXXXXXXXXXXX..',
        10: 'XXFXXXFXXXXFXXXFXX',
        11: '.XXXXXXXXXXXXXXXX.',
      },
      {
        9: '..XXXXXXXXXXXXXX..',
        10: 'XXXFXXXFXXXXFXXXFX',
        11: '.XXXXXXXXXXXXXXXX.',
      },
    ],
    below: [['....X........X....'], ['....X........X....']],
  },
  specter: {
    W: 16,
    ox: 2,
    body: ['XXXXXXXXXXXX', 'XXXXXXXXXXXX', 'XX.XXX.XXX.X', 'X...X...X...'],
    over: [
      { 8: 'X..............X', 9: 'XX............XX' },
      { 9: 'X..............X', 10: 'XX............XX' },
    ],
    below: [[]],
  },
  beetle: {
    W: 16,
    ox: 2,
    body: ['XXXXXXXXXXXX', 'XXXXXXXXXXXX', '.XXXXXXXXXX.', '..XXXXXXXX..'],
    above: [
      ['.X............X.', '..X..........X..'],
      ['X..............X', '.XX..........XX.'],
    ],
    over: [
      { 9: 'XX............XX', 11: 'XX............XX', 13: '.X............X.' },
      {
        10: 'XX............XX',
        12: 'XX............XX',
        13: 'X..............X',
      },
    ],
    below: [[]],
  },
  jelly: {
    W: 12,
    body: ['XXXXXXXXXXXX', '.XXXXXXXXXX.'],
    below: [
      ['.X..X..X..X.', 'X..X..X..X..', '.X..X..X..X.', '..X..X..X..X'],
      ['..X..X..X..X', '.X..X..X..X.', 'X..X..X..X..', '.X..X..X..X.'],
    ],
  },
  robot: {
    W: 16,
    ox: 2,
    body: ['XXXXXXXXXXXX', 'XXXXXXXXXXXX'],
    over: [
      {
        4: '.X............X.',
        5: 'XX............XX',
        6: '.X............X.',
        9: '.X............X.',
        10: 'X..............X',
        11: 'X..............X',
      },
      {
        4: '.X............X.',
        5: 'XX............XX',
        6: '.X............X.',
        2: 'X...............',
        3: 'X...............',
        9: '.X............X.',
        8: 'X...............',
        10: '...............X',
        11: '...............X',
      },
    ],
    below: [
      ['...XX......XX...', '..XXX......XXX..'],
      ['...XX......XX...', '..XXX......XXX..'],
    ],
  },
  rocket: {
    W: 16,
    ox: 2,
    body: [
      'XXXXXXXXXXXX',
      'XXXXXXXXXXXX',
      'XXXXXXXXXXXX',
      'XXXXXXXXXXXX',
      '.XXXXXXXXXX.',
    ],
    over: [
      {
        11: '.X............X.',
        12: 'XX............XX',
        13: 'XX............XX',
        14: 'X..............X',
      },
    ],
    below: [
      ['.....FFFFFF.....', '......FFFF......', '.......FF.......'],
      ['......FFFF......', '.....FFFFFF.....', '......FFFF......'],
      ['.....FFFFFF.....', '......FFFF......', '......F..F......'],
    ],
  },
  antlers: {
    W: 16,
    ox: 2,
    body: ['XXXXXXXXXXXX', '.XXXXXXXXXX.'],
    above: [
      ['.X..X......X..X.', '..XX........XX..', '...X........X...'],
      ['X...X......X...X', '.XXX........XXX.', '...X........X...'],
    ],
    below: [[]],
  },
  bracelegs: {
    W: 12,
    body: ['XXXXXXXXXXXX', '.XXXXXXXXXX.'],
    below: [
      [
        '...XX..XX...',
        '...X....X...',
        '..X......X..',
        '...X....X...',
        '...XX..XX...',
      ],
      [
        '...XX..XX...',
        '...X....X...',
        '..X......X..',
        '...X....X...',
        '..XX....XX..',
      ],
    ],
  },
  tagclaws: {
    W: 18,
    ox: 3,
    body: ['XXXXXXXXXXXX', '.XXXXXXXXXX.'],
    over: [
      {
        5: '..X............X..',
        6: '.X..............X.',
        7: 'X................X',
        8: '.X..............X.',
        9: '..X............X..',
      },
      {
        6: '..X............X..',
        7: '.X..............X.',
        8: 'X................X',
        9: '.X..............X.',
        10: '..X............X..',
      },
    ],
    below: [
      ['............X.....', '...........X......'],
      ['............X.....', '...........X......'],
    ],
  },
  semi: {
    W: 12,
    body: ['XXXXXXXXXXXX', '.XXXXXXXXXX.'],
    below: [
      [
        '....XXXX....',
        '....XXXX....',
        '.....XXX....',
        '.....XX.....',
        '....XX......',
      ],
      [
        '....XXXX....',
        '....XXXX....',
        '.....XXX....',
        '.....XX.....',
        '.....X......',
      ],
    ],
  },
  ghost: {
    W: 12,
    body: ['XXXXXXXXXXXX', 'XXXXXXXXXXXX', 'XX.XXX.XXX.X', 'X...X...X...'],
    below: [[]],
    alt: ['XXXXXXXXXXXX', 'XXXXXXXXXXXX', 'X.XXX.XXX.XX', '...X...X...X'],
  },
  feet: {
    W: 12,
    body: ['.XXXXXXXXXX.'],
    below: [
      ['..XX....XX..', '..XX....XX..', '.XXX....XXX.'],
      ['..XX....XX..', '.XXX....XX..', '........XXX.'],
      ['..XX....XX..', '..XX....XXX.', '.XXX........'],
    ],
  },
  terminal: {
    W: 12,
    body: ['XXXXXXXXXXXX', 'XXXXXXXXXXXX'],
    over: [{ 4: 'X..........X' }],
    below: [['..XX....XX..']],
  },
  pup: {
    W: 14,
    body: ['XXXXXXXXXXXX', 'XXXXXXXXXXXX'],
    over: [
      { 5: '............X.', 6: '............XX' },
      { 4: '.............X', 5: '............XX', 6: '............X.' },
    ],
    below: [
      ['.X.X....X.X...', '.X.X....X.X...'],
      ['X..X....X..X..', 'X..X....X..X..'],
    ],
  },
  // R8 cat: the head's lobes pulled up into pointed ears (one row above the head), a short thick tail curling up.
  cat: {
    W: 14,
    above: [['X..........X..']],
    over: [{ 0: 'XXoo....ooXX', 1: '...o....o...', 8: '............XX', 9: '............XX' }],
    body: ['XXXXXXXXXXXXX.', '.XXXXXXXXXX...'],
    below: [['.XXX....XXX...']],
  },
};

export const PIXEL_SPRITES8: Readonly<Record<string, Sprite8>> = {
  bag: { W: 8, below: ['.XXXXXX.'] },
  ghost: { W: 8, below: ['XXXXXXXX', 'X.X..X.X'] },
  feet: { W: 8, below: ['.XXXXXX.', '.X....X.', 'XX....XX'] },
  crab: {
    W: 12,
    ox: 2,
    over: { 0: 'X..........X', 1: 'X..........X', 2: 'XX........XX' },
    below: ['..XXXXXXXX..', '..X.X..X.X..'],
  },
  squid: { W: 8, below: ['X.XXXX.X', '.X.XX.X.'] },
  octopus: {
    W: 10,
    ox: 1,
    over: { 5: 'X........X' },
    below: ['XXXXXXXXXX', 'X.X.XX.X.X'],
  },
  ufo: {
    W: 12,
    ox: 2,
    over: { 4: '.XXXXXXXXXX.', 5: 'XXXXXXXXXXXX' },
    below: ['..X......X..'],
  },
  specter: {
    W: 10,
    ox: 1,
    over: { 5: 'X........X' },
    below: ['.XXXXXXXX.', '.X.X..X.X.'],
  },
  beetle: {
    W: 10,
    ox: 1,
    above: ['X........X', '.X......X.'],
    over: { 5: 'X........X' },
    below: ['XXXXXXXXXX', '..XXXXXX..'],
  },
  jelly: { W: 8, below: ['X.X.X.X.', '.X.X.X.X'] },
  robot: {
    W: 10,
    ox: 1,
    over: { 2: 'X........X', 3: 'X........X' },
    below: ['.XXXXXXXX.', '..X....X..'],
  },
  rocket: { W: 10, ox: 1, below: ['.XXXXXXXX.', 'XXXXXXXXXX', 'X..FFFF..X'] },
  antlers: {
    W: 10,
    ox: 1,
    above: ['X.X....X.X', '.X......X.'],
    below: ['.XXXXXXXX.'],
  },
  bracelegs: { W: 8, below: ['.XXXXXX.', '..X..X..', '.X....X.', '..X..X..'] },
  tagclaws: {
    W: 12,
    ox: 2,
    over: { 2: '.X........X.', 3: 'X..........X', 4: '.X........X.' },
    below: ['..XXXXXXXX..'],
  },
  semi: { W: 8, below: ['.XXXXXX.', '...XX...', '...X....'] },
  terminal: { W: 8, over: { 2: 'X......X' }, below: ['XXXXXXXX', '.X....X.'] },
  pup: {
    W: 10,
    over: { 2: '........XX', 3: '........X.' },
    below: ['XXXXXXXX..', 'X.X..X.X..'],
  },
  tall: { W: 8, below: ['XXXXXXXX', 'XXXXXXXX', '.XXXXXX.'] },
  // R8 cat: pointed ears (one row above the head), a short thick tail.
  cat: {
    W: 10,
    above: ['X......X..'],
    over: { 0: 'XXo..oXX', 3: '........XX', 4: '........XX' },
    below: ['.XX..XX...'],
  },
};

/** A body without its own sprite borrows its nearest relative's (lab `SPR_OF`). */
export const PIXEL_SPRITE_OF: Readonly<Record<string, string>> = {
  drop: 'bag',
  drip: 'bag',
  pebble: 'bag',
  squat: 'bag',
  moon: 'bag',
  tall: 'tall',
  braces: 'bracelegs',
  chevrons: 'tagclaws',
  cursor: 'terminal',
  termbody: 'terminal',
  branch: 'antlers',
  semicolon: 'semi',
  tail: 'pup',
  spider: 'crab',
  hopper: 'feet',
  drone: 'ufo',
  walker: 'robot',
  stilts: 'feet',
  cursortail: 'terminal',
  brackets: 'tagclaws',
  bean: 'bag',
  loaf: 'bag',
  puddle: 'bag',
  tower: 'tall',
};
