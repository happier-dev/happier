import type { MomentVectorCommand } from '@happier-dev/brand/planet-moments';
import {
  getHappierFontFamily,
  themeFontFamilyVariableName,
  type DefaultFontWeight,
  type MonoFontWeight,
} from '@/constants/Typography';

/**
 * The web interpreter of the brand moments' paint data (`planet-moments.mjs`). It owns no choreography:
 * vector commands are replayed in order on a 2D canvas and the lab's font names map to the typography owner's families.
 */
export type MomentCanvasEnv = Readonly<{
  /** Logical (css px) size of the canvas the commands address. */
  w: number;
  h: number;
  dpr: number;
  /** The Happier mark for `drawImage('happier-mark', …)`; skipped until it has loaded. */
  mark?: HTMLImageElement | null;
}>;

function themeFamily(
  kind: 'default' | 'mono',
  weight: DefaultFontWeight | MonoFontWeight,
): string {
  // Canvas text does not resolve CSS var(), so read the typography owner's variable.
  const held =
    typeof document === 'undefined'
      ? ''
      : getComputedStyle(document.documentElement)
          .getPropertyValue(themeFontFamilyVariableName(kind, weight))
          .trim();
  return (
    held ||
    `"${kind === 'mono' ? getHappierFontFamily('mono', weight as MonoFontWeight) : getHappierFontFamily('default', weight as DefaultFontWeight)}"`
  );
}

const fontCache = new Map<string, string>();
/** `500 9px "PlexMono", …` → the mono family; `600 11.5px InterLab, system-ui` → the sans family at that weight. */
export function momentCanvasFont(labFont: string): string {
  const cached = fontCache.get(labFont);
  if (cached) return cached;
  const match = /^(\d+)\s+([\d.]+px)\s+(.*)$/.exec(labFont);
  if (!match) return labFont;
  const [, weight, size, family] = match;
  const mono = /plex\s*mono|monospace/i.test(family);
  const resolved = mono
    ? `${weight} ${size} ${themeFamily('mono', Number(weight) >= 600 ? 'semiBold' : 'regular')}, ui-monospace, monospace`
    : `${weight} ${size} ${themeFamily('default', Number(weight) >= 600 ? 'semiBold' : Number(weight) >= 500 ? 'medium' : 'regular')}, system-ui, sans-serif`;
  fontCache.set(labFont, resolved);
  return resolved;
}

/** The fonts a frame's text needs, loaded once before its first paint. */
export function loadMomentFonts(): Promise<unknown> {
  if (typeof document === 'undefined' || !document.fonts)
    return Promise.resolve();
  return Promise.all([
    document.fonts.load(momentCanvasFont('500 12px "PlexMono"')),
    document.fonts.load(momentCanvasFont('500 12px InterLab')),
    document.fonts.load(momentCanvasFont('600 12px InterLab')),
  ]);
}

type Gradient = CanvasGradient;
/** Replays one frame's commands in order. The caller clears and sets the device-pixel transform. */
export function paintMomentCommands(
  context: CanvasRenderingContext2D,
  commands: readonly MomentVectorCommand[],
  env: MomentCanvasEnv,
) {
  const gradients = new Map<number, Gradient>();
  for (const command of commands) {
    switch (command[0]) {
      case 'set': {
        const [, key, value] = command;
        if (key === 'font') context.font = momentCanvasFont(value as string);
        else if (typeof value === 'object' && value !== null) {
          const gradient = gradients.get(value.gradient);
          if (gradient) context[key as 'fillStyle' | 'strokeStyle'] = gradient;
        } else (context as unknown as Record<string, unknown>)[key] = value;
        break;
      }
      case 'createLinearGradient': {
        const [, id, x0, y0, x1, y1] = command;
        gradients.set(id, context.createLinearGradient(x0, y0, x1, y1));
        break;
      }
      case 'createRadialGradient': {
        const [, id, x0, y0, r0, x1, y1, r1] = command;
        gradients.set(id, context.createRadialGradient(x0, y0, r0, x1, y1, r1));
        break;
      }
      case 'addColorStop': {
        const [, id, offset, colour] = command;
        gradients.get(id)?.addColorStop(offset, colour);
        break;
      }
      case 'drawImage': {
        if (env.mark?.complete && env.mark.naturalWidth > 0) {
          const [, , x, y, w, h] = command;
          context.drawImage(env.mark, x, y, w, h);
        }
        break;
      }
      case 'save':
        context.save();
        break;
      case 'restore':
        context.restore();
        break;
      case 'beginPath':
        context.beginPath();
        break;
      case 'stroke':
        context.stroke();
        break;
      case 'fill':
        if (command[1]) context.fill(command[1]);
        else context.fill();
        break;
      case 'translate':
        context.translate(command[1], command[2]);
        break;
      case 'scale':
        context.scale(command[1], command[2]);
        break;
      case 'roundRect': {
        const [, x, y, w, h, r] = command;
        context.roundRect(x, y, w, h, r);
        break;
      }
      case 'arc': {
        const [, x, y, r, a0, a1] = command;
        context.arc(x, y, r, a0, a1);
        break;
      }
      case 'fillRect': {
        const [, x, y, w, h] = command;
        context.fillRect(x, y, w, h);
        break;
      }
      case 'fillText':
        context.fillText(command[1], command[2], command[3]);
        break;
      case 'setLineDash':
        context.setLineDash([...command[1]]);
        break;
    }
  }
}

/** A canvas of `w × h` css px at `dpr`, cleared, with css-px drawing coordinates. */
export function prepareMomentCanvas(
  canvas: HTMLCanvasElement,
  w: number,
  h: number,
  dpr: number,
): CanvasRenderingContext2D | null {
  const pw = Math.round(w * dpr),
    ph = Math.round(h * dpr);
  if (canvas.width !== pw) canvas.width = pw;
  if (canvas.height !== ph) canvas.height = ph;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, pw, ph);
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  return context;
}
