import {
    fieldDotLayer, glyphFrame, markGlyphLayer, markGlyphTone, planetGlyphLayer, travellerGlyphLayer,
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
    const cellTimeline = new Float32Array(raster.sprites.glyph.length * 4);
    const occupied = new Set<number>();
    const columns = raster.grid.cols;
    const cellIndex = (x: number, y: number) => Math.floor(y / cell[1]) * columns + Math.floor(x / cell[0]);
    for (let i = 0; i < raster.sprites.at.length; i += 2) {
        occupied.add(cellIndex(raster.sprites.at[i], raster.sprites.at[i + 1]));
    }
    const sources: Array<Readonly<{ point: GlyphPoint; tone: number; departure: number }>> = [];
    const travels: Travel[] = [];
    const launch = cursor ?? (phone ? { x: width / 2, y: height + 12 } : undefined);
    // The traveller layer accepts the brand's packed start/end/emit/duration/arc/tone tuples.
    for (let index = 0; index < raster.sprites.glyph.length; index++) {
        const point = { x: raster.sprites.at[2 * index], y: raster.sprites.at[2 * index + 1] };
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
                });
            }
        }
    }
    const particles = new Float32Array(travels.length * particleStride);
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
        };
    });
    const floatingColor = new Float32Array(floaters.length * particleStride);
    const floatingGrey = new Float32Array(floaters.length * particleStride);
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
                intensity: 'full', digits: true, assemble: { startS: 1.55, durationS: 2.38 - 1.55 },
            }));
        }
        let offset = 0;
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
            particles[offset++] = x;
            particles[offset++] = y;
            particles[offset++] = x;
            particles[offset++] = y;
            particles[offset++] = 0;
            particles[offset++] = openingSceneSeconds;
            particles[offset++] = 0;
            particles[offset++] = travel.tone;
        }
        if (offset > 0) layers.push(travellerGlyphLayer({ particles: particles.subarray(0, offset), ink: 'sunrise' }));
        let colorOffset = 0;
        let greyOffset = 0;
        for (const digit of floaters) {
            if (seconds < digit.born || seconds >= digit.end) continue;
            const looseTime = Math.min(seconds, digit.join);
            const angle = digit.angle + digit.speed * looseTime;
            let x: number;
            let y: number;
            if (digit.kind === 'hover') {
                x = centre.x + Math.cos(angle) * digit.radius * radius;
                y = centre.y + Math.sin(angle) * digit.radius * radius * 0.9 + Math.sin(looseTime * 1.3 + digit.angle) * 6;
            } else if (digit.kind === 'drift') {
                x = digit.x + digit.vx * looseTime + Math.sin(looseTime * 0.9 + digit.angle) * 10;
                y = digit.y + digit.vy * looseTime + Math.cos(looseTime * 0.7 + digit.angle) * 8;
                if (seconds < digit.join && Math.max(Math.abs(x - centre.x), Math.abs(y - centre.y)) < radius * 1.02) continue;
            } else {
                if (seconds >= digit.settle) continue;
                const k = sine(progress(seconds, digit.born, digit.settle));
                x = mix(digit.x, centre.x + digit.bendX * radius * 0.55, k);
                y = mix(digit.y, centre.y + digit.bendY * radius * 0.55, k);
            }
            if (seconds >= digit.join) {
                const k = sine(progress(seconds, digit.join, digit.end));
                x = mix(x, cx + digit.targetX * R, k) + Math.sin(Math.PI * k) * digit.bendX * 40;
                y = mix(y, cy + digit.targetY * R, k);
            }
            const output = digit.grey ? floatingGrey : floatingColor;
            let offset = digit.grey ? greyOffset : colorOffset;
            output[offset++] = x;
            output[offset++] = y;
            output[offset++] = x;
            output[offset++] = y;
            output[offset++] = 0;
            output[offset++] = openingSceneSeconds;
            output[offset++] = 0;
            output[offset++] = digit.tone;
            if (digit.grey) greyOffset = offset;
            else colorOffset = offset;
        }
        if (colorOffset > 0) layers.push(travellerGlyphLayer({ particles: floatingColor.subarray(0, colorOffset), ink: 'sunrise' }));
        if (greyOffset > 0) layers.push(travellerGlyphLayer({ particles: floatingGrey.subarray(0, greyOffset), ink: greyFloatInk }));
        return layers;
    };
}
