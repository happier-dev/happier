import { captureElementFlightRect } from '../rectFlight';
import type { StepFreeze, StepMotionLayerHandle } from './stepMotionTypes';

/** A paint-only copy of a web region, placed where the region stands. */
export function copyRegion(root: HTMLElement, rect: StepFreeze['rect']) {
  const clone = root.cloneNode(true) as HTMLElement;
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
  return clone;
}

/** Mount copies above the app, inert and hidden from assistive technology; returns their removal. */
export function mountPaintCopy(regions: readonly HTMLElement[]) {
  const capture = document.createElement('div');
  Object.assign(capture.style, {
    position: 'fixed',
    inset: '0',
    pointerEvents: 'none',
    zIndex: '1000',
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
  return () => capture.remove();
}

/**
 * The cross-fade's outgoing step on web: the layer and its chrome as they stand at the press, so the
 * departing step stays painted until the next one has risen in. Native has no synchronous copy.
 */
export function copyStepLayer(layer: StepMotionLayerHandle): StepFreeze | null {
  const root = layer.webElement();
  if (!root || typeof root.animate !== 'function') return null;
  const rect = captureElementFlightRect(root);
  if (rect.width <= 0 || rect.height <= 0) return null;
  const clone = copyRegion(root, rect);
  const webChrome = (layer.webChrome?.() ?? []).map((region) =>
    copyRegion(region, captureElementFlightRect(region)),
  );
  return {
    clone,
    rect,
    webChrome,
    release: mountPaintCopy([clone, ...webChrome]),
  };
}
