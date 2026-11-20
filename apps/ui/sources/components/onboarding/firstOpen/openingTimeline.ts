import {
    fieldDotLayer, glyphFrame, glyphPlanetDigitFirstTile, markGlyphLayer, markGlyphTone, planetGlyphLayer, travellerGlyphLayer,
    type GlyphLayer, type GlyphPoint, type GlyphRect,
} from '@happier-dev/brand/glyph-scene';
import { welcomePlanetPose } from '@happier-dev/brand/planet-placement';

export const openingSceneSeconds = 3.17;
export const openingClimbSeconds = 1.85;
const turnStart = 1.22;
const turnEnd = 1.82;
const fallStart = 1.25;
const contact = 2.65;
const fallEnd = 2.8;
const cell = [8, 16] as const;
const particleStride = 8;
const greyFloatInk = [126, 120, 134, 125] as const;

type OpeningGeometry = Readonly<{
    width: number;
    height: number;
    phone: boolean;
    theme: 'dark' | 'light';
    windowRect?: GlyphRect;
    cursor?: GlyphPoint;
}>;

function progress(time: number, from: number, to: number): number {
    return Math.max(0, Math.min(1, (time - from) / (to - from)));
}

const mix = (a: number, b: number, k: number): number => a + (b - a) * k;
const sine = (k: number): number => (1 - Math.cos(Math.PI * k)) / 2;
const cubicOut = (k: number): number => 1 - (1 - k) ** 3;
const damped = (k: number): number => (1 - (1 + 6 * k) * Math.exp(-6 * k)) / (1 - 7 * Math.exp(-6));

function variation(index: number, salt: number): number {
    let bits = Math.imul((index + 1) * 2654435761 ^ (salt + 7) * 40503, 1597334677);
    bits = Math.imul(bits ^ (bits >>> 15), 2246822519);
    return ((bits ^ (bits >>> 13)) >>> 0) / 4294967296;
}

function edgeOrigin(width: number, height: number, x: number, y: number, index: number): GlyphPoint {
    const angle = Math.atan2(y, x) + (variation(index, 15) - 0.5) * 1.1;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const distance = Math.min((width / 2 + 12) / Math.abs(cos), (height / 2 + 12) / Math.abs(sin));
    return { x: width / 2 + cos * distance, y: height / 2 + sin * distance };
}

type Travel = Readonly<{
    origin: GlyphPoint;
    destination: GlyphPoint;
    emit: number;
    arrival: number;
    arc: number;
    spread: number;
    tone: number;
    live: boolean;
    alpha: number;
    grey: boolean;
}>;

