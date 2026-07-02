import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    ESCAPE_LAYER_PRIORITIES,
    dispatchEscapeToLayerStack,
    getMaxEscapeKeyBlockerPriority,
    isEscapeEventHandled,
    markEscapeEventHandled,
    registerEscapeKeyBlocker,
    registerEscapeLayer,
} from './escape';

afterEach(() => {
    vi.resetModules();
});

describe('escape layer stack', () => {
    it('dispatches Escape to the highest-priority layer and marks the event handled', () => {
        const low = vi.fn();
        const high = vi.fn();
        const event = {
            key: 'Escape',
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
            stopImmediatePropagation: vi.fn(),
        };

        const unregisterLow = registerEscapeLayer({ priority: 10, onEscape: low });
        const unregisterHigh = registerEscapeLayer({ priority: 20, onEscape: high });

        expect(dispatchEscapeToLayerStack(event)).toBe(true);
        expect(high).toHaveBeenCalledTimes(1);
        expect(low).not.toHaveBeenCalled();
        expect(isEscapeEventHandled(event)).toBe(true);
        expect(event.preventDefault).toHaveBeenCalledTimes(1);

        unregisterLow();
        unregisterHigh();
    });

    it('skips editable targets unless the layer explicitly allows them', () => {
        const blocked = vi.fn();
        const allowed = vi.fn(() => false);
        const event = {
            key: 'Escape',
            target: { tagName: 'TEXTAREA' },
        };

        const unregisterBlocked = registerEscapeLayer({ priority: 10, onEscape: blocked });
        const unregisterAllowed = registerEscapeLayer({ priority: 20, allowEditableTarget: true, onEscape: allowed });

        expect(dispatchEscapeToLayerStack(event)).toBe(false);
        expect(allowed).toHaveBeenCalledTimes(1);
        expect(blocked).not.toHaveBeenCalled();

        unregisterBlocked();
        unregisterAllowed();
    });

    it('includes registered layers and blockers in max priority', () => {
        const unregisterBlocker = registerEscapeKeyBlocker(300);
        const unregisterLayer = registerEscapeLayer({ priority: 200, onEscape: () => undefined });

        expect(getMaxEscapeKeyBlockerPriority()).toBe(300);

        unregisterBlocker();
        unregisterLayer();
    });

    it('places session-list selection below panes and overlays but above ordinary focus layers', () => {
        expect(ESCAPE_LAYER_PRIORITIES.sessionListSelection).toBeGreaterThan(ESCAPE_LAYER_PRIORITIES.focusSessionSurface);
        expect(ESCAPE_LAYER_PRIORITIES.sessionListSelection).toBeLessThan(ESCAPE_LAYER_PRIORITIES.pane);
        expect(ESCAPE_LAYER_PRIORITIES.sessionListSelection).toBeLessThan(ESCAPE_LAYER_PRIORITIES.overlay);
    });

    it('marks escape events handled defensively', () => {
        const event = {};
        markEscapeEventHandled(event);
        expect(isEscapeEventHandled(event)).toBe(true);
    });
});
