import * as React from 'react';
import type { View } from 'react-native';
import type { PublicActionInputById } from '@happier-dev/protocol';
import { SESSION_BOARD_DEFAULT_ITEM_WIDTH_V1 } from '@happier-dev/protocol/sessions/board';
import type { WidgetSizeV1 } from '@happier-dev/protocol/widgets';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import type { SessionBoardController } from '@/components/sessions/board/useSessionBoardController';
import type { SessionPluginRuntimeState } from '@/components/sessions/plugins/useSessionPluginRuntime';
import { useYourWidgetCandidates } from '@/components/widgets/definitions/useYourWidgetCandidates';
import { runWidgetDefinitionCommand } from '@/components/widgets/definitions/widgetDefinitionCommands';
import type { WidgetCandidate } from '@/components/widgets/widgetCatalog';
import type { Session } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';
import { widgetProvidedContext, widgetSetupFieldsForCandidate } from '@/components/widgets/surface/widgetSurfaceSetup';
import { WidgetSetupPreview } from '@/components/widgets/surface/WidgetSetupPreview';
import { useSessionWidgetSurface } from '@/components/widgets/surface/useWidgetInputsEditor';
import { SESSION_BOARD_OVERVIEW_VIEW_ID } from '@/sync/domains/session/board';

import { WidgetAddPopover } from './WidgetAddPopover';
import { buildBoardWidgetAddContent } from './widgetAddSections';
import { proposeWidgetSetupDraft, type WidgetSetupDraft, type WidgetSetupSubmitResult } from './widgetSetupModel';

const PLUGINS_ROUTE = '/plugins';

/** Publication/privacy and approval custody stay at the same Action an agent invokes. */
async function publishSavedBoardWidget(input: PublicActionInputById['widgets.instance.add']): Promise<WidgetSetupSubmitResult> {
    const outcome = await runWidgetDefinitionCommand('widgets.instance.add', input, input.surface);
    return outcome.kind === 'refused' ? { ok: false, message: t('widgetAdd.addFailed') }
        : { ok: true, ...(outcome.kind === 'approvalPending' ? { approvalPending: true } : {}) };
}

/**
 * The Board's Add popover: the shared Gallery | List popover filled with what this Board can add
 * (`buildBoardWidgetAddContent`). Mounted only while open, so nothing here reads or previews while
 * it is closed.
 */
export function BoardWidgetAddPopover(props: Readonly<{
    open: boolean;
    anchorRef: React.RefObject<View | null>;
    onRequestClose: () => void;
    controller: SessionBoardController;
    sessionId: string;
    session?: Session;
    /** The Board's current-Session widget candidates (the one executable creation projection). */
    candidates: readonly WidgetCandidate[];
    pluginRuntime?: SessionPluginRuntimeState;
    placement?: 'top' | 'bottom';
    testID: string;
}>): React.ReactElement | null {
    if (!props.open) return null;
    return <OpenBoardWidgetAddPopover {...props} />;
}

function OpenBoardWidgetAddPopover(props: React.ComponentProps<typeof BoardWidgetAddPopover>): React.ReactElement {
    const router = useRouter();
    const { controller, candidates, pluginRuntime, sessionId, session, testID } = props;
    const appRuntime = useAppShellPluginUiProjection();
    const intents = controller.addIntents;
    const snapshot = controller.snapshot;
    const run = controller.run;
    const serverId = session?.serverId ?? null;
    // This Board as a qualified widget surface (shared Session records), which fills "This session"
    // on its own: its Session, named for people.
    const { scope, context } = useSessionWidgetSurface({ owner: 'sessionBoard', serverId, sessionId, session: session ?? null });
    const canPublish = scope !== null && controller.supports('item.addWidget');
    const yours = useYourWidgetCandidates(canPublish ? scope : null, pluginRuntime?.pluginUiProjection ?? appRuntime.pluginUiProjection);
    const allCandidates = React.useMemo(() => yours.length ? [...candidates, ...yours] : candidates, [candidates, yours]);
    const content = React.useMemo(() => buildBoardWidgetAddContent({
        intents,
        candidates: allCandidates,
        snapshot,
        run,
        context,
        scope,
        ...(scope && canPublish ? {
            publishSavedWidget: (instance: Parameters<typeof publishSavedBoardWidget>[0]['instance'], size?: WidgetSizeV1) => publishSavedBoardWidget({
                surface: scope, instance, ...(size ? { size } : {}), placement: {
                    tabId: controller.activeView?.synthetic ? SESSION_BOARD_OVERVIEW_VIEW_ID : controller.activeView?.id ?? SESSION_BOARD_OVERVIEW_VIEW_ID,
                    tabTitle: controller.activeView?.title ?? t('sessionBoard.views.overview'), width: SESSION_BOARD_DEFAULT_ITEM_WIDTH_V1,
                },
            }),
        } : {}),
        // Gallery and setup both enter configured admission, which selects the actual App/Session
        // target before any installed body mounts. Missing-input tiles keep their glyph.
        renderPluginPreview: (candidate: WidgetCandidate) => scope ? (
            <WidgetSetupPreview scope={scope} providedContext={widgetProvidedContext(context)} candidate={candidate}
                draft={proposeWidgetSetupDraft(widgetSetupFieldsForCandidate(candidate, context, 'shared'))}
                testID={`${testID}.preview.${candidate.key}`} />
        ) : null,
        // The step's live preview, mounted through the configured-target owner (exact authority).
        ...(scope ? {
            renderSetupPreview: (candidate: WidgetCandidate, preview: Readonly<{ draft: WidgetSetupDraft }>) => (
                <WidgetSetupPreview
                    scope={scope}
                    providedContext={widgetProvidedContext(context)}
                    candidate={candidate}
                    draft={preview.draft}
                    testID={`${testID}.setupPreview.${candidate.key}`}
                />
            ),
        } : {}),
        openPlugins: () => { router.push(PLUGINS_ROUTE as never); },
    }), [allCandidates, canPublish, context, controller.activeView, intents, router, run, scope, snapshot, testID]);

    return (
        <WidgetAddPopover
            open
            anchorRef={props.anchorRef}
            {...(props.placement ? { placement: props.placement } : {})}
            onRequestClose={props.onRequestClose}
            title={t('widgetAdd.boardTitle')}
            hint={t('widgetAdd.boardHint')}
            searchPlaceholder={t('widgetAdd.searchWidgets')}
            sections={content.sections}
            {...(content.ask ? { ask: content.ask } : {})}
            {...(serverId ? { serverId } : {})}
            sessionId={sessionId}
            testID={testID}
        />
    );
}
