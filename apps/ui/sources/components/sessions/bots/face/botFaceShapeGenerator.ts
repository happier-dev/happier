import { normaliseAndValidateBotFaceShape, type BotFaceShapeV1 } from '@happier-dev/protocol/sessions/identity/sessionBotFaceV1';

/** R8 parts and all artwork proportions live here, including small-size adaptation.
 * Sizes are source units in the logo's 90-wide coordinate space. The picker generates
 * once per deliberate choice; saved shapes never regenerate when rendered or resized.
 */
export const BOT_FACE_SHAPE_PARTS = {
  selection: {
    head: ['logo', 'round', 'dome', 'box', 'blob'],
    ears: ['none', 'pointed', 'round', 'long', 'antennae', 'horns'],
    limbs: ['none', 'legs', 'tentacles', 'arms', 'feet', 'wheels'],
    tail: ['none', 'none', 'curl', 'fin'],
    accessory: ['none', 'none', 'hat', 'bow', 'leaf'],
  },
  sizing: {
    defaultTargetSize: 24,
    rail: { through: 24, earReach: 1.35, appendageReach: 0.66, minimumStroke: 14, omitAccessories: ['bow', 'leaf'] },
    row: { through: 32, earReach: 1.1, appendageReach: 0.86, minimumStroke: 9, omitAccessories: [] },
    hero: { earReach: 1, appendageReach: 1, minimumStroke: 0, omitAccessories: [] },
  },
  head: {
    centre: 45, logoWidth: 90, width: [72, 18], height: [56, 22], roundRadius: 0.42, boxRadius: 10,
    bottomRadius: 14, domeRadius: 10, earTop: { logo: 0, round: 0, dome: 10, box: 0, blob: 8 },
    logoTop: 'M0,15 C0,6.716 6.716,0 15,0 L28.359,0 C30.703,0 32.109,1.406 32.109,3.75 L32.109,22.734 C32.109,29.766 32.578,30.469 37.734,30.469 L52.266,30.469 C57.891,30.469 57.891,29.063 57.891,22.031 L57.891,3.75 C57.891,1.406 59.297,0 61.641,0 L75,0 C83.284,0 90,6.716 90,15',
  },
  ears: {
    root: 0.2,
    pointed: { root: [2, 22], tip: [4, -16], curve1: [5, -20], curve2: [9, -20], curveEnd: [12, -17], inner: [0.42, 8] },
    round: { inset: 8, y: 6, radius: 13 },
    long: { root: [2, 12], tip: [-2, -30], width: 15 },
    antennae: { root: [4, 6], tip: [-6, -18], width: 6, bulb: [-7, -21, 7] },
    horns: { root: [6, 10], curve1: [-8, -2], curve2: [-8, -22], tip: [4, -28], width: 10 },
  },
  limbs: {
    legs: { inset: 0.18, y: -6, width: 13, height: 26, radius: 6 },
    feet: { inset: 0.27, y: 2, rx: 15, ry: 8 },
    wheels: { inset: 0.24, y: 4, radius: 11 },
    tentacles: { inset: 0.2, rootY: -6, curve1: [-8, 10], curve2: [8, 20], endY: 32, width: 10 },
    arms: { root: [4, 0.5], curve1: [-12, 0.62], curve2: [-16, 0.8], end: [-12, 4], width: 11 },
  },
  tail: {
    curl: { root: [-6, -6], curve1: [14, -2], curve2: [18, -22], end: [8, -30], width: 9 },
    fin: { root: [-4, 0.45], tip: [18, 0.3], end: [12, 0.75] },
  },
  accessory: {
    hat: { top: [-0.28, -22, 0.56, 22, 5], brim: [-0.4, -4, 0.8, 7, 3.5] },
    bow: { inset: 0.22, y: 2, halfWidth: 13, top: -9, bottom: 13 },
    leaf: { root: [45, 4], curve1: [44, -14], curve2: [54, -26], tip: [70, -26], curve3: [70, -10], curve4: [60, 2] },
  },
  mouth: { logoY: 0.7, otherY: 0.62, scale: [0.76, 0.16], smallerScales: [0.7, 0.6, 0.5] },
} as const;

export type BotFaceShapeParts = { [K in keyof typeof BOT_FACE_SHAPE_PARTS.selection]: typeof BOT_FACE_SHAPE_PARTS.selection[K][number] };
export type BotFaceShapeGeneratorOptions = Readonly<{ parts?: Partial<BotFaceShapeParts>; targetSize?: number }>;

