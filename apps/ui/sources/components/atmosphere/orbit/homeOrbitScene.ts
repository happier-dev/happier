import { HAPPIER_TYPE_SCALE } from '@happier-dev/plugin-ui/presentation';

/**
 * The Home orbit scene, moved from the atmosphere lab (`at-widget.js scene()`): flat, faint dotted
 * circles centred on the planet; each body (a machine) is a moon on its circle, and what it holds
 * trails behind it as dots on the same circle. Every orbit is wider than the planet and its glow, so
 * nothing ever crosses in front of it. Geometry only: HomeOrbitMap draws the shared GlyphSurface.
 *
 * One owner for every orbit drawing: the Your Home widget (sessions per machine) and the capability
 * homepages (skills per machine) both lay out through here and draw through `HomeOrbitMap`.
 */
export type HomeOrbitDotTone = 'quiet' | 'active' | 'attention' | 'hollow';

export type HomeOrbitBody = Readonly<{
  key: string;
  online: boolean;
  dots: readonly Readonly<{ key: string; tone: HomeOrbitDotTone }>[];
}>;

export type HomeOrbitOptions = Readonly<{
  pr?: number;
  px?: number;
  py?: number;
  /** Orbit radii in px (callers pass multiples of `pr`). */
  radii?: readonly number[];
  /** Each moon's angle on its orbit, in degrees. */
  angles?: readonly number[];
  small?: boolean;
  /** Arc between two dots on an orbit, in px (the widget's sessions sit 11 px apart). */
  dotGap?: number;
}>;

export type HomeOrbitScene = Readonly<{
  width: number;
  height: number;
  /** The planet's centre and radius. */
  px: number;
  py: number;
  pr: number;
  orbits: readonly Readonly<{ r: number; off: boolean }>[];
  moons: readonly Readonly<{
    key: string;
    x: number;
    y: number;
    r: number;
    off: boolean;
  }>[];
  dots: readonly Readonly<{
    key: string;
    bodyKey: string;
    x: number;
    y: number;
    tone: HomeOrbitDotTone;
  }>[];
  /** The planet canvas: a square of 4.2 planet radii centred on the planet; null when the host draws the planet. */
  canvas: Readonly<{ left: number; top: number; size: number }> | null;
  /** A ring scene's marks and their tethers (`layoutHomeOrbitRing`); absent on an orbit scene. */
  ring?: HomeOrbitRing;
  /** A Bot scene's moons (`layoutHomeOrbitBots`); absent on the machine and ring scenes. */
  bots?: HomeOrbitBots;
}>;

/**
 * How a mark on the ring reaches the Home: `account` held by the Home itself (a solid tether), `machine`
 * run on the machines (dotted), `attention` waiting on the person (amber dashed, with a beacon), `none`
 * not reaching anything (no tether, the mark faded).
 */
export type HomeOrbitTether = 'account' | 'machine' | 'attention' | 'none';

export type HomeOrbitRingMark = Readonly<{
  key: string;
  tether: HomeOrbitTether;
  /** Drawn faded; by default a mark with no tether is (a count mark like "+2" is not). */
  faded?: boolean;
}>;

export type HomeOrbitRing = Readonly<{
  r: number;
  /** A mark's drawn box (its centre is on the ring). */
  markSize: number;
  marks: readonly Readonly<{
    key: string;
    tether: HomeOrbitTether;
    faded: boolean;
    x: number;
    y: number;
    /** The tether: from just outside the planet's glow to just inside the mark. */
    from: Readonly<{ x: number; y: number }>;
    to: Readonly<{ x: number; y: number }>;
  }>[];
}>;

export type HomeOrbitRingOptions = Readonly<{
  pr?: number;
  px?: number;
  py?: number;
  /** The ring's radius; raised when needed so a mark never sits inside the planet's glow. */
  r?: number;
  /** The first mark's angle, in degrees (the top). */
  startAngle?: number;
  markSize?: number;
}>;

