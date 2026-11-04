import { DESKTOP_ACTIVITY_OVERLAY_EXPANDED_HOVER_LEAVE_COLLAPSE_DELAY_MS } from '../../desktopActivityOverlayTiming';

export type NotchSurface = 'hidden' | 'tip' | 'camera_tip' | 'collapsed' | 'peek' | 'expanded' | 'pinned';
export type NotchPresentationFacts = Readonly<{
    enabled: boolean; visible: boolean; idle: 'tip' | 'full' | 'hidden'; cameraNotch: boolean;
    hoverExpandDelayMs: number; draftLocked: boolean; focusWithin: boolean; blockingCard: boolean;
}>;
export type NotchPresentationState = Readonly<{
    surface: NotchSurface; engaged: boolean; pending: 'dwell' | 'leave' | null; pointerInside: boolean;
}>;
export type NotchPresentationEvent =
    | { type: 'facts'; facts: NotchPresentationFacts }
    | { type: 'set'; state: 'rest' | 'open' | 'pinned' }
    | { type: 'enter' | 'leave' | 'dwell' | 'leaveElapsed' | 'click' | 'pin' | 'rest' | 'escape' | 'outsidePress' };

export function createNotchPresentation(facts: NotchPresentationFacts): NotchPresentationState {
    return { surface: restSurface(facts), engaged: false, pending: null, pointerInside: false };
}

function restSurface(facts: NotchPresentationFacts): NotchSurface {
    if (!facts.enabled) return 'hidden';
    if (facts.visible || facts.idle === 'full') return 'collapsed';
    if (facts.idle === 'hidden') return 'hidden';
    return facts.cameraNotch ? 'camera_tip' : 'tip';
}

function heldOpen(facts: NotchPresentationFacts): boolean {
    return facts.draftLocked || facts.focusWithin || facts.blockingCard;
}

function isOpen(surface: NotchSurface): boolean {
    return surface === 'expanded' || surface === 'pinned';
}

/** Facts enter here once; native and the main-window producer never choose presentation. */
export function reduceNotchPresentation(state: NotchPresentationState, event: NotchPresentationEvent, currentFacts: NotchPresentationFacts): NotchPresentationState {
    const facts = event.type === 'facts' ? event.facts : currentFacts;
    let next = state;
    if (!facts.enabled) {
        next = createNotchPresentation(facts);
    } else if (event.type === 'facts') {
        if (state.surface === 'peek' || isOpen(state.surface)) {
            next = { ...state, pending: state.surface === 'pinned' || state.pointerInside || heldOpen(facts) ? null : 'leave' };
        } else {
            const surface = restSurface(facts);
            next = surface === state.surface ? state : surface === 'hidden'
                ? createNotchPresentation(facts)
                : { surface, engaged: state.pointerInside && surface === 'collapsed', pointerInside: state.pointerInside,
                    pending: state.pointerInside ? 'dwell' : null };
        }
    } else {
        switch (event.type) {
            case 'set':
                next = event.state === 'rest' ? createNotchPresentation(facts)
                    : { ...state, surface: event.state === 'open' ? 'expanded' : 'pinned', engaged: true, pending: null };
                break;
            case 'enter':
                if (state.surface === 'hidden') break;
                // Native crossing demand covers the dwell; a short tip crossing presents nothing.
                next = { ...state, engaged: state.surface !== 'tip' && state.surface !== 'camera_tip', pointerInside: true,
                    pending: state.surface === 'tip' || state.surface === 'camera_tip' || state.surface === 'collapsed' ? 'dwell' : null };
                break;
            case 'leave':
                next = { ...state, pointerInside: false, engaged: state.surface === 'peek' || isOpen(state.surface),
                    pending: (state.surface === 'peek' || state.surface === 'expanded') && !heldOpen(facts) ? 'leave' : null };
                break;
            case 'dwell':
                if (state.pending === 'dwell' && state.pointerInside) next = {
                    ...state, surface: state.surface === 'collapsed' ? 'expanded' : 'peek', engaged: true, pending: null,
                };
                break;
            case 'leaveElapsed':
                if (state.pending === 'leave' && !heldOpen(facts)) next = createNotchPresentation(facts);
                break;
            case 'click':
                if (state.surface !== 'hidden') next = { ...state, surface: 'expanded', engaged: true, pending: null };
                break;
            case 'pin':
                next = state.surface === 'pinned' ? createNotchPresentation(facts) : { ...state, surface: 'pinned', engaged: true, pending: null };
                break;
            case 'escape':
                if (!facts.draftLocked) next = createNotchPresentation(facts);
                break;
            case 'outsidePress':
                next = createNotchPresentation(facts);
                break;
            case 'rest':
                next = createNotchPresentation(facts);
                break;
        }
    }
    return next.surface === state.surface && next.engaged === state.engaged && next.pending === state.pending && next.pointerInside === state.pointerInside
        ? state : next;
}

export function notchPresentationDelay(state: NotchPresentationState, facts: NotchPresentationFacts): number | null {
    return state.pending === 'dwell' ? facts.hoverExpandDelayMs
        : state.pending === 'leave' ? DESKTOP_ACTIVITY_OVERLAY_EXPANDED_HOVER_LEAVE_COLLAPSE_DELAY_MS : null;
}
