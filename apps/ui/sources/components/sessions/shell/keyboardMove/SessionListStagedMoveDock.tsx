import { describeHappierDropAnnouncement, type HappierReleaseOutcome } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { View } from 'react-native';

import { PoliteAccessibilityStatus } from '@/components/ui/accessibility/PoliteAccessibilityStatus';
import { useEntityDragDropSnapshot, type EntityDragDropRuntime } from '@/components/ui/treeDragDrop';
import { ENTITY_STAGED_MOVE_DOCK_PLACEMENT, EntityStagedMoveDock, useEntityStagedMoveHints } from '@/components/ui/treeDragDrop/ui/EntityReleasePreview';
import { describeEntityDropOutcome } from '@/components/ui/treeDragDrop/ui/entityDropOutcome';
import { t } from '@/text';

import type { SessionListStagedMoveController, SessionListStagedMoveView } from './useSessionListStagedMove';

type RowKeyHandler = SessionListStagedMoveController['handleRowKey'];

const SessionListStagedMoveContext = React.createContext<RowKeyHandler | null>(null);

export function SessionListStagedMoveProvider(props: React.PropsWithChildren<Readonly<{ handleRowKey: RowKeyHandler }>>): React.ReactElement {
    return <SessionListStagedMoveContext.Provider value={props.handleRowKey}>{props.children}</SessionListStagedMoveContext.Provider>;
}

/** The row's staged-move key handler (web), or `null` outside a list that can move rows. */
export function useSessionListStagedMoveKeyHandler(): RowKeyHandler | null {
    return React.useContext(SessionListStagedMoveContext);
}

/**
 * The staged keyboard move's release preview, docked under the list (lab KS / K1). It is the same
 * strip the carried card shows, followed by the keys, and its words are what the status line says.
 * Only this leaf subscribes to the owner's verdict while a move is staged.
 */
export const SessionListStagedMoveDock = React.memo(function SessionListStagedMoveDock(props: Readonly<{
    runtime: EntityDragDropRuntime;
    view: SessionListStagedMoveView;
}>) {
    const snapshot = useEntityDragDropSnapshot(props.runtime);
    const hints = useEntityStagedMoveHints({ nested: true });
    const staged = props.view.label !== null && (snapshot.phase === 'carrying' || snapshot.phase === 'pending');
    const outcome: HappierReleaseOutcome | null = staged
        ? describeEntityDropOutcome(snapshot) ?? { tone: 'quiet', glyph: 'add', title: props.view.label ?? '', detail: t('entityDragDrop.keyboard.hintsA11y') }
        : null;
    const announcement = describeHappierDropAnnouncement(outcome);
    return (
        <>
            <PoliteAccessibilityStatus
                announcement={announcement}
                transitionKey={String(props.view.step)}
                statusTestID="session-list-staged-move-status"
            />
            {outcome ? (
                <View style={ENTITY_STAGED_MOVE_DOCK_PLACEMENT} pointerEvents="none">
                    <EntityStagedMoveDock outcome={outcome} hints={hints} testID="session-list-staged-move-dock" />
                </View>
            ) : null}
        </>
    );
});
