import type { HappierReleaseOutcome, HappierStagedMoveHint } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { I18nManager, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { PoliteAccessibilityStatus } from '@/components/ui/accessibility/PoliteAccessibilityStatus';
import { useEntityDragDropSnapshot, type EntityDragDropRuntime } from '@/components/ui/treeDragDrop';
import { EntityStagedMoveDock } from '@/components/ui/treeDragDrop/ui/EntityReleasePreview';
import { t } from '@/text';

import { describeSessionListDropOutcome } from '../dropPreview/sessionListDropPresentation';
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

const stylesheet = StyleSheet.create(() => ({
    dock: {
        position: 'absolute',
        left: 8,
        right: 8,
        bottom: 12,
    },
}));

function useHints(): readonly HappierStagedMoveHint[] {
    return React.useMemo(() => {
        const inKey = I18nManager.isRTL ? '←' : '→';
        const outKey = I18nManager.isRTL ? '→' : '←';
        return [
            { keys: ['↑', '↓'], label: t('entityDragDrop.keyboard.choose') },
            { keys: [inKey], label: t('entityDragDrop.keyboard.putUnder') },
            { keys: [outKey], label: t('entityDragDrop.keyboard.topLevel') },
            { keys: ['↵'], label: t('entityDragDrop.keyboard.drop') },
            { keys: [t('entityDragDrop.keyboard.escapeKey')], label: t('entityDragDrop.keyboard.cancel') },
        ];
    }, []);
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
    const hints = useHints();
    const staged = props.view.label !== null && (snapshot.phase === 'carrying' || snapshot.phase === 'pending');
    const outcome: HappierReleaseOutcome | null = staged
        ? describeSessionListDropOutcome(snapshot) ?? { tone: 'quiet', glyph: 'add', title: props.view.label ?? '', detail: t('entityDragDrop.keyboard.hintsA11y') }
        : null;
    const announcement = outcome ? [outcome.title, outcome.detail].filter(Boolean).join('. ') : '';
    return (
        <>
            <PoliteAccessibilityStatus
                announcement={announcement}
                transitionKey={String(props.view.step)}
                statusTestID="session-list-staged-move-status"
            />
            {outcome ? (
                <View style={stylesheet.dock} pointerEvents="none">
                    <EntityStagedMoveDock outcome={outcome} hints={hints} testID="session-list-staged-move-dock" />
                </View>
            ) : null}
        </>
    );
});
