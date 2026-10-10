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
import { widgetProvidedContext } from '@/components/widgets/surface/widgetSurfaceSetup';
import { WidgetSetupPreview } from '@/components/widgets/surface/WidgetSetupPreview';
import { useSessionWidgetSurface } from '@/components/widgets/surface/useWidgetInputsEditor';
import { SESSION_BOARD_OVERVIEW_VIEW_ID } from '@/sync/domains/session/board';

import { WidgetAddSurface } from './WidgetAddSurface';
import { buildBoardWidgetAddContent } from './widgetAddSections';
import type { WidgetSetupDraft, WidgetSetupSubmitResult } from './widgetSetupModel';

const PLUGINS_ROUTE = '/plugins';

/** Publication/privacy and approval custody stay at the same Action an agent invokes. */
async function publishSavedBoardWidget(input: PublicActionInputById['widgets.item.add']): Promise<WidgetSetupSubmitResult> {
    const outcome = await runWidgetDefinitionCommand('widgets.item.add', input, input.surface);
    return outcome.kind === 'refused' ? { ok: false, message: t('widgetAdd.addFailed') }
        : { ok: true, ...(outcome.kind === 'approvalPending' ? { approvalPending: true } : {}) };
}

/**
 * The Board's Add: the shared Add surface filled with what this Board can add
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
        // The selected widget's live preview, mounted through the configured-target owner, which
        // selects the actual App/Session target (exact authority) before any installed body mounts.
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
        <WidgetAddSurface
            open
            anchorRef={props.anchorRef}
            {...(props.placement ? { placement: props.placement } : {})}
            onRequestClose={props.onRequestClose}
            title={t('widgetAdd.boardTitle')}
            hint={t('widgetAdd.boardHint')}
            searchPlaceholder={t('widgetAdd.searchWidgets')}
            addLabel={t('widgetAdd.addToBoard')}
            sections={content.sections}
            {...(content.ask ? { ask: content.ask } : {})}
            {...(serverId ? { serverId } : {})}
            sessionId={sessionId}
            testID={testID}
        />
    );
}