/**
 * The ring scene (lab hm-A `tetherMap`): one dotted ring around the planet and N marks spaced evenly on
 * it, the first at the top, each with its tether toward the planet. The glow is the planet canvas's
 * half-size (2.1 planet radii); the ring keeps every mark wholly outside it.
 */
export function layoutHomeOrbitRing(
  w: number,
  h: number,
  marks: readonly HomeOrbitRingMark[],
  o: HomeOrbitRingOptions = {},
): HomeOrbitScene {
  const pr = Math.round(o.pr || Math.min(h, w) * 0.13);
  const px = Math.round(o.px != null ? o.px : w / 2),
    py = Math.round(o.py != null ? o.py : h / 2);
  const markSize = o.markSize ?? 22;
  const glow = pr * 2.1;
  const r = Math.round(Math.max(o.r ?? pr * 2.9, glow + markSize / 2 + 2));
  const a0 = o.startAngle ?? -90;
  const at = (radius: number, deg: number) => {
    const a = (deg * Math.PI) / 180;
    return { x: px + Math.cos(a) * radius, y: py + Math.sin(a) * radius };
  };
  const placed = marks.map((mark, index) => {
    const deg = a0 + (360 / Math.max(1, marks.length)) * index;
    const centre = at(r, deg);
    return {
      key: mark.key,
      tether: mark.tether,
      faded: mark.faded ?? mark.tether === 'none',
      x: centre.x,
      y: centre.y,
      from: at(pr + 13, deg),
      to: at(r - markSize / 2 - 3, deg),
    };
  });
  const size = pr * 4.2;
  return {
    width: w,
    height: h,
    px,
    py,
    pr,
    orbits: [{ r, off: marks.length === 0 }],
    moons: [],
    dots: [],
    canvas: { left: px - size / 2, top: py - size / 2, size },
    ring: { r, markSize, marks: placed },
  };
}

export function layoutHomeOrbitScene(
  w: number,
  h: number,
  bodies: readonly HomeOrbitBody[],
  o: HomeOrbitOptions = {},
): HomeOrbitScene {
  const pr = Math.round(o.pr || Math.min(h, w) * 0.16);
  const px = Math.round(o.px != null ? o.px : w / 2),
    py = Math.round(o.py != null ? o.py : h / 2);
  const radii = (o.radii || [1.95, 2.7, 3.45].map((k) => k * pr)).map(
    Math.round,
  );
  const angles = o.angles || [-18, 200, 155];
  const gap = o.dotGap ?? 11;
  const at = (r: number, deg: number): [number, number] => {
    const a = (deg * Math.PI) / 180;
    return [px + Math.cos(a) * r, py + Math.sin(a) * r];
  };
  const last = radii[radii.length - 1]!;
  // The lab draws three bodies. Past them, every body shares the outer orbit (drawn once) and the
  // moons there are spaced evenly from its lab angle, so no two moons or orbits sit on each other.
  const shared = Math.max(1, bodies.length - (radii.length - 1));
  const radiusOf = (k: number) => radii[k] || last;
  const angleOf = (k: number) => {
    if (bodies.length <= radii.length)
      return angles[k] != null ? angles[k]! : k * 120;
    const outer = radii.length - 1;
    if (k < outer) return angles[k] != null ? angles[k]! : k * 120;
    return (
      (angles[outer] != null ? angles[outer]! : outer * 120) +
      ((k - outer) * 360) / shared
    );
  };
  const orbits = bodies.length
    ? [...new Set(bodies.map((_, k) => radiusOf(k)))].map((r) => ({
        r,
        off: bodies.every((b, k) => radiusOf(k) !== r || !b.online),
      }))
    : [
        { r: radii[0]!, off: true },
        { r: radii[Math.min(2, radii.length - 1)]!, off: true },
      ];
  const dots: {
    key: string;
    bodyKey: string;
    x: number;
    y: number;
    tone: HomeOrbitDotTone;
  }[] = [];
  const moons = bodies.map((body, k) => {
    const r = radiusOf(k);
    const a0 = angleOf(k);
    const [mx, my] = at(r, a0);
    const step = (gap / r) * (180 / Math.PI);
    // Dots trail behind the moon: counter-clockwise on the right half, clockwise on the left.
    const direction = a0 > 90 && a0 < 270 ? 1 : -1;
    body.dots.forEach((dot, i) => {
      const [sx, sy] = at(r, a0 + (i + 1) * step * direction);
      dots.push({
        key: dot.key,
        bodyKey: body.key,
        x: sx,
        y: sy,
        tone: dot.tone,
      });
    });
    return {
      key: body.key,
      x: mx,
      y: my,
      r: o.small ? 3.6 : 4.4,
      off: !body.online,
    };
  });
  const size = pr * 4.2;
  return {
    width: w,
    height: h,
    px,
    py,
    pr,
    orbits,
    moons,
    dots,
    canvas: { left: px - size / 2, top: py - size / 2, size },
  };
}

