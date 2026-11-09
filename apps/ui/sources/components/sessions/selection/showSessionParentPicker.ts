import { Modal } from '@/modal';
import { t } from '@/text';
import { getStorage } from '@/sync/domains/state/storageStore';
import { createCanPlaceSessionUnderParent } from '@/sync/domains/session/listing/sessionParentPlacement';
import {
    setSessionParentPlacementForServerWithDelivery,
    type SessionParentPlacementDeliveryResult,
} from '@/sync/ops/sessionOrganization/setSessionAppearance';
import { SessionSelectionModal, type SessionSelectionCandidate } from './SessionSelectionModal';

export function presentSessionParentPlacementDeliveryResult(result: SessionParentPlacementDeliveryResult): void {
    if (result.ok) {
        if (result.instructionLocalId === null) return;
        Modal.alert(
            t('common.success'),
            t(result.placement === 'session'
                ? 'sessionLineage.nestedInstructionQueued'
                : 'sessionLineage.standaloneInstructionQueued'),
        );
        return;
    }
    if (result.stage === 'placement') {
        Modal.alert(t('common.error'), t('sessionLineage.moveFailed'));
        return;
    }
    if (result.stage === 'not_current') {
        Modal.alert(t('common.info'), t('sessionLineage.instructionNotSentPlacementChanged'));
        return;
    }
    if (result.stage === 'delivery') {
        Modal.alert(t('common.error'), t(result.placement === 'session'
            ? 'sessionLineage.nestedInstructionQueueFailed'
            : 'sessionLineage.standaloneInstructionQueueFailed'), [
            { text: t('common.cancel'), style: 'cancel' },
            { text: t('common.retry'), onPress: () => { void result.retry().then(presentSessionParentPlacementDeliveryResult); } },
        ]);
        return;
    }
    Modal.alert(t('common.error'), t('sessionLineage.instructionDeliveryUncertain'));
}

export function showSessionParentPicker(serverId: string, sessionId: string): void {
    Modal.show({
        component: SessionSelectionModal,
        props: {
            serverIds: [serverId],
            title: t('sessionLineage.nestUnder'),
            subtitle: t('sessionLineage.presentationOnly'),
            searchPlaceholder: t('sessionsList.searchSessionsPlaceholder'),
            emptyStateLabel: t('sessionLineage.noParents'),
            testID: 'session-parent-picker',
            selectSessions: (candidates: readonly SessionSelectionCandidate[]) => {
                const items = candidates.map(session => ({ type: 'session' as const, session, serverId: session.serverId }));
                const state = getStorage().getState();
                const appearances = state.sessionOrganizationAppearancesBySessionKey;
                const appearancePresentations = state.sessionOrganizationAppearancePresentationsBySessionKey;
                const canPlace = createCanPlaceSessionUnderParent({ items, appearances, appearancePresentations, serverId, sessionId });
                return candidates.filter(candidate => candidate.serverId === serverId && canPlace(candidate.id));
            },
            onSelectSession: async (selection: { serverId: string; sessionId: string }) => {
                if (selection.serverId !== serverId) {
                    Modal.alert(t('common.error'), t('sessionLineage.moveFailed'));
                    throw new Error('invalid-session-parent');
                }
                const result = await setSessionParentPlacementForServerWithDelivery({
                    serverId,
                    sessionId,
                    placement: { kind: 'session', parentSessionId: selection.sessionId },
                });
                presentSessionParentPlacementDeliveryResult(result);
                if (!result.ok && result.stage === 'placement') throw new Error(result.error);
            },
            onDismiss: () => undefined,
        },
        closeOnBackdrop: true,
    });
}
