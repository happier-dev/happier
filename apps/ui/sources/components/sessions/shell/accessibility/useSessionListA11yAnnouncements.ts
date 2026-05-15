import * as React from 'react';
import { AccessibilityInfo, Platform } from 'react-native';

import type { BlockedReason, TreeDropResult } from '@/components/ui/treeDragDrop';
import { t } from '@/text';

export type SessionListA11yAnnouncementSubject = Readonly<{
    label: string;
}>;

export type SessionListA11yDropAnnouncement = SessionListA11yAnnouncementSubject & Readonly<{
    destinationLabel?: string | null;
    result: TreeDropResult;
}>;

export type UseSessionListA11yAnnouncementsResult = Readonly<{
    announcePickedUp: (subject: SessionListA11yAnnouncementSubject) => void;
    announceCancelled: (subject: SessionListA11yAnnouncementSubject) => void;
    announceDropResult: (announcement: SessionListA11yDropAnnouncement) => void;
}>;

function announce(message: string): void {
    if (!message) return;
    if (Platform.OS === 'web') {
        const doc = (globalThis as { document?: Document }).document;
        if (!doc?.body) return;
        const region = ensureWebLiveRegion(doc);
        region.textContent = '';
        const timer = setTimeout(() => {
            region.textContent = message;
        }, 30);
        void timer;
        return;
    }

    try {
        AccessibilityInfo.announceForAccessibility?.(message);
    } catch {
        // Accessibility announcements are best effort.
    }
}

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
                reason: formatBlockedReason(input.result.instruction.reason),
            });
        case 'idle':
        default:
            return t('sessionsList.dragA11yCancelled', { item: input.label });
    }
}

export function useSessionListA11yAnnouncements(): UseSessionListA11yAnnouncementsResult {
    const announcePickedUp = React.useCallback((subject: SessionListA11yAnnouncementSubject) => {
        announce(t('sessionsList.dragA11yPickedUp', { item: subject.label }));
    }, []);

    const announceCancelled = React.useCallback((subject: SessionListA11yAnnouncementSubject) => {
        announce(t('sessionsList.dragA11yCancelled', { item: subject.label }));
    }, []);

    const announceDropResult = React.useCallback((drop: SessionListA11yDropAnnouncement) => {
        announce(formatDropAnnouncement(drop));
    }, []);

    return {
        announcePickedUp,
        announceCancelled,
        announceDropResult,
    };
}

function ensureWebLiveRegion(doc: Document): HTMLElement {
    const existing = doc.querySelector<HTMLElement>('[data-session-list-live-region="true"]');
    if (existing) return existing;
    const region = doc.createElement('div');
    region.setAttribute('data-session-list-live-region', 'true');
    region.setAttribute('aria-live', 'polite');
    region.setAttribute('aria-atomic', 'true');
    region.style.position = 'absolute';
    region.style.left = '-10000px';
    region.style.width = '1px';
    region.style.height = '1px';
    region.style.overflow = 'hidden';
    doc.body.appendChild(region);
    return region;
}
