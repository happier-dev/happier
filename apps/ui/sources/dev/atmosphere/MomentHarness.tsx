import { createRoot } from 'react-dom/client';
import { createPairingGlyphSampler, FURTHER_PLANET_MOMENT_TIMINGS, pairingGlyphCell } from '@happier-dev/brand/planet-moments';
import { glyphFrame } from '@happier-dev/brand/glyph-scene';
import { readPairingQrMomentMark } from '@/components/auth/pairing/PairingQrMoment.web';
import { createPairingQrMomentFrames } from '@/components/auth/pairing/pairingQrMomentFrame';
import type { PairingQrMomentCanvasProps } from '@/components/auth/pairing/pairingQrMoment.types';
import { paintMomentCommands, prepareMomentCanvas } from '@/components/atmosphere/momentPaint.web';
import { releaseCanvasBackingStore } from '@/components/ui/media/canvasBackingStore';
import type { QrMomentFrameRequest } from '@/components/auth/pairing/pairingQrMomentTimeline';
import { registerWebThemePreferenceChoreography, runThemePreferenceChange } from '@/components/settings/appearance/themePreferenceTransition';
import { themeHorizonTransition } from '@/components/settings/appearance/themeHorizonTransition.web';

/** U9b drawing harness: the product moment painters at fixed times, beside the lab's own stills. */
const { QR, SCAN, PAIR } = FURTHER_PLANET_MOMENT_TIMINGS;
const mount = document.getElementById('product');
if (!mount) throw new Error('Missing harness mount');
createRoot(mount);

const defaultFrames = createPairingQrMomentFrames();
const defaultGlyphs = createPairingGlyphSampler();

/** This fixed-frame capture uses the canonical Still painter so the QR probe can read pixels. */
async function paintPairingQrMomentRequest(
  canvas: HTMLCanvasElement,
  request: QrMomentFrameRequest,
  props: PairingQrMomentCanvasProps,
  dpr: number,
  build = defaultFrames,
) {
  const { size } = props;
  const context = prepareMomentCanvas(canvas, size, size, dpr);
  if (!context) return;
  const env = { w: size, h: size, dpr, mark: readPairingQrMomentMark() };
  const view = { w: size, h: size };
  const frame = defaultGlyphs(build(request, props, dpr), view, dpr);
  paintMomentCommands(context, frame.behind, env);
  if (frame.planet) {
    const { warmWebGlyphAtlas, paintWebStill } = await import('@/components/atmosphere/glyph/glyphPainter.web');
    const sampled = glyphFrame({ view, dpr, theme: props.theme, layers: [frame.planet.layer], cell: pairingGlyphCell });
    const atlas = await warmWebGlyphAtlas(sampled.grid, dpr);
    const still = document.createElement('canvas');
    still.width = sampled.width; still.height = sampled.height;
    paintWebStill(still, sampled, atlas);
    context.save();
    context.globalAlpha = frame.planet.opacity;
    context.drawImage(still, 0, 0, size, size);
    context.restore();
    releaseCanvasBackingStore(still);
  }
  paintMomentCommands(context, frame.ahead, env);
}

async function frameCanvas(request: QrMomentFrameRequest, theme: 'light' | 'dark', size: number, machines: readonly string[]) {
    const canvas = document.createElement('canvas');
    canvas.style.width = `${size}px`; canvas.style.height = `${size}px`; canvas.style.display = 'block';
    await paintPairingQrMomentRequest(canvas, request, { size, theme, reducedMotion: false, pairing: true, machines }, window.devicePixelRatio || 1);
    return canvas;
}

const harness = {
    QR, SCAN, PAIR,
    /** A row of frames on a card, as the lab's timeline board lays them out. */
    async strip(requests: Array<[QrMomentFrameRequest, string]>, theme: 'light' | 'dark', size: number, card: string, machines: string[] = []) {
        const row = document.createElement('div');
        row.style.cssText = `display:flex;gap:16px;padding:16px;background:${theme === 'dark' ? '#131111' : '#f5f5f5'}`;
        for (const [request, caption] of requests) {
            const cell = document.createElement('div');
            cell.style.cssText = `display:flex;flex-direction:column;gap:8px;font:12px system-ui;color:${theme === 'dark' ? '#aaa' : '#555'}`;
            const box = document.createElement('div');
            box.style.cssText = `padding:16px;background:${card};border-radius:12px`;
            box.appendChild(await frameCanvas(request, theme, size, machines));
            cell.appendChild(box); cell.appendChild(document.createTextNode(caption));
            row.appendChild(cell);
        }
        document.body.appendChild(row);
        return row.getBoundingClientRect().height;
    },
    /** The exact pixels of one frame with the lab's 12 % white quiet zone (what a camera sees on the paper). */
    async heldPixels(request: QrMomentFrameRequest, size: number) {
        const canvas = await frameCanvas(request, 'light', size, []);
        const pad = Math.round(canvas.width * 0.12);
        const padded = document.createElement('canvas');
        padded.width = canvas.width + pad * 2; padded.height = canvas.height + pad * 2;
        const context = padded.getContext('2d')!;
        context.fillStyle = '#fff'; context.fillRect(0, 0, padded.width, padded.height); context.drawImage(canvas, pad, pad);
        return { rgba: Array.from(context.getImageData(0, 0, padded.width, padded.height).data), w: padded.width, h: padded.height };
    },
    image(src: string, crop: { x: number; y: number; w: number; h: number }, scale: number) {
        const box = document.createElement('div');
        box.style.cssText = `width:${crop.w * scale}px;height:${crop.h * scale}px;overflow:hidden;position:relative`;
        const img = document.createElement('img');
        img.src = src; img.style.cssText = `position:absolute;left:${-crop.x * scale}px;top:${-crop.y * scale}px;transform-origin:0 0;transform:scale(${scale})`;
        box.appendChild(img); document.body.appendChild(box);
        return new Promise(resolve => { img.onload = resolve; });
    },
    clear() { document.body.querySelectorAll(':scope > div:not(#product):not(#themed)').forEach(node => node.remove()); },
    /** The real web theme switch: a View Transition between two themed pages with the Horizon choreography. */
    async themeSwitch(to: 'light' | 'dark') {
        registerWebThemePreferenceChoreography(themeHorizonTransition);
        const page = document.getElementById('themed')!;
        await runThemePreferenceChange({
            currentPreference: to === 'light' ? 'dark' : 'light', nextPreference: to, platform: 'web', reduceMotion: false, systemTheme: 'light',
            mutation: () => { page.dataset.theme = to; },
            webMutationCommit: (mutation) => { mutation(); },
        });
    },
};
Object.assign(window, { U9B: harness });
