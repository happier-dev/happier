import { captureElementFlightRect } from '../rectFlight';
import { copyWebCanvasPixels, releaseCanvasBackingStore } from '../../media/canvasBackingStore';
import type { StepFreeze, StepMotionLayerHandle } from './stepMotionTypes';

const keyframeMetadata = new Set(['offset', 'computedOffset', 'easing', 'composite']);

function copyAnimatedStyles(root: HTMLElement, clone: HTMLElement) {
  const animations = root.getAnimations?.({ subtree: true });
  if (!animations?.length || typeof KeyframeEffect === 'undefined') return;
  const originals = [root, ...root.querySelectorAll('*')];
  const copies = [clone, ...clone.querySelectorAll('*')];
  for (const { effect } of animations) {
    if (!(effect instanceof KeyframeEffect) || !effect.target) continue;
    const copy = copies[originals.indexOf(effect.target)];
    if (!(copy instanceof HTMLElement || copy instanceof SVGElement)) continue;
    const style = getComputedStyle(effect.target);
    const properties = new Set(effect.getKeyframes().flatMap(Object.keys));
    for (const property of properties) {
      if (keyframeMetadata.has(property)) continue;
      const name = property.startsWith('--') ? property : property.replace(/[A-Z]/g, capital => `-${capital.toLowerCase()}`);
      copy.style.setProperty(name, style.getPropertyValue(name));
    }
    copy.style.animationName = 'none';
    copy.style.transitionProperty = 'none';
  }
}

/** A paint-only copy of a web region, placed where the region stands. */
export function copyRegion(root: HTMLElement, rect: StepFreeze['rect'], freezeEffects = false) {
  const clone = root.cloneNode(true) as HTMLElement;
  if (freezeEffects) copyAnimatedStyles(root, clone);
  Object.assign(clone.style, {
    position: 'fixed',
    pointerEvents: 'none',
    margin: '0',
    inset: 'auto',
    left: `${rect.x}px`,
    top: `${rect.y}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  });
  const canvasCopies = clone.querySelectorAll('canvas');
  root.querySelectorAll('canvas').forEach((source, index) => copyWebCanvasPixels(source, canvasCopies[index]));
  return clone;
}

/** Mount copies above the app, inert and hidden from assistive technology; returns their removal. */
export function mountPaintCopy(
  regions: readonly HTMLElement[],
  backdrop: string | undefined,
  workflow: Readonly<{ source: HTMLElement; clone: HTMLElement }>,
) {
  const capture = document.createElement('div');
  Object.assign(capture.style, {
    position: 'fixed',
    inset: '0',
    pointerEvents: 'none',
    zIndex: '1000',
    ...(backdrop ? { backgroundColor: backdrop } : null),
  });
  capture.inert = true;
  capture.setAttribute('aria-hidden', 'true');
  capture.append(...regions);
  // Removing IDs keeps the real destination the single owner of IDs referenced by labels, focus
  // return, form submission and the app test harness.
  for (const element of capture.querySelectorAll(
    '[id], [data-testid], [autofocus], a[href], [name]',
  )) {
    for (const key of ['id', 'data-testid', 'autofocus', 'href', 'name'])
      element.removeAttribute(key);
  }
  document.body.append(capture);
  if (backdrop) {
    // A cloned text field keeps its value but needs a layout before it can scroll.
    const copies = workflow.clone.querySelectorAll('input');
    workflow.source.querySelectorAll('input').forEach((input, index) => {
      const scrollLeft = input.scrollLeft;
      if (scrollLeft !== 0) copies[index].scrollLeft = scrollLeft;
    });
  }
  return { webBackdrop: backdrop ? capture : undefined, release: () => {
    capture.querySelectorAll('canvas').forEach(canvas => releaseCanvasBackingStore(canvas));
    capture.remove();
  } };
}

export function copyStepAtmosphere(layer: StepMotionLayerHandle, backdrop?: string) {
  const atmosphere = backdrop ? layer.webAtmosphere?.() : undefined;
  return atmosphere ? copyRegion(atmosphere, captureElementFlightRect(atmosphere), true) : undefined;
}

/**
 * The cross-fade's outgoing step on web: the layer and its chrome as they stand at the press, so the
 * departing step stays painted until the next one has risen in. Native has no synchronous copy.
 */
export function copyStepLayer(layer: StepMotionLayerHandle, backdrop?: string): StepFreeze | null {
  const root = layer.webElement();
  if (!root || typeof root.animate !== 'function') return null;
  const rect = captureElementFlightRect(root);
  if (rect.width <= 0 || rect.height <= 0) return null;
  const clone = copyRegion(root, rect, backdrop !== undefined);
  const webAtmosphere = copyStepAtmosphere(layer, backdrop);
  const webChrome = (layer.webChrome?.(backdrop ? 'shell' : undefined) ?? []).map((region) =>
    copyRegion(region, captureElementFlightRect(region), backdrop !== undefined),
  );
  return {
    clone,
    rect,
    webChrome,
    webAtmosphere,
    ...mountPaintCopy(webAtmosphere ? [webAtmosphere, clone, ...webChrome] : [clone, ...webChrome], backdrop, { source: root, clone }),
  };
}