/** Inter's average advance at the meta size, as a share of the font size: enough to keep a label inside the map. */
const LABEL_ADVANCE_EM = 0.56;
const LABEL_GAP_PX = 6;

/**
 * A moon's name sits on the side with room: after the moon, or before it when the map's edge is
 * closer than the name. On the planet's row the side facing the planet only reaches the planet's
 * edge, so a name never runs across it. A name longer than its room ends in an ellipsis, and a
 * same-name machine's suffix ("Build box · 08cc") stays whole while the name before it shortens.
 */
export function placeOrbitMoonLabel(
  moon: Readonly<{ x: number; y: number; r: number }>,
  label: string,
  area: Readonly<{ width: number; px: number; py: number; pr: number }>,
  fontSize: number,
): Readonly<{ x: number; textAnchor: 'start' | 'end'; text: string }> {
  const advance = fontSize * LABEL_ADVANCE_EM;
  const onPlanetRow = Math.abs(moon.y - area.py) < area.pr + fontSize;
  // A name keeps a gap from the map's edge and from the planet, so a wide glyph never clips.
  const afterEdge = (onPlanetRow && moon.x < area.px ? area.px - area.pr : area.width) - LABEL_GAP_PX;
  const beforeEdge = (onPlanetRow && moon.x > area.px ? area.px + area.pr : 0) + LABEL_GAP_PX;
  const after = afterEdge - (moon.x + moon.r + LABEL_GAP_PX);
  const before = moon.x - moon.r - LABEL_GAP_PX - beforeEdge;
  const needed = label.length * advance;
  const useAfter = needed <= after || after >= before;
  const room = Math.max(0, useAfter ? after : before);
  const text = fitMoonLabel(label, Math.max(1, Math.floor(room / advance)));
  return useAfter
    ? { x: Math.round((moon.x + moon.r + LABEL_GAP_PX) * 10) / 10, textAnchor: 'start', text }
    : { x: Math.round((moon.x - moon.r - LABEL_GAP_PX) * 10) / 10, textAnchor: 'end', text };
}

/** Shortens a label to `fits` characters, keeping a trailing " · suffix" whole when it leaves room for a name. */
function fitMoonLabel(label: string, fits: number): string {
  if (label.length <= fits) return label;
  const tail = label.lastIndexOf(' · ');
  const suffix = tail > 0 ? label.slice(tail) : '';
  if (suffix && fits - suffix.length >= 3) return `${label.slice(0, fits - suffix.length - 1)}…${suffix}`;
  return `${label.slice(0, Math.max(1, fits - 1))}…`;
}

export type HomeOrbitBotActivity = 'quiet' | 'working' | 'needsYou';

/** One Bot for the orbit, in the roster's order (needs you, then working, then the rest). */
export type HomeOrbitBotInput = Readonly<{ key: string; activity: HomeOrbitBotActivity }>;

/**
 * A tilted orbit around the planet (lab R6 `worldMount`): an ellipse whose near side leans down, so
 * `sin(angle) > 0` is in front of the planet and `< 0` behind it.
 */
export type HomeOrbitBotOrbit = Readonly<{ rx: number; ry: number }>;

