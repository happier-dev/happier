import type { CurrentSessionPresentationIntentResultV1, CurrentSessionPresentationIntentV1 } from '@happier-dev/protocol/sessions';
import type { FrameRect, FloatingFrameMode } from '@happier-dev/plugin-ui/presentation';

export type SessionViewerSource = 'computer' | 'browser';
export type SessionViewerSemanticIntent = Extract<CurrentSessionPresentationIntentV1, { kind: `viewer.${string}` }>;
export type SessionViewerLocalIntent = SessionViewerSemanticIntent
    | Readonly<{ kind: 'viewer.dock' }>
    | Readonly<{ kind: 'viewer.corner.set'; corner: 'tl' | 'tr' | 'bl' | 'br' }>
    | Readonly<{ kind: 'viewer.size.set'; width: number }>;

export type SessionViewerPresentationState = Readonly<{
    source: SessionViewerSource | null;
    mode: FloatingFrameMode;
    corner: 'tl' | 'tr' | 'bl' | 'br';
    width: number | null;
    rect: FrameRect | null;
    restore: Readonly<{ mode: 'floating' | 'docked'; rect: FrameRect | null }> | null;
}>;

export const CLOSED_SESSION_VIEWER: SessionViewerPresentationState = Object.freeze({
    source: null, mode: 'closed', corner: 'br', width: null, rect: null, restore: null,
});

export type SessionViewerPresentationPort = Readonly<{
    apply: (intent: SessionViewerSemanticIntent) => CurrentSessionPresentationIntentResultV1;
}>;

/** Local presentation only; target selection, control and compute stay source-owned. */
export function resolveSessionViewerPresentation(
    state: SessionViewerPresentationState,
    intent: SessionViewerLocalIntent,
    input: Readonly<{ phone: boolean; canPresentSource: (source: SessionViewerSource) => boolean }>,
): Readonly<{ state: SessionViewerPresentationState; result: CurrentSessionPresentationIntentResultV1 }> {
    const unchanged = () => ({ state, result: { status: 'unchanged' } as const });
    const unavailable = () => ({ state, result: { status: 'unavailable' } as const });
    const applied = (next: SessionViewerPresentationState) => ({ state: next, result: { status: 'applied' } as const });
    switch (intent.kind) {
        case 'viewer.open':
        case 'viewer.source.select': {
            if (!input.canPresentSource(intent.source)) return unavailable();
            if (intent.kind === 'viewer.source.select' && state.mode === 'closed') return unavailable();
            const mode = state.mode === 'closed' ? input.phone ? 'docked' : 'floating' : state.mode;
            if (state.source === intent.source && state.mode === mode) return unchanged();
            return applied({ ...state, source: intent.source, mode });
        }
        case 'viewer.close':
            return state.mode === 'closed' ? unchanged() : applied({ ...state, mode: 'closed', restore: null });
        case 'viewer.expand':
            if (state.mode === 'closed' || state.mode === 'expanded') return unchanged();
            return applied({ ...state, mode: 'expanded', restore: { mode: state.mode, rect: state.rect } });
        case 'viewer.restore':
            if (state.mode !== 'expanded' || !state.restore) return unchanged();
            return applied({ ...state, mode: input.phone ? 'docked' : state.restore.mode, rect: state.restore.rect, restore: null });
        case 'viewer.dock':
            return state.mode === 'closed' || state.mode === 'docked' ? unchanged()
                : applied({ ...state, mode: 'docked', restore: null });
        case 'viewer.corner.set':
            if (input.phone) return unavailable();
            return state.corner === intent.corner ? unchanged() : applied({ ...state, corner: intent.corner });
        case 'viewer.size.set':
            if (input.phone) return unavailable();
            if (!Number.isFinite(intent.width) || intent.width <= 0) return { state, result: { status: 'invalidTarget' } };
            return state.width === intent.width ? unchanged() : applied({ ...state, width: intent.width });
    }
}