function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
const f = (value: number) => +value.toFixed(1);
function roundedRect(x: number, y: number, w: number, h: number, radius: number) {
  const r = Math.min(radius, w / 2, h / 2);
  return `M${f(x + r)},${f(y)} L${f(x + w - r)},${f(y)} Q${f(x + w)},${f(y)} ${f(x + w)},${f(y + r)} L${f(x + w)},${f(y + h - r)} Q${f(x + w)},${f(y + h)} ${f(x + w - r)},${f(y + h)} L${f(x + r)},${f(y + h)} Q${f(x)},${f(y + h)} ${f(x)},${f(y + h - r)} L${f(x)},${f(y + r)} Q${f(x)},${f(y)} ${f(x + r)},${f(y)} Z`;
}
const ellipse = (x: number, y: number, rx: number, ry: number) =>
  `M${f(x - rx)},${f(y)} a${f(rx)},${f(ry)} 0 1 0 ${f(2 * rx)},0 a${f(rx)},${f(ry)} 0 1 0 ${f(-2 * rx)},0 Z`;

/** Pure authoring: returns a normalized admitted outline, with no seed, cache or frame work. */
export function generateBotFaceShape(seed: number, options: BotFaceShapeGeneratorOptions = {}): BotFaceShapeV1 {
  const table = BOT_FACE_SHAPE_PARTS;
  const r = random(Math.imul(seed, 2654435761));
  const pick = <T,>(values: readonly T[]): T => values[Math.floor(r() * values.length)];
  const parts: BotFaceShapeParts = {
    head: pick(table.selection.head), ears: pick(table.selection.ears), limbs: pick(table.selection.limbs),
    tail: pick(table.selection.tail), accessory: pick(table.selection.accessory), ...options.parts,
  };
  const size = options.targetSize ?? table.sizing.defaultTargetSize;
  const profile = size <= table.sizing.rail.through ? table.sizing.rail : size <= table.sizing.row.through ? table.sizing.row : table.sizing.hero;
  const cx = table.head.centre;
  const w = parts.head === 'logo' ? table.head.logoWidth : table.head.width[0] + Math.round(r() * table.head.width[1]);
  const h = table.head.height[0] + Math.round(r() * table.head.height[1]);
  const x0 = cx - w / 2, x1 = cx + w / 2;
  const fill: string[] = [];
  const stroke: [string, number][] = [];
  const mirror = (path: string) => path.replace(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g, (_match, x: string, y: string) => `${f(2 * cx - Number(x))},${y}`);
  const line = (path: string, width: number) => stroke.push([path, Math.max(width, profile.minimumStroke)]);
  const both = (path: string, width: number) => { line(path, width); line(mirror(path), width); };
  if (parts.head === 'logo') {
    const radius = table.head.bottomRadius;
    fill.push(`${table.head.logoTop} L${x1},${h - radius} A${radius},${radius} 0 0 1 ${x1 - radius},${h} L${x0 + radius},${h} A${radius},${radius} 0 0 1 ${x0},${h - radius} Z`);
  } else if (parts.head === 'blob') fill.push(ellipse(cx, h / 2, w / 2, h / 2));
  else if (parts.head === 'dome') {
    const radius = w / 2, bottom = table.head.domeRadius;
    fill.push(`M${x0},${h - bottom} L${x0},${radius} A${radius},${radius} 0 0 1 ${x1},${radius} L${x1},${h - bottom} Q${x1},${h} ${x1 - bottom},${h} L${x0 + bottom},${h} Q${x0},${h} ${x0},${h - bottom} Z`);
  } else fill.push(roundedRect(x0, 0, w, h, parts.head === 'round' ? Math.min(w, h) * table.head.roundRadius : table.head.boxRadius));

  const top = table.head.earTop[parts.head], ex = x0 + w * table.ears.root;
  const earY = (offset: number) => top + (offset < 0 ? offset * profile.earReach : offset);
  if (parts.ears === 'pointed') {
    const p = table.ears.pointed;
    const point = ([x, y]: readonly [number, number]) => `${f(x0 + x)},${f(earY(y))}`;
    const path = `M${point(p.root)} L${point(p.tip)} C${point(p.curve1)} ${point(p.curve2)} ${point(p.curveEnd)} L${f(x0 + w * p.inner[0])},${f(earY(p.inner[1]))} Z`;
    fill.push(path, mirror(path));
  } else if (parts.ears === 'round') {
    const p = table.ears.round;
    fill.push(ellipse(x0 + p.inset, earY(p.y), p.radius, p.radius), ellipse(x1 - p.inset, earY(p.y), p.radius, p.radius));
  } else if (parts.ears === 'long' || parts.ears === 'antennae') {
    const p = table.ears[parts.ears];
    both(`M${f(ex + p.root[0])},${f(earY(p.root[1]))} L${f(ex + p.tip[0])},${f(earY(p.tip[1]))}`, p.width);
    if (parts.ears === 'antennae') {
      const [dx, dy, radius] = table.ears.antennae.bulb;
      fill.push(ellipse(ex + dx, earY(dy), radius, radius), ellipse(2 * cx - ex - dx, earY(dy), radius, radius));
    }
  } else if (parts.ears === 'horns') {
    const p = table.ears.horns;
    const point = ([x, y]: readonly [number, number]) => `${f(x0 + x)},${f(earY(y))}`;
    both(`M${point(p.root)} C${point(p.curve1)} ${point(p.curve2)} ${point(p.tip)}`, p.width);
  }
  const reach = profile.appendageReach;
  if (parts.limbs === 'legs') {
    const p = table.limbs.legs;
    fill.push(roundedRect(x0 + w * p.inset, h + p.y, p.width, p.height * reach, p.radius), roundedRect(x1 - w * p.inset - p.width, h + p.y, p.width, p.height * reach, p.radius));
  } else if (parts.limbs === 'feet' || parts.limbs === 'wheels') {
    const p = table.limbs[parts.limbs];
    const rx = 'radius' in p ? p.radius : p.rx, ry = 'radius' in p ? p.radius : p.ry;
    fill.push(ellipse(x0 + w * p.inset, h + p.y, rx, ry), ellipse(x1 - w * p.inset, h + p.y, rx, ry));
  } else if (parts.limbs === 'tentacles') {
    const p = table.limbs.tentacles;
    for (const x of [x0 + w * p.inset, cx, x1 - w * p.inset]) {
      line(`M${f(x)},${f(h + p.rootY)} C${f(x + p.curve1[0])},${f(h + p.curve1[1] * reach)} ${f(x + p.curve2[0])},${f(h + p.curve2[1] * reach)} ${f(x)},${f(h + p.endY * reach)}`, p.width);
    }
  } else if (parts.limbs === 'arms') {
    const p = table.limbs.arms;
    both(`M${f(x0 + p.root[0])},${f(h * p.root[1])} C${f(x0 + p.curve1[0] * reach)},${f(h * p.curve1[1])} ${f(x0 + p.curve2[0] * reach)},${f(h * p.curve2[1])} ${f(x0 + p.end[0] * reach)},${f(h + p.end[1] * reach)}`, p.width);
  }
  if (parts.tail === 'curl') {
    const p = table.tail.curl;
    const point = ([x, y]: readonly [number, number]) => `${f(x1 + x * reach)},${f(h + y * reach)}`;
    line(`M${point(p.root)} C${point(p.curve1)} ${point(p.curve2)} ${point(p.end)}`, p.width);
  } else if (parts.tail === 'fin') {
    const p = table.tail.fin;
    const point = ([x, y]: readonly [number, number]) => `${f(x1 + x * reach)},${f(h * y)}`;
    fill.push(`M${point(p.root)} L${point(p.tip)} L${point(p.end)} Z`);
  }
  const omitted: readonly string[] = profile.omitAccessories;
  if (!omitted.includes(parts.accessory)) {
    if (parts.accessory === 'hat') {
      for (const [x, y, width, height, radius] of [table.accessory.hat.top, table.accessory.hat.brim]) fill.push(roundedRect(cx + w * x, top + y, w * width, height, radius));
    } else if (parts.accessory === 'bow') {
      const p = table.accessory.bow, x = x1 - w * p.inset;
      fill.push(`M${f(x)},${top + p.y} L${f(x - p.halfWidth)},${top + p.top} L${f(x - p.halfWidth)},${top + p.bottom} Z M${f(x)},${top + p.y} L${f(x + p.halfWidth)},${top + p.top} L${f(x + p.halfWidth)},${top + p.bottom} Z`);
    } else if (parts.accessory === 'leaf') {
      const p = table.accessory.leaf;
      const point = ([x, y]: readonly [number, number]) => `${x},${top + y}`;
      fill.push(`M${point(p.root)} C${point(p.curve1)} ${point(p.curve2)} ${point(p.tip)} C${point(p.curve3)} ${point(p.curve4)} ${point(p.root)} Z`);
    }
  }
  const shape: BotFaceShapeV1 = {
    v: 1, origin: 'surprise', fill, ...(stroke.length ? { stroke } : {}),
    mouth: [cx, f(h * (parts.head === 'logo' ? table.mouth.logoY : table.mouth.otherY)), f(table.mouth.scale[0] + r() * table.mouth.scale[1])],
  };
  let result = normaliseAndValidateBotFaceShape(shape);
  for (const scale of table.mouth.smallerScales) {
    if (result.ok) return result.shape;
    shape.mouth[2] = Math.min(shape.mouth[2], scale);
    result = normaliseAndValidateBotFaceShape(shape);
  }
  if (result.ok) return result.shape;
  throw new Error(`Generated Bot shape is invalid: ${result.errors.join('; ')}`);
}