export type HomeOrbitBotMoon = Readonly<{
  key: string;
  activity: HomeOrbitBotActivity;
  orbit: HomeOrbitBotOrbit;
  /** Where the moon stands on its orbit when it is not travelling, in radians. */
  angle: number;
  /** Radians per second while it works; a quiet or needs-you moon has none. */
  speed: number;
  /** The face's drawn size: a list size, so the face itself stays still. */
  size: number;
  /** Needs you: the moon leaves its orbit and waits here, in front of the planet. */
  park: Readonly<{ x: number; y: number }> | null;
  /**
   * How wide its name may be under the face, kept within the room to its neighbours so names never
   * overlap. Only a waiting moon is named; one in orbit (0) would cross its neighbours' names.
   */
  labelWidth: number;
}>;

export type HomeOrbitBots = Readonly<{
  /** Each orbit lane's dotted path, already cut where the planet hides it. */
  paths: readonly string[];
  moons: readonly HomeOrbitBotMoon[];
  /** The Bots with no room in the hero: one "+N" stands here for them; null when every Bot is shown. */
  more: Readonly<{ count: number; x: number; y: number; size: number }> | null;
}>;

/** Home shows at most this many Bot moons; the rest are one "+N" (the fold Home's Machine moons use). */
export const HOME_ORBIT_BOT_MOON_LIMIT = 4;

/** A moon's name is at most this wide (its label box), and keeps within the room to its neighbours. */
export const HOME_ORBIT_BOT_LABEL_MAX_WIDTH_PX = 160;
/** The gap between a waiting moon's face and its name under it. */
export const HOME_ORBIT_BOT_LABEL_GAP_PX = 2;


export type HomeOrbitBotOptions = Readonly<{
  /** Each lane's half-axes as multiples of the planet's radius (Rise's planet needs `ry` past 1 to show). */
  lanes?: readonly Readonly<{ rx: number; ry: number }>[];
  /** Each lane's first moon's angle, in radians (the lab's 0.5, 3.75 and 2.4 by default). */
  startAngles?: readonly number[];
  /** Where on the arc in front the first needs-you moon waits, in radians. */
  parkAngle?: number;
  moonSize?: number;
  parkedSize?: number;
  /**
   * Content over the moons' layer, in the area's coordinates (Home's headline and composer). It takes the
   * pointer, so a moon resting or waiting under it could be seen but not pressed; moons rest clear of it.
   */
  keepOut?: readonly HomeOrbitRect[];
}>;

export type HomeOrbitRect = Readonly<{ x: number; y: number; width: number; height: number }>;

/** Whether a moon of this size standing at `p` overlaps any of the content boxes. */
function blocked(keepOut: readonly HomeOrbitRect[], p: Readonly<{ x: number; y: number }>, size: number): boolean {
  const half = size / 2;
  return keepOut.some((r) => p.x + half > r.x && p.x - half < r.x + r.width && p.y + half > r.y && p.y - half < r.y + r.height);
}

/**
 * Whether a waiting moon at `p` overlaps the content boxes: its face, and the name drawn under it
 * (`HomeOrbitBotMoon`), whose box is never wider than the label box.
 */
function parkedBlocked(keepOut: readonly HomeOrbitRect[], p: Readonly<{ x: number; y: number }>, size: number): boolean {
  if (blocked(keepOut, p, size)) return true;
  const name = {
    x: p.x - HOME_ORBIT_BOT_LABEL_MAX_WIDTH_PX / 2,
    y: p.y + size / 2 + HOME_ORBIT_BOT_LABEL_GAP_PX,
    width: HOME_ORBIT_BOT_LABEL_MAX_WIDTH_PX,
    height: HAPPIER_TYPE_SCALE.meta.lineHeight,
  };
  return keepOut.some((r) => name.x < r.x + r.width && r.x < name.x + name.width && name.y < r.y + r.height && r.y < name.y + name.height);
}

