import { captureElementFlightRect } from '../rectFlight';
import type { StepAnchor } from './stepMotionTypes';

export function readWebStepAnchor(region: HTMLElement, target: EventTarget | null): StepAnchor | null {
    if (!(target instanceof Element) || !region.contains(target)) return null;
    const control = target.closest<HTMLElement>('[data-testid]');
    if (control && control !== region && region.contains(control)) {
        return { testID: control.dataset.testid, rect: captureElementFlightRect(control) };
    }
    const pressed = target.closest<HTMLElement>('button, a, input, [role="button"]');
    return pressed && region.contains(pressed) ? { rect: captureElementFlightRect(pressed) } : null;
}

export function findWebStepAnchor(region: HTMLElement, testID: string): HTMLElement | null {
    return region.querySelector<HTMLElement>(`[data-testid="${CSS.escape(testID)}"]`);
}
