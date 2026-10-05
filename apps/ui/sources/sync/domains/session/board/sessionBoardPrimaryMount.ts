import type { SessionSurfaceItemV1 } from '@happier-dev/protocol/sessions/board';

import type { SessionBoardItemState } from './sessionBoardItemState';

/**
 * Which Board host a placement is rendered into. These are the incumbent panes and
 * destinations, named so the resolver can rank them; this module owns no pane
 * state and stores nothing.
 */
export type SessionBoardMountHost =
    | 'focusedDetails'
    | 'details'
    | 'mobileCockpit'
    | 'companion'
    | 'sidebar'
    | 'inlineTranscript';

/** Item-aware resolver supplied by the one mounted Session visibility owner. */
export type SessionBoardPrimaryMountResolver = (itemId: string) => SessionBoardMountHost | null;

/**
 * Deterministic host precedence for the one executable mount (Plan 03 §3.10).
 *
 * V1 gives an executable item exactly one interactive placement per viewer and
 * window. This is a PURE derivation from facts the incumbent pane, navigation and
 * focus owners already publish — there is no primary-mount store, provider,
 * registry, persisted fact or arbiter service, and user activation changes only
 * those existing owners.
 */
export const SESSION_BOARD_MOUNT_HOST_PRECEDENCE: readonly SessionBoardMountHost[] = Object.freeze([
    'focusedDetails',
    'details',
    'mobileCockpit',
    'companion',
    'sidebar',
    'inlineTranscript',
]);

export type SessionBoardPrimaryMountInput = Readonly<{
    /** The window/app is foreground. A background window drives no executable mount. */
    foreground: boolean;
    /** Hosts currently rendering this item, from the incumbent pane/navigation owners. */
    visibleHosts: readonly SessionBoardMountHost[];
    /** The host that currently owns keyboard focus, when one does. */
    focusedHost?: SessionBoardMountHost | null;
}>;

export function resolveSessionBoardPrimaryMountHost(
    input: SessionBoardPrimaryMountInput,
): SessionBoardMountHost | null {
    if (!input.foreground) return null;
    const visible = new Set(input.visibleHosts);
    if (input.focusedHost && visible.has(input.focusedHost)) return input.focusedHost;
    return SESSION_BOARD_MOUNT_HOST_PRECEDENCE.find((host) => visible.has(host)) ?? null;
}

export type SessionBoardMountMode =
    /** Renders live and may accept interaction. */
    | 'executable'
    /** Renders a truthful native preview with an Open here affordance. */
    | 'preview'
    /** Nothing renderable: the state card explains why. */
    | 'inert';

/**
 * Whether an item source needs the single executable mount.
 *
 * Declarative documents are host-rendered native content with no frame, process or
 * Host API of their own, so they render live in every visible placement. Only
 * sources that mount an executable surface are restricted to one placement.
 */
export function sessionBoardSourceRequiresExclusiveMount(
    sourceKind: SessionSurfaceItemV1['source']['kind'],
): boolean {
    return sourceKind === 'widget' || sourceKind === 'hostedHtml';
}

export function resolveSessionBoardMountMode(input: Readonly<{
    host: SessionBoardMountHost;
    primaryHost: SessionBoardMountHost | null;
    state: SessionBoardItemState;
}>): SessionBoardMountMode {
    if (input.state.kind !== 'ready') return 'inert';
    if (!sessionBoardSourceRequiresExclusiveMount(input.state.item.source.kind)) return 'executable';
    return input.host === input.primaryHost ? 'executable' : 'preview';
}