/** Lab R6: the orbits lean by this share of their width. */
export const HOME_ORBIT_BOT_TILT = -0.18;
/** Lab R6 speeds: a working moon travels 0.55 rad/s; the outer lanes slow a little, as the lab's do. */
const WORKING_SPEED = 0.55;
/** Lanes as multiples of the planet's radius, from the lab's 300/64, 280/110 and 360/92 over a 121 px planet, eased in toward Home's larger planet. */
const DEFAULT_LANES = [
  { rx: 1.45, ry: 0.5 },
  { rx: 1.8, ry: 0.68 },
  { rx: 2.15, ry: 0.86 },
] as const;
const DEFAULT_START_ANGLES = [0.5, 3.75, 2.4] as const;
/** Two moons on one lane keep this many face widths of arc between them. */
const MOON_SPACING = 1.8;

/** A point on a Bot orbit: its place on the page, its depth (front > 0) and its depth scale (lab 0.78–1). */
export function homeOrbitBotPoint(
  cx: number,
  cy: number,
  orbit: HomeOrbitBotOrbit,
  angle: number,
): { x: number; y: number; z: number; scale: number } {
  'worklet';
  const z = Math.sin(angle);
  return {
    x: cx + Math.cos(angle) * orbit.rx,
    y: cy + z * orbit.ry + Math.cos(angle) * orbit.rx * HOME_ORBIT_BOT_TILT,
    z,
    scale: 0.78 + 0.22 * (z * 0.5 + 0.5),
  };
}

/** Whether a point on the far side of an orbit is hidden by the planet's disc. */
export function isHomeOrbitBotBehindPlanet(
  cx: number,
  cy: number,
  pr: number,
  point: Readonly<{ x: number; y: number; z: number }>,
): boolean {
  'worklet';
  return point.z < 0 && Math.hypot(point.x - cx, point.y - cy) < pr;
}

/**
 * The Bot scene (lab R6 "Bots orbit Home"): the host draws Home's planet; each Bot is a moon on a tilted
 * orbit around it. Lanes fill in the roster's order, the moons on a lane spaced evenly from its start
 * angle. A lane holds as many moons as its length fits; past that the remaining Bots, last in the
 * roster's order, are not drawn (they stay in the roster). Needs-you moons wait in front, on an arc
 * just outside the first lane, inside the area.
 */
