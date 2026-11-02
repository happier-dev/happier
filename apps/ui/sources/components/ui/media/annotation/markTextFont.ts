import { getDefaultFont } from '@/constants/Typography';

import type { MeasureMarkText } from './markGeometry';

/**
 * The one face text marks are drawn, measured and burned in (MIS §3.4: Inter semibold). The theme hands
 * the family out as a CSS variable on the web, which a canvas cannot read, so it is resolved once
 * through the document; the canvas preview and flatten then agree on every label's width.
 */
let resolvedFamily: string | null = null;
export function markTextFontFamily(): string {
  if (resolvedFamily) return resolvedFamily;
  const family = getDefaultFont('semiBold');
  if (typeof document === 'undefined' || !family.includes('var(')) return (resolvedFamily = family);
  const probe = document.createElement('span');
  probe.style.fontFamily = family;
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  document.body.appendChild(probe);
  resolvedFamily = getComputedStyle(probe).fontFamily || family;
  probe.remove();
  return resolvedFamily;
}

export function markTextFont(fontSize: number): string {
  return `${fontSize}px ${markTextFontFamily()}`;
}

let measureContext: CanvasRenderingContext2D | null | undefined;
export const measureMarkText: MeasureMarkText = (text, fontSize) => {
  if (measureContext === undefined)
    measureContext = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  if (!measureContext) return text.length * fontSize * 0.55;
  measureContext.font = markTextFont(fontSize);
  return measureContext.measureText(text).width;
};
