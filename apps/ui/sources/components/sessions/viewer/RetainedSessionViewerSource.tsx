import * as React from 'react';
import {
    RetainedPresentationSlotBinder,
    useOptionalRetainedPresentationSlotsStore,
    type RetainedPresentationGeometryTransition,
    type RetainedPresentationRect,
} from '@/components/ui/presentation/retainedPresentationSlots';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { serverAccountScopeKeySuffix, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { SessionViewerSourceAccountScopeProvider, useSessionViewerSourceAccountLifetime } from './SessionViewerSourceAccountScope';
import { SessionViewerControllerScope, useOptionalSessionViewerController } from './SessionViewerController';

function AccountBoundSource(props: React.PropsWithChildren<Readonly<{
    slotId: string;
    lifetime: ServerAccountScopeLifetime;
}>>): React.ReactElement | null {
    const store = useOptionalRetainedPresentationSlotsStore();
    const subscribe = React.useCallback((listener: () => void) => {
        // This subscription belongs to the retained body, not its removable pane/frame binder.
        const subscription = props.lifetime.onRetire(() => {
            store?.removePortalEntry(props.slotId);
            listener();
        });
        return () => subscription.dispose();
    }, [props.lifetime, props.slotId, store]);
    const current = React.useSyncExternalStore(subscribe, props.lifetime.isCurrent, props.lifetime.isCurrent);
    return current ? <SessionViewerSourceAccountScopeProvider accountLifetime={props.lifetime}>
        {props.children}
    </SessionViewerSourceAccountScopeProvider> : null;
}

/** Source identity is qualified by its incumbent destination and Session/Home binding. */
export function RetainedSessionViewerSource(props: Readonly<{
    slotId: string;
    serverId: string | null;
    accountLifetime?: ServerAccountScopeLifetime | null;
    visible?: boolean;
    /** A floating presentation's body rect in window space (see the binder). */
    windowGeometry?: RetainedPresentationRect | null;
    transition?: RetainedPresentationGeometryTransition | null;
    /** A watched picture lets the pointer through to the frame beneath it (see the binder). */
    inputPassthrough?: boolean;
    children: React.ReactNode;
}>): React.ReactElement | null {
    const inheritedLifetime = useSessionViewerSourceAccountLifetime();
    // The body renders in the route-stable portal: carry the Session's viewer owner with it, so the
    // body can tell its presentation who it shows without resolving another owner there.
    const viewerController = useOptionalSessionViewerController();
    const lifetime = props.accountLifetime === undefined ? inheritedLifetime : props.accountLifetime;
    // A nullable pane Home can use only its admitted Session authority, never ambient selection.
    if (!lifetime?.isCurrent() || (props.serverId !== null
        && !areServerProfileIdentifiersEquivalent(lifetime.scope.serverId, props.serverId))) return null;
    return <RetainedPresentationSlotBinder slotId={props.slotId} visible={props.visible}
        windowGeometry={props.windowGeometry} transition={props.transition}
        inputPassthrough={props.inputPassthrough}>
        <AccountBoundSource key={serverAccountScopeKeySuffix(lifetime.scope)} slotId={props.slotId} lifetime={lifetime}>
            <SessionViewerControllerScope controller={viewerController}>
                {props.children}
            </SessionViewerControllerScope>
        </AccountBoundSource>
    </RetainedPresentationSlotBinder>;
}
