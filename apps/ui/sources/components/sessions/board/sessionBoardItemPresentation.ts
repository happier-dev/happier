import { readSessionSurfaceNoteTextV1, type SessionSurfaceItemV1 } from '@happier-dev/protocol/sessions/board';
import { readBuiltinWidgetDescriptorV1 } from '@happier-dev/protocol/widgets';

import type { SessionBoardItemState } from '@/sync/domains/session/board';
import type { SessionBoardMountMode } from '@/sync/domains/session/board';
import type { SessionPluginRuntimeState } from '@/components/sessions/plugins/useSessionPluginRuntime';
import type { PluginUiPolicyEvaluationContext } from '@/sync/domains/plugins/ui/policy';
import type { SurfaceStateKind } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

/**
 * How a Board item is presented, given what its record proves and what this
 * device can actually render.
 *
 * Record truth (ready, locked, malformed, missing) comes from the Board domain
 * projector. Renderer truth (can this client mount this source at all) is a
 * client-current fact and belongs here, beside the hosts that own mounting.
 */

export type SessionBoardSourceAvailability =
    | Readonly<{ kind: 'available' }>
    | Readonly<{ kind: 'unavailable'; reason: SessionBoardSourceUnavailableReason }>;

export type SessionBoardSourceUnavailableReason =
    /** PEP's hosted-HTML renderer is not present in this build. */
    | 'hosted_html_renderer_unavailable'
    /** PEP's installed `widget` contribution/lifecycle is not present in this build. */
    | 'session_widget_contribution_unavailable'
    /** The referenced plugin is not installed, is disabled, or was retired on this device. */
    | 'plugin_unavailable';

export type SessionBoardSourceAvailabilityResolver = (
    source: SessionSurfaceItemV1['source'],
    /**
     * The embedded presentation this host will actually mount. `SessionWidgetHost` owns
     * `expanded`, so it is the one place that knows whether the mount fills its host; deriving
     * it again from the persisted `frame` here made the chrome and the mount answer
     * "is this renderer admitted" from two different presentations.
     */
    context?: Readonly<{ presentation?: 'content' | 'fill' }>,
) => SessionBoardSourceAvailability;

const AVAILABLE: SessionBoardSourceAvailability = Object.freeze({ kind: 'available' });
const NO_WIDGET_CONTRIBUTION: SessionBoardSourceAvailability = Object.freeze({
    kind: 'unavailable' as const,
    reason: 'session_widget_contribution_unavailable' as const,
});
const NO_HTML_RENDERER: SessionBoardSourceAvailability = Object.freeze({
    kind: 'unavailable' as const,
    reason: 'hosted_html_renderer_unavailable' as const,
});
/** Renderer presence only. The configured body admits its own exact bound target. */
export function createSessionBoardSourceAvailabilityResolver(
    _runtime: SessionPluginRuntimeState | null | undefined,
    options?: Readonly<{ hostedHtmlRendererAvailable?: boolean; policyContext?: PluginUiPolicyEvaluationContext }>,
): SessionBoardSourceAvailabilityResolver {
    return (source) => {
        if (source.kind === 'declarative' || source.kind === 'walkthrough') return AVAILABLE;
        if (source.kind === 'hostedHtml') return options?.hostedHtmlRendererAvailable === true ? AVAILABLE : NO_HTML_RENDERER;
        if (source.kind === 'widget' && source.instance.definition.kind === 'installed') return AVAILABLE;
        if (source.kind === 'widget' && readBuiltinWidgetDescriptorV1(source.instance.definition)) return AVAILABLE;
        return NO_WIDGET_CONTRIBUTION;
    };
}

/** The resolver a host with no plugin projection uses. */
export const defaultSessionBoardSourceAvailability: SessionBoardSourceAvailabilityResolver =
    createSessionBoardSourceAvailabilityResolver(null);

/**
 * Whether the person can open this item in a Board editor at all.
 *
 * Caller-authored HTML has one. A declarative item has one only for the exact
 * shape the Note editor round-trips: the same Board Action an Agent uses may
 * author any admitted presentational document, and offering Edit on one of those
 * would draw a control that does nothing when pressed. Installed surfaces are
 * edited by their plugin, never here.
 */
export function isSessionBoardItemEditableInPlace(item: SessionSurfaceItemV1): boolean {
    const source = item.source;
    if (source.kind === 'hostedHtml') return true;
    return source.kind === 'declarative' && readSessionSurfaceNoteTextV1(source.document) !== null;
}

/** Which host affordance a state offers, bound by the widget host to a real handler. */
export type SessionBoardItemActionKind =
    | 'remove'
    | 'openHere'
    | 'managePlugin'
    | 'prepareEncryption';

export type SessionBoardItemStateCard = Readonly<{
    kind: SurfaceStateKind;
    title: string;
    reason: string;
    /** Machine code for diagnostics only; never visible copy. */
    diagnosticCode: string | null;
    /**
     * Independent recovery paths in visual priority order. An unavailable
     * installed widget needs both its personal plugin-management route and,
     * when the viewer may edit the Board, the destructive shared-item route.
     */
    actionKinds: readonly SessionBoardItemActionKind[];
}>;