export function layoutHomeOrbitBots(
  area: Readonly<{ width: number; height: number }>,
  planet: Readonly<{ px: number; py: number; pr: number }>,
  bots: readonly HomeOrbitBotInput[],
  o: HomeOrbitBotOptions = {},
): HomeOrbitScene {
  const { px, py, pr } = planet;
  const size = o.moonSize ?? 30;
  const parkedSize = o.parkedSize ?? 40;
  const lanes = (o.lanes ?? DEFAULT_LANES).map((lane) => ({ rx: Math.round(lane.rx * pr), ry: Math.round(lane.ry * pr) }));
  // Where each lane can show a resting moon: in the area and in front of (or clear of) the planet.
  const keepOut = o.keepOut ?? [];
  const rests = lanes.map((orbitLane) => visibleRestArc(area, planet, orbitLane, size, keepOut));
  const capacity = lanes.map((orbitLane, k) =>
    Math.max(1, Math.floor((rests[k]!.whole ? 2 * Math.PI * Math.sqrt((orbitLane.rx ** 2 + orbitLane.ry ** 2) / 2) : rests[k]!.length) / (size * MOON_SPACING))),
  );
  // A few moons: they fold to four and "+N", as Home's Machine moons do (Store S1); the Bots that wait
  // for the person come first, then the roster's order.
  const shown = [...bots.filter((bot) => bot.activity === 'needsYou'), ...bots.filter((bot) => bot.activity !== 'needsYou')]
    .slice(0, HOME_ORBIT_BOT_MOON_LIMIT);
  const parked = shown.filter((bot) => bot.activity === 'needsYou');
  const orbiting = shown.filter((bot) => bot.activity !== 'needsYou');
  // Round-robin over the lanes in order, so the first Bots spread over every orbit before any doubles up.
  const byLane: HomeOrbitBotInput[][] = lanes.map(() => []);
  let lane = 0;
  let unplaced = 0;
  for (const bot of orbiting) {
    let tries = 0;
    while (tries < lanes.length && byLane[lane]!.length >= capacity[lane]!) {
      lane = (lane + 1) % lanes.length;
      tries++;
    }
    if (tries === lanes.length) { unplaced += 1; continue; }
    byLane[lane]!.push(bot);
    lane = (lane + 1) % lanes.length;
  }
  const moons: HomeOrbitBotMoon[] = [];
  byLane.forEach((members, k) => {
    // The lab's start angles, one per lane, then even spacing round the lane.
    const starts = o.startAngles ?? DEFAULT_START_ANGLES;
    const start = starts[k % starts.length]! + Math.floor(k / starts.length) * 0.9;
    const rest = rests[k]!;
    // The lab spaces a lane's moons round the whole lane. Where part of the lane is off the page (a
    // Corner or Side planet) the moons rest along the stretch the page shows instead, so none is lost.
    const lab = members.map((_, i) => start + (2 * Math.PI * i) / members.length);
    const angles = rest.whole || rest.span === 0 || lab.every((angle) => rest.shows(angle))
      ? lab
      : members.map((_, i) => rest.from + (rest.span * (i + 0.5)) / members.length);
    members.forEach((bot, i) => {
      moons.push({
        key: bot.key,
        activity: bot.activity,
        orbit: lanes[k]!,
        angle: angles[i]!,
        speed: bot.activity === 'working' ? WORKING_SPEED * (lanes[0]!.rx / lanes[k]!.rx) : 0,
        size,
        park: null,
        // A working moon carries its name and state with it (lab r6-shell-O "Release captain · working"); a quiet
        // one at rest stays unnamed, so a calm Home is not a field of labels.
        labelWidth: bot.activity === 'working' ? HOME_ORBIT_BOT_LABEL_MAX_WIDTH_PX : 0,
      });
    });
  });
  // Front-left of the planet, just outside the first lane; each next one a face further round the arc.
  const parkOrbit = { rx: lanes[0]!.rx * 1.12, ry: lanes[0]!.ry * 1.12 };
  // Measured on the arc's tighter side, so neighbours on the short axis keep their room too.
  const parkStep = (parkedSize * 1.4) / Math.max(1, Math.min(parkOrbit.rx, parkOrbit.ry));
  const margin = parkedSize / 2 + 4;
  // The slots along the arc a waiting moon can take: wholly on the page, its face and name clear of the hero content.
  // Past them a moon would be pushed onto another (the 50-Bot pile-up), so the rest count toward "+N".
  const slotCount = Math.max(1, Math.floor((2 * Math.PI) / parkStep));
  const parkStart = o.parkAngle ?? 0.72 * Math.PI;
  const free: { angle: number; at: { x: number; y: number } }[] = [];
  for (let slot = 0; slot < slotCount; slot++) {
    const angle = parkStart + slot * parkStep;
    const at = homeOrbitBotPoint(px, py, parkOrbit, angle);
    const inside = at.x >= margin && at.x <= area.width - margin && at.y >= margin && at.y <= area.height - margin;
    if (inside && !parkedBlocked(keepOut, at, parkedSize)) free.push({ angle, at });
  }
  // With Bots left over, the slot after the shown waiting moons holds their "+N" instead of one more face.
  const leftOver = bots.length > shown.length || unplaced + Math.max(0, parked.length - free.length) > 0;
  const parkedShown = parked.slice(0, leftOver ? Math.max(0, Math.min(parked.length, free.length - 1)) : parked.length);
  const moreSlot = leftOver ? free[parkedShown.length] ?? null : null;
  const overflow = bots.length - moons.length - parkedShown.length;
  const named = parkedShown.map((bot, index) => ({ bot, ...free[index]! }));
  named.forEach(({ bot, angle, at }) => {
    moons.push({
      key: bot.key,
      activity: bot.activity,
      orbit: lanes[0]!,
      angle,
      speed: 0,
      size: parkedSize,
      park: at,
      labelWidth: parkedLabelWidth(at, named.map((entry) => entry.at)),
    });
  });
  const more = moreSlot && overflow > 0 ? { count: overflow, x: moreSlot.at.x, y: moreSlot.at.y, size: parkedSize } : null;
  const used = new Set(moons.filter((moon) => moon.park === null).map((moon) => moon.orbit));
  const paths = lanes.filter((orbitLane) => used.has(orbitLane)).map((orbitLane) => botOrbitPath(px, py, pr, orbitLane));
  return {
    width: area.width,
    height: area.height,
    px,
    py,
    pr,
    orbits: [],
    moons: [],
    dots: [],
    canvas: null,
    bots: { paths, moons, more },
  };
}

