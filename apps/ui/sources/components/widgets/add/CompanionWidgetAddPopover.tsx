import * as React from 'react';
import type { View } from 'react-native';
import type { WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';

import type {
    SessionCompanionBuiltinItemId,
    SessionCompanionItemRefV1,
} from '@/components/sessions/companion/state/sessionCompanionPreference';
import type { SessionPluginRuntimeState } from '@/components/sessions/plugins/useSessionPluginRuntime';
import { selectWidgetCandidates, type WidgetCandidate } from '@/components/widgets/widgetCatalog';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import type { SessionBoardSnapshot } from '@/sync/domains/session/board';
import { t } from '@/text';

import { SessionBoardDeclarativeContent } from '@/components/sessions/board/SessionBoardDeclarativeContent';
import { widgetProvidedContext, type WidgetSurfaceContext } from '@/components/widgets/surface/widgetSurfaceSetup';
import { WidgetSetupPreview } from '@/components/widgets/surface/WidgetSetupPreview';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';

import { WidgetAddPopover } from './WidgetAddPopover';
import { buildCompanionWidgetAddSections } from './widgetAddSections';
import type { WidgetSetupDraft } from './widgetSetupModel';

const NO_CONTEXT: WidgetSurfaceContext = Object.freeze({});

/** A Board note, drawn inert (no action binding): the same renderer the Board card uses. */
const renderNotePreview = (document: unknown): React.ReactNode => (
    <SessionBoardDeclarativeContent document={document} actionBinding={null} testID="widget-add.note-preview" />
);

/** Everything the Companion's Add popover reads; the Companion keeps references only. */
export type CompanionWidgetAddSource = Readonly<{
    refs: readonly SessionCompanionItemRefV1[];
    snapshot: SessionBoardSnapshot | null;
    pluginProjection: PluginUiProjectionModel | null | undefined;
    /** The Session's plugin runtime: compact plugin glances are offered only while it is current. */
    pluginRuntime?: SessionPluginRuntimeState | null;
    addItem: (ref: SessionCompanionItemRefV1) => void;
    /** What the Companion fills on its own ("This session"); Set up offers it first. */
    context?: WidgetSurfaceContext;
    /** A glance's live preview, by built-in id (supplied by the glance owners). */
    renderGlancePreview?: (id: SessionCompanionBuiltinItemId) => React.ReactNode;
}>;

/**
 * Add to Companion (lab `cwidgets` WC3, round 2): the shared Gallery | List popover with the
 * Companion's three sources — Glances (built-ins and plugin views that declare the `companion`
 * placement), what is On this board, and Panes, added as a link row that opens in Details. Every
 * choice is one reference through the Companion's one add path; nothing is created on the Board.
 */
export function CompanionWidgetAddPopover(props: Readonly<{
    open: boolean;
    anchorRef: React.RefObject<View | null>;
    onRequestClose: () => void;
    source: CompanionWidgetAddSource;
    placement?: 'top' | 'bottom';
    testID: string;
}>): React.ReactElement | null {
    if (!props.open) return null;
    return <OpenCompanionWidgetAddPopover {...props} />;
}

function OpenCompanionWidgetAddPopover(props: React.ComponentProps<typeof CompanionWidgetAddPopover>): React.ReactElement {
    const { refs, snapshot, pluginProjection, pluginRuntime, addItem, renderGlancePreview, context } = props.source;
    const glanceCandidates = React.useMemo(() => (
        pluginRuntime?.phase === 'current' && pluginRuntime.pluginUiProjection
            ? selectWidgetCandidates(pluginRuntime.pluginUiProjection)
            : selectWidgetCandidates(null)
    ), [pluginRuntime]);

    const account = useActiveServerAccountScope();
    const session = context?.session;
    // This Companion as a qualified widget surface: personal, this device.
    const scope = React.useMemo<WidgetSurfaceRefV1 | null>(() => (
        account && session && account.serverId === session.ref.serverId
            ? { serverId: session.ref.serverId, accountId: account.accountId, owner: { kind: 'companion', sessionId: session.ref.sessionId } }
            : null
    ), [account, session]);
    const sections = React.useMemo(() => buildCompanionWidgetAddSections({
        refs,
        snapshot,
        glanceCandidates,
        pluginProjection,
        addItem,
        context: context ?? NO_CONTEXT,
        scope,
        ...(scope ? {
            // Session B beside Session A previews with B's own authority (lab dbind X).
            renderSetupPreview: (candidate: WidgetCandidate, preview: Readonly<{ draft: WidgetSetupDraft }>) => (
                <WidgetSetupPreview
                    scope={scope}
                    providedContext={widgetProvidedContext(context ?? NO_CONTEXT)}
                    candidate={candidate}
                    draft={preview.draft}
                    testID={`${props.testID}.setupPreview.${candidate.key}`}
                />
            ),
        } : {}),
        ...(renderGlancePreview ? { renderGlancePreview } : {}),
        renderNotePreview,
    }), [addItem, context, glanceCandidates, pluginProjection, props.testID, refs, renderGlancePreview, scope, snapshot]);

    return (
        <WidgetAddPopover
            open
            anchorRef={props.anchorRef}
            {...(props.placement ? { placement: props.placement } : {})}
            onRequestClose={props.onRequestClose}
            title={t('widgetAdd.companionTitle')}
            hint={t('widgetAdd.companionHint')}
            searchPlaceholder={t('widgetAdd.searchCompanion')}
            sections={sections}
            {...(context?.session ? { serverId: context.session.ref.serverId, sessionId: context.session.ref.sessionId } : {})}
            testID={props.testID}
        />
    );
}
