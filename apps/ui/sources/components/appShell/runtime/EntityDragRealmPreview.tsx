import * as React from 'react';

import { isTouchPrimaryPointer } from '@/components/ui/interactiveTargetSize';
import { useEntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropHooks';
import { EntityDragCarriedPreview } from '@/components/ui/treeDragDrop/ui/EntityDragCarriedPreview';

/**
 * One carried card and cancellation boundary for every surface in the app realm. Native uses the
 * root ModalProvider's existing overlay portal; web uses the existing body portal. Neither needs
 * a Session list to be mounted, and page navigation does not retire the shared feedback host.
 * Whatever is under the pointer (a pane, a list, a Board) is worded by the one outcome presenter.
 */
export const EntityDragRealmPreview = React.memo(function EntityDragRealmPreview(): React.ReactElement | null {
    const runtime = useEntityDragDropRuntime();
    return (
        <EntityDragCarriedPreview
            runtime={runtime}
            density={isTouchPrimaryPointer() ? 'touch' : 'pointer'}
            testID="entity-drag-carried-preview"
        />
    );
});
