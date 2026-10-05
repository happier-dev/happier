import * as React from 'react';
import type { View } from 'react-native';
import type { PublicActionInputById } from '@happier-dev/protocol';
import { SESSION_BOARD_DEFAULT_ITEM_WIDTH_V1 } from '@happier-dev/protocol/sessions/board';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import type { SessionBoardController } from '@/components/sessions/board/useSessionBoardController';
import type { SessionPluginRuntimeState } from '@/components/sessions/plugins/useSessionPluginRuntime';
import { InstalledWidgetSurface } from '@/components/widgets/InstalledWidgetSurface';
import { useYourWidgetCandidates } from '@/components/widgets/definitions/useYourWidgetCandidates';
import { runWidgetDefinitionCommand } from '@/components/widgets/definitions/widgetDefinitionCommands';
import { WidgetSurface } from '@/components/widgets/surface/WidgetSurface';
import type { WidgetCandidate } from '@/components/widgets/widgetCatalog';
import type { Session } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';
import { widgetProvidedContext } from '@/components/widgets/surface/widgetSurfaceSetup';
import { WidgetSetupPreview } from '@/components/widgets/surface/WidgetSetupPreview';
import { useSessionWidgetSurface } from '@/components/widgets/surface/useWidgetInputsEditor';
import { SESSION_BOARD_OVERVIEW_VIEW_ID } from '@/sync/domains/session/board';

import { WidgetAddPopover } from './WidgetAddPopover';
import { buildBoardWidgetAddContent } from './widgetAddSections';
import type { WidgetSetupDraft, WidgetSetupSubmitResult } from './widgetSetupModel';

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
            publishSavedWidget: (instance: Parameters<typeof publishSavedBoardWidget>[0]['instance']) => publishSavedBoardWidget({
                surface: scope, instance, placement: {
                    tabId: controller.activeView?.synthetic ? SESSION_BOARD_OVERVIEW_VIEW_ID : controller.activeView?.id ?? SESSION_BOARD_OVERVIEW_VIEW_ID,
                    tabTitle: controller.activeView?.title ?? t('sessionBoard.views.overview'), width: SESSION_BOARD_DEFAULT_ITEM_WIDTH_V1,
                },
            }),
        } : {}),
        // Saved definitions demand their body through the App runtime even without an installed
        // Session widget runtime. Installed surfaces still require that runtime's admitted read.
        renderPluginPreview: (candidate: WidgetCandidate) => candidate.surface && pluginRuntime ? (
            <InstalledWidgetSurface
                testID={`${testID}.preview.${candidate.key}`}
                target={{ kind: 'session', sessionId, ...(session ? { session } : {}) }}
                recordRevision={`add-preview:${candidate.key}`}
                source={{ kind: 'installedSurface', surface: candidate.surface }}
                presentation="content"
                runtime={pluginRuntime}
            />
        ) : scope && (candidate.definition?.kind === 'artifact' || candidate.definition?.kind === 'inline') ? (
            <WidgetSurface scope={scope} providedContext={widgetProvidedContext(context)} descriptor={candidate}
                instance={{ v: 1, id: `add-preview:${candidate.key}`, definition: candidate.definition, bindings: {} }}
                appRuntime={appRuntime} presentation="content" recordRevision={`add-preview:${candidate.key}`}
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
    }), [allCandidates, appRuntime, canPublish, context, controller.activeView, intents, pluginRuntime, router, run, scope, session, sessionId, snapshot, testID]);

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
