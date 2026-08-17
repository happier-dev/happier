import * as React from 'react';

import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
import type { BlockedReason } from '@/components/ui/treeDragDrop';
import { t } from '@/text';
import type { SessionListInstructionBlockReason, SessionListTreeDropResult } from '../drop-resolution/sessionListTreeTypes';

export type SessionListA11yAnnouncementSubject = Readonly<{
    label: string;
}>;

export type SessionListA11yDropAnnouncement = SessionListA11yAnnouncementSubject & Readonly<{
    destinationLabel?: string | null;
    result: SessionListTreeDropResult;
}>;

export type UseSessionListA11yAnnouncementsResult = Readonly<{
    announcePickedUp: (subject: SessionListA11yAnnouncementSubject) => void;
    announceCancelled: (subject: SessionListA11yAnnouncementSubject) => void;
    announceDropResult: (announcement: SessionListA11yDropAnnouncement) => void;
    announceSelectionCount: (announcement: Readonly<{ count: number }>) => void;
}>;

function formatBlockedReason(reason: BlockedReason): string {
    switch (reason) {
        case 'descendant-cycle':
            return t('sessionsList.dragA11yBlockedDescendantCycle');
        case 'leaf-cannot-be-parent':
            return t('sessionsList.dragA11yBlockedLeafCannotBeParent');
        case 'max-depth-exceeded':
            return t('sessionsList.dragA11yBlockedMaxDepth');
        case 'same-position':
            return t('sessionsList.dragA11yBlockedSamePosition');
        case 'workspace-scope-mismatch':
            return t('sessionsList.dragA11yBlockedWorkspaceScope');
        case 'no-target':
        default:
            return t('sessionsList.dragA11yBlockedNoTarget');
    }
}

function formatSessionListBlockReason(reason: SessionListInstructionBlockReason | undefined): string | null {
    switch (reason) {
        case 'direct-session':
            return t('sessionsList.dragA11yBlockedDirectSession');
        case 'feature-disabled':
            return t('sessionsList.dragA11yBlockedFeatureDisabled');
        case 'unsupported-item':
            return t('sessionsList.dragA11yBlockedUnsupportedItem');
        case 'date-ordering-mode':
            return t('sessionsList.dragA11yBlockedDateOrderingMode');
        case undefined:
        default:
            return null;
    }
}

function formatDropAnnouncement(input: SessionListA11yDropAnnouncement): string {
    const destination = input.destinationLabel ?? '';
    switch (input.result.instruction.kind) {
        case 'reorder-before':
        case 'reorder-after':
            return t('sessionsList.dragA11yDroppedReorder', {
                item: input.label,
                destination,
            });
        case 'nest-into':
            return t('sessionsList.dragA11yDroppedNest', {
                item: input.label,
                destination,
            });
        case 'move-to-root':
            return t('sessionsList.dragA11yDroppedRoot', {
                item: input.label,
                destination,
            });
        case 'blocked':
            return t('sessionsList.dragA11yBlocked', {
                item: input.label,
                reason: formatSessionListBlockReason(input.result.sessionListBlockReason)
                    ?? formatBlockedReason(input.result.instruction.reason),
            });
        case 'idle':
        default:
            return t('sessionsList.dragA11yCancelled', { item: input.label });
    }
}

export function useSessionListA11yAnnouncements(): UseSessionListA11yAnnouncementsResult {
    const announcePickedUp = React.useCallback((subject: SessionListA11yAnnouncementSubject) => {
        announceAccessibilityMessage(t('sessionsList.dragA11yPickedUp', { item: subject.label }));
    }, []);

    const announceCancelled = React.useCallback((subject: SessionListA11yAnnouncementSubject) => {
        announceAccessibilityMessage(t('sessionsList.dragA11yCancelled', { item: subject.label }));
    }, []);

    const announceDropResult = React.useCallback((drop: SessionListA11yDropAnnouncement) => {
        announceAccessibilityMessage(formatDropAnnouncement(drop));
    }, []);

    const announceSelectionCount = React.useCallback((selection: Readonly<{ count: number }>) => {
        announceAccessibilityMessage(t('sessionsList.selectionA11ySelectedCount', { count: selection.count }));
    }, []);

    return React.useMemo(() => ({
        announcePickedUp,
        announceCancelled,
        announceDropResult,
        announceSelectionCount,
    }), [announceCancelled, announceDropResult, announcePickedUp, announceSelectionCount]);
}
