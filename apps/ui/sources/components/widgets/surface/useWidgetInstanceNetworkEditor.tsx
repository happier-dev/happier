import * as React from 'react';
import type { View } from 'react-native';
import type { UiSurfaceNetworkRequestV1 } from '@happier-dev/protocol/plugins/contributions/ui/hostedHtmlCapabilitiesV1';
import type { WidgetInstanceV1, WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { useWidgetDefinitionFlowRead } from '@/components/widgets/definitions/useWidgetDefinitionFlowRead';

import { SessionVisualNetworkPanel } from '@/components/sessions/board/SessionVisualNetworkPanel';
import { readWidgetInstanceNetworkChoice, sessionVisualNetworkRequest } from '@/components/sessions/board/sessionBoardVisualNetwork';
import type { WidgetSetupSubmitResult } from '@/components/widgets/add/widgetSetupModel';
import { WidgetFlowShell } from '@/components/widgets/flow/WidgetFlowShell';
import { widgetCandidateHoldsHtml, type WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { Modal } from '@/modal';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';

type NetworkEditorInput = Readonly<{
    instance: WidgetInstanceV1;
    candidate: WidgetCandidate | null | undefined;
    /** The surface this copy is placed on; its saved definition is read for that Account. */
    scope: WidgetSurfaceRefV1 | null;
    admittedViewer?: ServerAccountScope | undefined;
    /** The surface's write for this copy; absent for a viewer who cannot change it. */
    setNetwork?: ((network: UiSurfaceNetworkRequestV1) => Promise<WidgetSetupSubmitResult>) | undefined;
    anchorRef: React.RefObject<View | null>;
    testID: string;
}>;

/**
 * Network access for a placed HTML widget (on Home, a Project or a page area): the Board's panel on
 * this copy's current choice, saved through its surface's own layout writer (`widgets.item.network.set`).
 * `onNetwork` exists only for an editor of a widget whose saved definition has an HTML body.
 */
export function useWidgetInstanceNetworkEditor(input: NetworkEditorInput): Readonly<{ onNetwork: (() => void) | undefined; panel: React.ReactNode }> {
    const [open, setOpen] = React.useState<Readonly<{ callerContext?: ActionExecutorContext }> | null>(null);
    const available = widgetCandidateHoldsHtml(input.candidate) && input.setNetwork !== undefined && input.scope !== null
        && (input.instance.definition.kind === 'artifact' || input.instance.definition.kind === 'inline');
    const title = input.candidate?.title ?? input.instance.displayName ?? '';
    const commands = useCurrentUiContextLocalCommands([
        ...(available ? [{ key: 'open', title: `${t('sessionBoard.item.network.title')}: ${title}`,
            invoke: (_value: unknown, callerContext?: ActionExecutorContext) => setOpen({ callerContext }) }] : []),
        ...(open ? [{ key: 'close', title: `${t('common.close')}: ${title}`, invoke: () => setOpen(null) }] : []),
    ], { unbound: 'local' });
    const close = React.useCallback(() => { void commands.invoke('close'); }, [commands]);
    const panel = open && available ? <WidgetInstanceNetworkFlow {...input} callerContext={open.callerContext}
        scope={input.scope!} setNetwork={input.setNetwork!} onClose={close} /> : null;
    return { onNetwork: available ? () => { void commands.invoke('open'); } : undefined, panel };
}

/** Mounted only while open: the stored policy lives in the saved definition the card's body already reads. */
function WidgetInstanceNetworkFlow(props: NetworkEditorInput & Readonly<{
    scope: WidgetSurfaceRefV1;
    setNetwork: (network: UiSurfaceNetworkRequestV1) => Promise<WidgetSetupSubmitResult>;
    onClose: () => void;
    callerContext?: ActionExecutorContext;
}>): React.ReactElement | null {
    const opened = useWidgetDefinitionFlowRead({ ...props,
        account: props.admittedViewer ?? { serverId: props.scope.serverId, accountId: props.scope.accountId } });
    const definition = opened.definition;
    const current = definition ? readWidgetInstanceNetworkChoice(props.instance, definition) : null;
    const unreadable = current === null && (opened.state === 'unavailable' || definition !== undefined && definition !== null);
    const onClose = props.onClose;
    React.useEffect(() => {
        if (!unreadable) return;
        onClose();
        Modal.alert(t('common.error'), t('sessionBoard.item.network.failed'));
    }, [onClose, unreadable]);
    if (opened.state === 'loading') return <WidgetFlowShell anchorRef={props.anchorRef} title={t('sessionBoard.item.network.title')}
        onRequestClose={onClose} testID={`${props.testID}.networkShell`}>
        <ItemLoadStateRows testID={`${props.testID}.network.loading`} state={{ kind: 'loading' }} rows={4} lines={2} shape="list" />
    </WidgetFlowShell>;
    if (!current) return null;
    const setNetwork = props.setNetwork;
    return (
        <WidgetFlowShell anchorRef={props.anchorRef} title={t('sessionBoard.item.network.title')}
            onRequestClose={onClose} testID={`${props.testID}.networkShell`}>
            <SessionVisualNetworkPanel current={current} testID={`${props.testID}.network`} onClose={onClose}
                onSave={choice => setNetwork(sessionVisualNetworkRequest(choice))} />
        </WidgetFlowShell>
    );
}