export type SessionBoardItemPresentation =
    /** Render the item's own content. */
    | Readonly<{ kind: 'content' }>
    /** A truthful inert preview of content that is interactive in another placement. */
    | Readonly<{ kind: 'preview'; actionKind: 'openHere' | null }>
    | Readonly<{ kind: 'state'; card: SessionBoardItemStateCard }>;

function stateCard(card: SessionBoardItemStateCard): SessionBoardItemPresentation {
    return Object.freeze({ kind: 'state' as const, card: Object.freeze(card) });
}

const CONTENT: SessionBoardItemPresentation = Object.freeze({ kind: 'content' as const });

export function resolveSessionBoardItemPresentation(input: Readonly<{
    state: SessionBoardItemState;
    mountMode: SessionBoardMountMode;
    /** Lane 04 `editSessionRecords`. Omitted affordances are absent, not mysteriously disabled. */
    canEdit: boolean;
    /** Whether this host can hand the item to another placement. */
    canOpenElsewhere: boolean;
    resolveSourceAvailability?: SessionBoardSourceAvailabilityResolver;
    /** The mounting host's own embedded presentation; it owns `expanded`, this module does not. */
    embeddedPresentation?: 'content' | 'fill';
}>): SessionBoardItemPresentation {
    const removeAction = input.canEdit ? 'remove' as const : null;
    switch (input.state.kind) {
        case 'loading':
            return stateCard({
                kind: 'loading',
                title: t('sessionBoard.item.loading.title'),
                reason: t('sessionBoard.item.loading.reason'),
                diagnosticCode: null,
                actionKinds: [],
            });
        case 'locked':
            return stateCard({
                kind: 'unavailable',
                title: t('sessionBoard.item.locked.title'),
                reason: t('sessionBoard.item.locked.reason'),
                diagnosticCode: 'session_board_item_locked',
                actionKinds: ['prepareEncryption'],
            });
        case 'unopenable':
            return stateCard({
                kind: 'error',
                title: t('sessionBoard.item.unopenable.title'),
                reason: t('sessionBoard.item.unopenable.reason'),
                diagnosticCode: `session_board_item_${input.state.reason}`,
                actionKinds: removeAction ? [removeAction] : [],
            });
        case 'unsupported':
            return stateCard({
                kind: 'unavailable',
                title: t('sessionBoard.item.unsupported.title'),
                reason: t('sessionBoard.item.unsupported.reason'),
                diagnosticCode: 'session_board_item_unsupported_version',
                actionKinds: [],
            });
        case 'missingReference':
            return stateCard({
                kind: 'error',
                title: t('sessionBoard.item.missing.title'),
                reason: t('sessionBoard.item.missing.reason'),
                diagnosticCode: 'session_board_item_not_found',
                actionKinds: removeAction ? [removeAction] : [],
            });
        case 'removed':
            return stateCard({
                kind: 'empty',
                title: t('sessionBoard.item.removed.title'),
                reason: t('sessionBoard.item.removed.reason'),
                diagnosticCode: 'session_board_item_removed',
                actionKinds: [],
            });
        case 'ready':
            break;
    }

    const availability = (input.resolveSourceAvailability ?? defaultSessionBoardSourceAvailability)(
        input.state.item.source,
        { presentation: input.embeddedPresentation ?? 'content' },
    );
    if (availability.kind === 'unavailable') {
        const pluginScoped = availability.reason !== 'hosted_html_renderer_unavailable';
        return stateCard({
            kind: 'unavailable',
            title: pluginScoped
                ? t('sessionBoard.item.pluginUnavailable.title')
                : t('sessionBoard.item.rendererUnavailable.title'),
            reason: pluginScoped
                ? t('sessionBoard.item.pluginUnavailable.reason')
                : t('sessionBoard.item.rendererUnavailable.reason'),
            diagnosticCode: availability.reason,
            // Plugin lifecycle recovery and shared Board deletion are different
            // intents. Never make one mutually exclusive with the other: a
            // disabled, uninstalled, or retired source remains manageable while
            // the retained Board record can still be removed by an editor.
            actionKinds: pluginScoped
                ? ['managePlugin', ...(removeAction ? [removeAction] : [])]
                : removeAction ? [removeAction] : [],
        });
    }

    if (input.mountMode === 'preview') {
        return Object.freeze({
            kind: 'preview' as const,
            actionKind: input.canOpenElsewhere ? 'openHere' as const : null,
        });
    }
    return CONTENT;
}

/** The one place a Board item's displayed name is decided. */
export function resolveSessionBoardItemTitle(state: SessionBoardItemState): string {
    if (state.kind !== 'ready') return t('sessionBoard.item.untitled');
    const title = state.item.title.trim();
    if (title.length > 0) return title;
    return state.item.source.kind === 'declarative'
        && readSessionSurfaceNoteTextV1(state.item.source.document) !== null
        ? t('sessionBoard.note.untitled')
        : t('sessionBoard.item.untitled');
}
