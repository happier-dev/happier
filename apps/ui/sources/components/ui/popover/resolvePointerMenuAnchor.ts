import { resolvePointerClientPoint } from '@happier-dev/plugin-ui/presentation';

import type { PopoverAnchor } from './_types';

/**
 * The anchor of a context menu opened from a right click or a long press: a 1 px rect at the event's
 * window point (read by the shared pointer-point owner). Undefined when the event carries no point,
 * so the menu falls back to its trigger.
 */
export function resolvePointerMenuAnchor(event: unknown): PopoverAnchor | undefined {
    const { x, y } = resolvePointerClientPoint(event);
    if (x === null || y === null) return undefined;
    return { kind: 'rect', rect: { left: x, top: y, height: 1 }, coordinateSpace: 'window' };
}

/**
 * The control a press came from, as an anchor: its host element (web) or host instance (native), so a surface
 * opened from that press hangs from the control and follows it. Undefined when the press carries no measurable
 * control (a keyboard shortcut, a programmatic call), so the caller falls back to its unanchored presentation.
 */
export function resolvePressTriggerAnchor(event: unknown): PopoverAnchor | undefined {
    const target = typeof event === 'object' && event !== null ? (event as Readonly<{ currentTarget?: unknown }>).currentTarget : undefined;
    if (typeof target !== 'object' || target === null) return undefined;
    const measurable = target as Readonly<{ getBoundingClientRect?: unknown; measureInWindow?: unknown }>;
    if (typeof measurable.getBoundingClientRect !== 'function' && typeof measurable.measureInWindow !== 'function') return undefined;
    return { kind: 'view', ref: { current: target as HTMLElement } };
}
