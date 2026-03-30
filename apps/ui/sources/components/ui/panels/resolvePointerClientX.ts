import { resolvePointerClientPoint } from './resolvePointerClientPoint';

export function resolvePointerClientX(event: unknown): number | null {
    return resolvePointerClientPoint(event).x;
}
