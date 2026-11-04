import * as React from 'react';

import { motionTokens } from '@/components/ui/motion';

/** How long the pointer may be between a trigger and its preview before the preview closes. */
const HOVER_CLOSE_GRACE_MS = motionTokens.durationMs.fast;
/**
 * After a preview closes because the pointer left, a trigger entered this soon reopens it at once: the
 * pointer already showed its intent, and the preview may still be leaving (its exit turns around).
 */
const HOVER_REOPEN_WINDOW_MS = motionTokens.overlay.popover.hoverOpenDelayMs;

/**
 * Previews that answer one pointer intent, like the icons of a dock (the app rail's column peeks and
 * its popovers). Within a scope one preview shows at a time: while one shows, or just after it closed
 * because the pointer left, resting on any trigger of the scope opens its preview at once and closes
 * the other. Outside any scope each preview is its own scope.
 */
export type HoverPreviewScope = Readonly<{
    /** How long the pointer rests on a trigger before the scope's first preview opens. */
    openDelayMs: number;
    /** The preview showing now; another preview of the scope opening closes it. */
    showing: { current: HoverPreviewMember | null };
    /** Whether a preview of the scope just closed because the pointer left (`HOVER_REOPEN_WINDOW_MS`). */
    warm: () => boolean;
    startWarm: () => void;
    endWarm: () => void;
    dispose: () => void;
}>;

type HoverPreviewMember = { close: () => void };

export function createHoverPreviewScope(openDelayMs: number): HoverPreviewScope {
    let reopenTimer: ReturnType<typeof setTimeout> | null = null;
    const endWarm = () => {
        if (reopenTimer) clearTimeout(reopenTimer);
        reopenTimer = null;
    };
    return {
        openDelayMs,
        showing: { current: null },
        warm: () => reopenTimer !== null,
        startWarm: () => {
            endWarm();
            reopenTimer = setTimeout(() => { reopenTimer = null; }, HOVER_REOPEN_WINDOW_MS);
        },
        endWarm,
        dispose: endWarm,
    };
}

const HoverPreviewScopeContext = React.createContext<HoverPreviewScope | null>(null);

/** Puts the hover previews below it in one scope (`HoverPreviewScope`). */
export function HoverPreviewScopeProvider(props: Readonly<{ scope: HoverPreviewScope | null; children: React.ReactNode }>) {
    return React.createElement(HoverPreviewScopeContext.Provider, { value: props.scope }, props.children);
}

/** `preview`: opened by the pointer resting on the trigger, without focus. `open`: opened on purpose, focus moves in. */
export type HoverPreviewMode = 'closed' | 'preview' | 'open';

type HoverPreviewState<T> = Readonly<{ mode: HoverPreviewMode; target: T | null }>;

/** Closing is idempotent: an already closed state keeps its identity, so a no-op close renders nobody. */
function closed<T>(current: HoverPreviewState<T>): HoverPreviewState<T> {
    return current.mode === 'closed' && current.target === null ? current : { mode: 'closed', target: null };
}

export type HoverPreviewHandlers = Readonly<{ onPointerEnter: () => void; onPointerLeave: () => void }>;

/**
 * The open state of a surface that previews on hover. Resting the pointer on a trigger opens a
 * `preview` of that trigger's target after the scope's rest delay (the popover rest outside a scope);
 * leaving the trigger closes a preview after a short grace, which the pointer entering the preview
 * cancels. While one target is previewed, resting on another trigger switches to it at once, and a
 * trigger entered just after a preview closed reopens it at once (`HoverPreviewScope`). `open()` opens
 * it on purpose (a press or a key), which leaving never closes; Escape and outside presses close it
 * (`close`).
 *
 * One trigger (a popover button): spread `hoverProps` on the trigger and the popover's content.
 * Several (the rail's destinations over one column): `triggerHoverProps(target)` on each trigger and
 * `panelHoverProps` on the shared preview.
 */
