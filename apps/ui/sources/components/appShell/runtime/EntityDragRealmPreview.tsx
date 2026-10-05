import * as React from 'react';
import type { HappierReleaseOutcome } from '@happier-dev/plugin-ui/presentation';

import { describePaneDropOutcome } from '@/components/appShell/splitCanvas/presentation/paneDropPresentation';
import { describeSessionListDropOutcome } from '@/components/sessions/shell/dropPreview/sessionListDropPresentation';
import { isTouchPrimaryPointer } from '@/components/ui/interactiveTargetSize';
import { useEntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropHooks';
import type { EntityDragDropSnapshot } from '@/components/ui/treeDragDrop/entityDragDropTypes';
import { EntityDragCarriedPreview } from '@/components/ui/treeDragDrop/ui/EntityDragCarriedPreview';

/**
 * The carried card's words for whatever is under the pointer: a pane's verdict in pane words (C2),
 * anything else in the list's words (E1). One card per realm, wherever the item came from.
 */
export function describeEntityDragOutcome(snapshot: Pick<EntityDragDropSnapshot, 'phase' | 'admission'>): HappierReleaseOutcome | null {
    return describePaneDropOutcome(snapshot) ?? describeSessionListDropOutcome(snapshot);
}

/**
 * One carried card and cancellation boundary for every surface in the app realm. Native uses the
 * root ModalProvider's existing overlay portal; web uses the existing body portal. Neither needs
 * a Session list to be mounted, and page navigation does not retire the shared feedback host.
 */
export const EntityDragRealmPreview = React.memo(function EntityDragRealmPreview(): React.ReactElement | null {
    const runtime = useEntityDragDropRuntime();
    return (
        <EntityDragCarriedPreview
            runtime={runtime}
            describeOutcome={describeEntityDragOutcome}
            density={isTouchPrimaryPointer() ? 'touch' : 'pointer'}
            testID="entity-drag-carried-preview"
        />
    );
});