/** Builds the start tables once. Every sample uses the same clock for the mark, travellers and planet. */
export function createOpeningTimeline({ width, height, phone, theme, windowRect, cursor }: OpeningGeometry):
    (seconds: number) => readonly GlyphLayer[] {
    const centre = { x: width / 2, y: height * (phone ? 0.42 : 0.46) };
    const radius = phone ? width * 0.26 : Math.min(width, height) * 0.2;
    const target = windowRect ?? { x: 0, y: 0, width, height };
    const rest = welcomePlanetPose('welcome', target, { phone });
    const end = { x: rest.cx + target.x, y: rest.cy + target.y };
    const mark = markGlyphLayer({ centre, size: 2 * radius / 1.05, ink: 'sunrise', retypeS: 1.2 });
    // Source cells come from the real brand sampler so the opening never traces a second mark.
    const raster = glyphFrame({ view: { w: width, h: height }, cell, dpr: 1, theme, layers: [mark] });
    // One source per mark cell: its digit sprite (its wash and lattice dots are drawn with the cell).
    const markCells: number[] = [];
    raster.sprites.glyph.forEach((glyph, index) => {
        if (glyph >= glyphPlanetDigitFirstTile && glyph < glyphPlanetDigitFirstTile + 10) markCells.push(index);
    });
    const cellTimeline = new Float32Array(markCells.length * 4);
    const occupied = new Set<number>();
    const columns = raster.grid.cols;
    const cellIndex = (x: number, y: number) => Math.floor(y / cell[1]) * columns + Math.floor(x / cell[0]);
    for (const sprite of markCells) {
        occupied.add(cellIndex(raster.sprites.at[2 * sprite], raster.sprites.at[2 * sprite + 1]));
    }
    const sources: Array<Readonly<{ point: GlyphPoint; tone: number; departure: number }>> = [];
    const travels: Travel[] = [];
    const launch = cursor ?? (phone ? { x: width / 2, y: height + 12 } : undefined);
    // The traveller layer accepts the brand's packed start/end/emit/duration/arc/tone tuples.
    for (let index = 0; index < markCells.length; index++) {
        const sprite = markCells[index];
        const point = { x: raster.sprites.at[2 * sprite], y: raster.sprites.at[2 * sprite + 1] };
        const nx = (point.x - centre.x) / radius;
        const ny = (point.y - centre.y) / radius;
        const position = cellIndex(point.x, point.y);
        const outline = [position - 1, position + 1, position - columns, position + columns]
            .some(neighbour => !occupied.has(neighbour));
        const tone = markGlyphTone(mark, point.x, point.y);
        const departure = turnStart + 0.7 * variation(position, 31);
        const lock = variation(position, 11);
        const arrival = outline ? 0.5 + 0.25 * lock : 0.65 + 0.33 * lock ** 0.9;
        cellTimeline.set([point.x, point.y, arrival, departure], index * 4);
        sources.push({ point, tone, departure });
        const stream = variation(position, 13) < 0.25;
        for (let copy = 0; copy < 2; copy++) {
            const at = arrival - copy * 0.06 * variation(index, 41);
            const fromLaunch = stream && copy === 0 ? launch : undefined;
            const origin = fromLaunch
                ? { x: fromLaunch.x + 14 * (variation(index, 15) - 0.5), y: fromLaunch.y + 14 * (variation(index, 16) - 0.5) }
                : edgeOrigin(width, height, copy === 0 ? nx : -nx, ny, index + copy * 9000);
            const flight = copy === 1 ? 0.75 + 0.3 * variation(index, 42)
                : fromLaunch ? 0.55 + 0.15 * variation(index, 14) : 0.7 + 0.25 * variation(index, 14);
            travels.push({
                origin, destination: point, emit: Math.max(0.02, at - flight), arrival: at,
                arc: fromLaunch ? 0.3 + 0.1 * variation(index, 17) : (variation(index, 17) - 0.5) * 0.35,
                spread: fromLaunch ? (variation(index, 18) - 0.5) * 90 : 0, tone, live: false,
                // The second copy is quieter and partly in grey page ink, as the lab's gather.
                alpha: copy === 1 ? 0.55 + 0.3 * variation(index, 45) : fromLaunch ? 0.95 : 0.65 + 0.3 * variation(index, 19),
                grey: copy === 1 && variation(index, 46) >= 0.6,
            });
        }
    }
    for (let y = -radius + cell[1] / 2; y < radius && sources.length > 0; y += cell[1]) {
        for (let x = -radius + cell[0] / 2; x < radius; x += cell[0]) {
            if (Math.hypot(x, y) >= radius) continue;
            const index = travels.length;
            const arrival = 1.55 + (2.38 - 1.55) * variation(index, 35) ** 0.9;
            for (let copy = 0; copy < 2; copy++) {
                const source = sources[Math.floor(variation(index, 33 + copy) * sources.length)];
                const at = Math.max(1.55, arrival - copy * 0.08 * variation(index, 37));
                const emit = source.departure <= at - 0.3
                    ? source.departure : Math.max(turnStart, at - 0.3 - 0.25 * variation(index, 36 + copy));
                const flip = Math.cos(sine(progress(Math.min(emit, source.departure), turnStart, turnEnd)) * 0.9);
                travels.push({
                    origin: { x: mix(centre.x, source.point.x, flip), y: source.point.y },
                    destination: { x: x / radius, y: y / radius }, emit, arrival: at,
                    arc: (variation(index, 17) - 0.5) * 0.5, spread: 0, tone: source.tone, live: true,
                    alpha: 0.92 + 0.08 * variation(index, 19), grey: false,
                });
            }
        }
    }
    const floaters = Array.from({ length: 260 }, (_, j) => {
        const index = 20000 + j;
        const join = turnStart + 0.65 * variation(index, 5);
        const direction = variation(index, 7) * Math.PI * 2;
        const reach = Math.sqrt(variation(index, 8)) * 0.95;
        return {
            kind: j < 110 ? 'hover' : j < 236 ? 'drift' : 'settle',
            born: 0.5 + 0.45 * variation(index, 9), join,
            end: Math.min(2.38, join + 0.38 + 0.3 * variation(index, 6)),
            settle: 0.95 + 0.25 * variation(index, 21),
            radius: 1.32 + 1.1 * variation(index, 10) ** 1.3,
            angle: variation(index, 11) * Math.PI * 2,
            speed: (0.1 + 0.16 * variation(index, 12)) * (variation(index, 13) < 0.5 ? -1 : 1),
            x: variation(index, 14) * width, y: 30 + variation(index, 15) * (height - 60),
            vx: (variation(index, 16) - 0.5) * 70, vy: (variation(index, 17) - 0.5) * 50,
            targetX: Math.cos(direction) * reach, targetY: Math.sin(direction) * reach,
            bendX: (variation(index, 19) - 0.5) * 1.5, bendY: (variation(index, 20) - 0.5) * 1.5,
            tone: variation(index, 3), grey: variation(index, 2) >= 0.72,
            alpha: j < 110 ? 0.55 + 0.3 * variation(index, 18) : j < 236 ? 0.32 + 0.3 * variation(index, 18) : 0.8,
        };
    });
    // The planet's halo: loose grey digits circling it once it has formed, lifted away by the climb.
    const halo = Array.from({ length: 150 }, (_, j) => {
        const index = 3000 + j;
        const u = variation(index, 1);
        return {
            r: 1.08 + 1.55 * u ** 1.7, angle: variation(index, 2) * Math.PI * 2,
            speed: (0.12 + 0.18 * variation(index, 3)) * (variation(index, 4) < 0.5 ? -1 : 1),
            alpha: 0.34 - 0.24 * u, lift: 0.6 + 0.4 * variation(index, 5), tone: variation(index, 22),
        };
    });
    // Every loose digit carries its own opacity, drawn in ten opacity steps per ink.
    const alphaSteps = 10;
    const buckets = Array.from({ length: 2 * alphaSteps }, () => ({ particles: new Float32Array(64 * particleStride), offset: 0 }));
    const emit = (x: number, y: number, tone: number, grey: boolean, alpha: number) => {
        const step = Math.round(Math.min(1, alpha) * alphaSteps);
        if (step < 1) return;
        const bucket = buckets[(grey ? alphaSteps : 0) + step - 1];
        if (bucket.offset + particleStride > bucket.particles.length) {
            // Grows during the first frames only; later frames reuse the same storage.
            const grown = new Float32Array(bucket.particles.length * 2);
            grown.set(bucket.particles);
            bucket.particles = grown;
        }
        const out = bucket.particles;
        let at = bucket.offset;
        out[at++] = x;
        out[at++] = y;
        out[at++] = x;
        out[at++] = y;
        out[at++] = 0;
        out[at++] = openingSceneSeconds;
        out[at++] = 0;
        out[at++] = tone;
        bucket.offset = at;
    };
    const keepOut = (x: number, y: number) => 1 - progress(Math.max(Math.abs(x - centre.x), Math.abs(y - centre.y)) / radius, 1.02, 1.22);
    const impact = [{ ...end, at: contact }];
    return (seconds) => {
        const layers: GlyphLayer[] = [];
        if (windowRect && seconds > 0 && seconds < openingSceneSeconds) {
            const fadeIn = 1 - (1 - progress(seconds, 0, 0.45)) ** 2;
            const fadeOut = 1 - sine(progress(seconds, openingClimbSeconds + 0.15, openingSceneSeconds));
            layers.push(fieldDotLayer({ mode: 'animated', strength: 0.85 * fadeIn * fadeOut, ripples: impact }));
        }
        if (seconds >= 0.5 && seconds < 1.92) {
            layers.push({
                ...mark, cellTimeline, turn: sine(progress(seconds, turnStart, turnEnd)),
            });
        }
        const k = cubicOut(progress(seconds, fallStart, fallEnd) ** 1.5);
        const cx = mix(centre.x, end.x, k);
        const cy = mix(centre.y, end.y, k);
        const R = mix(radius, rest.R, k);
        if (seconds >= 1.55) {
            const impactSeconds = seconds - contact;
            const dy = impactSeconds >= 0 && impactSeconds < 0.24 ? 1.5 * Math.sin(Math.PI * impactSeconds / 0.24) : 0;
            const glow = impactSeconds >= 0 ? 0.5 * Math.exp(-impactSeconds / 0.12) : 0;
            layers.push(planetGlyphLayer({
                geometry: { ...rest, cx, cy: cy + dy, R, glow: (rest.glow ?? 1) + glow },
                digits: true, assemble: { startS: 1.55, durationS: 2.38 - 1.55 },
            }));
        }
        for (const bucket of buckets) bucket.offset = 0;
        for (const travel of travels) {
            if (seconds < travel.emit || seconds >= travel.arrival) continue;
            const targetX = travel.live ? cx + travel.destination.x * R : travel.destination.x;
            const targetY = travel.live ? cy + travel.destination.y * R : travel.destination.y;
            const u = progress(seconds, travel.emit, travel.arrival);
            const p = travel.live ? sine(u) : damped(u ** 1.4);
            const dx = targetX - travel.origin.x, dy = targetY - travel.origin.y;
            const length = Math.hypot(dx, dy) || 1;
            const bend = 2 * (1 - p) * p * travel.arc + travel.spread / length * Math.sin(Math.PI * p);
            const atX = mix(travel.origin.x, targetX, p) - dy * bend;
            const atY = mix(travel.origin.y, targetY, p) + dx * bend;
            const snap = progress(u, 0.8, 1);
            const x = mix(atX, (Math.floor(atX / cell[0]) + 0.5) * cell[0], snap);
            const y = mix(atY, (Math.floor(atY / cell[1]) + 0.5) * cell[1], snap);
            emit(x, y, travel.tone, travel.grey, travel.alpha * (1 - progress(u, 0.93, 1)));
        }
        const gathered = progress(seconds, turnEnd - 0.2, turnEnd + 0.3);
        const climbed = seconds - openingClimbSeconds;
        if (gathered > 0 && climbed < 0.7) {
            for (const digit of halo) {
                const angle = digit.angle + digit.speed * seconds;
                const lift = climbed > 0 ? 1100 * digit.lift * climbed * climbed : 0;
                const x = cx + Math.cos(angle) * digit.r * R;
                const y = cy + Math.sin(angle) * digit.r * R * 0.92 - lift;
                if (Math.hypot(x - cx, y - cy) < R * 1.04) continue;
                emit(x, y, digit.tone, true, digit.alpha * gathered * (1 - progress(climbed, 0.05, 0.6)));
            }
        }
        for (const digit of floaters) {
            if (seconds < digit.born || seconds >= digit.end) continue;
            const looseTime = Math.min(seconds, digit.join);
            const angle = digit.angle + digit.speed * looseTime;
            let alpha = digit.alpha * progress(seconds, digit.born, digit.born + 0.35);
            let x: number;
            let y: number;
            if (digit.kind === 'hover') {
                x = centre.x + Math.cos(angle) * digit.radius * radius;
                y = centre.y + Math.sin(angle) * digit.radius * radius * 0.9 + Math.sin(looseTime * 1.3 + digit.angle) * 6;
            } else if (digit.kind === 'drift') {
                x = digit.x + digit.vx * looseTime + Math.sin(looseTime * 0.9 + digit.angle) * 10;
                y = digit.y + digit.vy * looseTime + Math.cos(looseTime * 0.7 + digit.angle) * 8;
            } else {
                if (seconds >= digit.settle) continue;
                const k = sine(progress(seconds, digit.born, digit.settle));
                x = mix(digit.x, centre.x + digit.bendX * radius * 0.55, k);
                y = mix(digit.y, centre.y + digit.bendY * radius * 0.55, k);
                alpha *= 1 - progress(k, 0.9, 1);
            }
            if (digit.kind !== 'settle') {
                if (seconds < digit.join) {
                    // Loose digits stay clear of the mark's square while it reads.
                    const clear = keepOut(x, y);
                    alpha *= clear * 0.6 + 0.4 * (digit.kind === 'hover' ? 1 : clear);
                } else {
                    const u = progress(seconds, digit.join, digit.end);
                    const k = sine(u);
                    x = mix(x, cx + digit.targetX * R, k) + Math.sin(Math.PI * k) * digit.bendX * 40;
                    y = mix(y, cy + digit.targetY * R, k);
                    alpha = Math.max(alpha, 0.85) * (1 - progress(u, 0.93, 1));
                }
            }
            emit(x, y, digit.tone, digit.grey, alpha);
        }
        buckets.forEach((bucket, n) => {
            if (bucket.offset === 0) return;
            layers.push(travellerGlyphLayer({
                particles: bucket.particles.subarray(0, bucket.offset), ink: n >= alphaSteps ? greyFloatInk : 'sunrise',
                alpha: ((n % alphaSteps) + 1) / alphaSteps,
            }));
        });
        return layers;
    };
}
