import * as React from 'react';

import { NewSessionMachineSelectionContent } from './components/NewSessionMachineSelectionContent';
import { useServerScopedMachineOptions } from './hooks/machines/useServerScopedMachineOptions';
import type { SessionServerStartDraftPresentation, SessionServerStartDraftTarget } from './serverStartDraftComposer';
import { useLaunchSelectionMachines } from '@/sync/store/hooks';
import { SELECTION_LIST_MODAL_MAX_HEIGHT } from '@/components/ui/selectionList';
import type { PopoverAnchor } from '@/components/ui/popover';
import { Modal } from '@/modal';
import { createDeferredOnce } from '@/modal/async/createDeferredOnce';
import { createAnchoredPickerChrome } from '@/modal/components/card/anchoredSheetChrome';
import { t } from '@/text';

const NO_MACHINES = [] as const;

function SessionDraftMachineSelection(props: Readonly<{
    serverId: string;
    onSelect: (target: SessionServerStartDraftTarget) => void;
}>) {
    const machines = useLaunchSelectionMachines();
    const allowedServerIds = React.useMemo(() => [props.serverId], [props.serverId]);
    const groups = useServerScopedMachineOptions({
        allowedServerIds, activeServerId: props.serverId, activeMachines: machines, inventoryPurpose: 'launch',
    });
    return <NewSessionMachineSelectionContent
        groups={groups}
        selectedMachine={null}
        selectedServerId={props.serverId}
        recentMachines={NO_MACHINES}
        favoriteMachines={NO_MACHINES}
        onSelectMachine={machine => props.onSelect({ serverId: props.serverId, machineId: machine.id })}
        onSelectScopedMachine={machine => props.onSelect({ serverId: machine.serverId, machineId: machine.id })}
        showSearch
        maxHeight={SELECTION_LIST_MODAL_MAX_HEIGHT}
    />;
}

/** A no-invoke draft uses New Session's Machine list before its target-bound recipe. */
export function presentSessionServerStartDraftMachineSelection(
    serverId: string,
    anchor?: PopoverAnchor,
): SessionServerStartDraftPresentation<SessionServerStartDraftTarget> {
    const deferred = createDeferredOnce<SessionServerStartDraftTarget | null>();
    let modalId = '';
    let closed = false;
    const settle = (target: SessionServerStartDraftTarget | null) => {
        if (closed) return;
        closed = true;
        deferred.resolve(target);
        if (modalId) Modal.hide(modalId);
    };
    const close = () => settle(null);
    modalId = Modal.show({
        component: SessionDraftMachineSelection,
        props: { serverId, onSelect: settle },
        chrome: createAnchoredPickerChrome({ title: t('newSession.selectMachineTitle'), anchor }),
        onRequestClose: close,
        onHostUnmount: close,
        closeOnBackdrop: true,
    });
    if (!modalId) close();
    else if (closed) Modal.hide(modalId);
    return { result: deferred.promise, close };
}