/**
 * A waiting moon's name width: the room to the nearest other waiting moon whose name shares its line
 * (the label's own line height), never more than the label box.
 */
function parkedLabelWidth(at: Readonly<{ x: number; y: number }>, all: readonly Readonly<{ x: number; y: number }>[]): number {
  const line = HAPPIER_TYPE_SCALE.meta.lineHeight;
  let width = HOME_ORBIT_BOT_LABEL_MAX_WIDTH_PX;
  for (const other of all) {
    if (other === at || Math.abs(other.y - at.y) >= line) continue;
    width = Math.min(width, Math.abs(other.x - at.x));
  }
  return width;
}

const REST_STEPS = 180;

/**
 * The longest stretch of a lane where a resting moon is wholly in the area, not hidden by the planet
 * and not under the hero's content: where it starts and how far it runs (radians), its length on the page, and whether the whole
 * lane qualifies.
 */
function visibleRestArc(
  area: Readonly<{ width: number; height: number }>,
  planet: Readonly<{ px: number; py: number; pr: number }>,
  orbit: HomeOrbitBotOrbit,
  size: number,
  keepOut: readonly HomeOrbitRect[],
): Readonly<{ whole: boolean; from: number; span: number; length: number; shows: (angle: number) => boolean }> {
  const half = size / 2;
  const shows = (angle: number) => {
    const p = homeOrbitBotPoint(planet.px, planet.py, orbit, angle);
    return p.x >= half && p.x <= area.width - half && p.y >= half && p.y <= area.height - half
      && !isHomeOrbitBotBehindPlanet(planet.px, planet.py, planet.pr, p) && !blocked(keepOut, p, size);
  };
  const step = (2 * Math.PI) / REST_STEPS;
  const ok = Array.from({ length: REST_STEPS }, (_, i) => shows(i * step));
  if (ok.every(Boolean)) return { whole: true, from: 0, span: 2 * Math.PI, length: Infinity, shows };
  // Walk twice round so a stretch that crosses angle 0 is found whole.
  let best = { from: 0, count: 0 };
  let runFrom = 0;
  let run = 0;
  for (let i = 0; i < REST_STEPS * 2; i++) {
    if (ok[i % REST_STEPS]) {
      if (run === 0) runFrom = i;
      run += 1;
      if (run > best.count && run <= REST_STEPS) best = { from: runFrom, count: run };
    } else run = 0;
  }
  if (best.count < 2) return { whole: false, from: 0, span: 0, length: 0, shows };
  // Keep a step clear of each end, where a moon would touch the edge or the planet.
  const from = (best.from + 1) * step;
  const span = (best.count - 2) * step;
  let length = 0;
  let last = homeOrbitBotPoint(planet.px, planet.py, orbit, from);
  for (let i = 1; i <= best.count - 2; i++) {
    const next = homeOrbitBotPoint(planet.px, planet.py, orbit, from + i * step);
    length += Math.hypot(next.x - last.x, next.y - last.y);
    last = next;
  }
  return { whole: false, from, span, length, shows };
}

/** The lane's dotted path as SVG, leaving out the stretch the planet hides. */
function botOrbitPath(cx: number, cy: number, pr: number, orbit: HomeOrbitBotOrbit): string {
  const steps = 120;
  let d = '';
  let pen = false;
  for (let i = 0; i <= steps; i++) {
    const point = homeOrbitBotPoint(cx, cy, orbit, (i / steps) * 2 * Math.PI);
    if (isHomeOrbitBotBehindPlanet(cx, cy, pr, point)) {
      pen = false;
      continue;
    }
    d += `${pen ? 'L' : 'M'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
    pen = true;
  }
  return d;
}