export function useHoverPreviewPopover<T = true>(params: Readonly<{
    enabled: boolean;
    /** The scope this preview answers in; otherwise the one around it, or its own. */
    scope?: HoverPreviewScope | null;
}>) {
    const [state, setState] = React.useState<HoverPreviewState<T>>({ mode: 'closed', target: null });
    const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const clearTimer = React.useCallback(() => {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = null;
    }, []);
    const contextScope = React.useContext(HoverPreviewScopeContext);
    const [ownScope] = React.useState(() => createHoverPreviewScope(motionTokens.overlay.popover.hoverOpenDelayMs));
    const scope = params.scope ?? contextScope ?? ownScope;
    React.useEffect(() => () => {
        clearTimer();
        ownScope.dispose();
    }, [clearTimer, ownScope]);

    const close = React.useCallback(() => {
        clearTimer();
        scope.endWarm();
        setState(closed);
    }, [clearTimer, scope]);
    const open = React.useCallback((target: T = true as T) => {
        clearTimer();
        scope.endWarm();
        setState({ mode: 'open', target });
    }, [clearTimer, scope]);
    const toggle = React.useCallback((target: T = true as T) => {
        clearTimer();
        scope.endWarm();
        // A press on a previewing popover keeps it open and hands it to the press (focus moves in).
        setState((current) => (current.mode === 'open' ? { mode: 'closed', target: null } : { mode: 'open', target }));
    }, [clearTimer, scope]);

    // This preview as a member of its scope: showing, it closes the one that showed before it; another
    // member opening closes it at once, without its leave grace.
    const [member] = React.useState<HoverPreviewMember>(() => ({ close: () => {} }));
    member.close = () => {
        clearTimer();
        setState(closed);
    };
    const shown = state.mode !== 'closed';
    React.useEffect(() => {
        if (!shown) return;
        const previous = scope.showing.current;
        if (previous && previous !== member) previous.close();
        scope.showing.current = member;
        return () => {
            if (scope.showing.current === member) scope.showing.current = null;
        };
    }, [member, scope, shown]);

    const enterTrigger = React.useCallback((target: T) => {
        clearTimer();
        if (state.mode === 'closed') {
            const another = scope.showing.current !== null && scope.showing.current !== member;
            if (another || scope.warm()) {
                scope.endWarm();
                setState({ mode: 'preview', target });
                return;
            }
            timerRef.current = setTimeout(
                () => setState((current) => (current.mode === 'closed' ? { mode: 'preview', target } : current)),
                scope.openDelayMs,
            );
            return;
        }
        // Already showing: another trigger takes it over at once.
        if (!Object.is(state.target, target)) setState({ mode: 'preview', target });
    }, [clearTimer, member, scope, state.mode, state.target]);
    const enterPanel = React.useCallback(() => clearTimer(), [clearTimer]);
    const leave = React.useCallback(() => {
        clearTimer();
        if (state.mode === 'closed') return;
        const closesPreview = state.mode === 'preview';
        timerRef.current = setTimeout(() => {
            timerRef.current = null;
            setState((current) => (current.mode === 'preview' ? closed(current) : current));
            if (closesPreview) scope.startWarm();
        }, HOVER_CLOSE_GRACE_MS);
    }, [clearTimer, scope, state.mode]);

    const enabled = params.enabled;
    React.useEffect(() => {
        if (!enabled) close();
    }, [close, enabled]);
    const triggerHoverProps = React.useCallback(
        (target: T): HoverPreviewHandlers | null => (enabled ? { onPointerEnter: () => enterTrigger(target), onPointerLeave: leave } : null),
        [enabled, enterTrigger, leave],
    );
    const panelHoverProps = React.useMemo<HoverPreviewHandlers | null>(
        () => (enabled ? { onPointerEnter: enterPanel, onPointerLeave: leave } : null),
        [enabled, enterPanel, leave],
    );
    const hoverProps = React.useMemo(() => triggerHoverProps(true as T), [triggerHoverProps]);
    return { mode: state.mode, target: state.target, open, close, toggle, hoverProps, triggerHoverProps, panelHoverProps };
}
