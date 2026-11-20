import { captureElementFlightRect } from '../rectFlight';
import type { StepAnchor } from './stepMotionTypes';

const stepControls = 'button, a[href], input, textarea, select, [role="button"], [role="link"], [role="radio"], [role="tab"], [role="option"]';

export function findInteractiveWebStepTarget(target: EventTarget | null): HTMLElement | null {
    return target instanceof Element ? target.closest<HTMLElement>(stepControls) : null;
}

export function findPressedWebControl(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof Element)) return null;
    return findInteractiveWebStepTarget(target) ?? target.closest<HTMLElement>('[data-testid]');
}

export function readWebStepAnchor(region: HTMLElement, control: HTMLElement | null): StepAnchor | null {
    return control && control !== region && region.contains(control)
        ? { testID: control.dataset.testid, rect: captureElementFlightRect(control) }
        : null;
}

export function findWebStepAnchor(region: HTMLElement, testID: string): HTMLElement | null {
    return region.querySelector<HTMLElement>(`[data-testid="${CSS.escape(testID)}"]`);
}
