import React from 'react';

import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import type { SessionSectionMoveChoice } from '@/components/sessions/organization/sessionSectionMoveMenu';
import type { SessionSpaceMembershipMenu, SessionSpaceMembershipMenuChoice } from '@/components/sessions/organization/sessionSpaceMembershipMenu';

type MoveKeyboardDirection = 'up' | 'down';

type SessionRowMoveActionDependencies = Readonly<{
    openMoveSheetForTreeRow: (sourceRowId: string, sourceLabel: string) => Promise<void>;
    moveTreeRowToWorkspaceRoot: (sourceRowId: string, sourceLabel: string) => void;
    moveTreeRowByKeyboard: (sourceRowId: string, sourceLabel: string, direction: MoveKeyboardDirection) => void;
    /** The row's Move to section choices, read when its menu opens (no per-row subscription). */
    readSectionMoveMenuItems: (sourceRowId: string, iconColor: string) => DropdownMenuItem[] | null;
    moveTreeRowToSection: (sourceRowId: string, sourceLabel: string, choice: SessionSectionMoveChoice) => void;
    readSpaceMembershipMenu: (sourceRowId: string, iconColor: string) => SessionRowSpaceMembershipMenu | null;
}>;

export type SessionRowSpaceMembershipMenu = SessionSpaceMembershipMenu & Readonly<{
    choose: (choice: SessionSpaceMembershipMenuChoice) => void;
}>;
export type SessionRowSpaceMembership = Readonly<{ readMenu: (iconColor: string) => SessionRowSpaceMembershipMenu | null }>;

/** Move to section for one row: its menu reads the choices at open and files through the list's owner. */
export type SessionRowSectionMove = Readonly<{
    readMenuItems: (iconColor: string) => DropdownMenuItem[] | null;
    choose: (choice: SessionSectionMoveChoice) => void;
}>;

type SessionRowMoveActionEntry = {
    sourceRowId: string;
    sourceLabel: string;
    onMoveToFolder: () => void;
    onMoveToWorkspaceRoot: () => void;
    onMoveUp: () => void;
    onMoveDown: () => void;
    sectionMove: SessionRowSectionMove;
    spaceMembership: SessionRowSpaceMembership;
};

type SessionRowMoveActionRequest = Readonly<{
    sourceRowId: string;
    sourceLabel: string;
}>;

export type SessionRowMoveActionHandlers = Readonly<{
    onMoveToFolder: () => void;
    onMoveToWorkspaceRoot: () => void;
    onMoveUp: () => void;
    onMoveDown: () => void;
    sectionMove: SessionRowSectionMove;
    spaceMembership: SessionRowSpaceMembership;
}>;

export function useSessionListRowMoveActionHandlers(
    dependencies: SessionRowMoveActionDependencies,
): (request: SessionRowMoveActionRequest) => SessionRowMoveActionHandlers {
    const dependenciesRef = React.useRef(dependencies);
    dependenciesRef.current = dependencies;
    const handlersByRowIdRef = React.useRef(new Map<string, SessionRowMoveActionEntry>());

    return React.useCallback((request: SessionRowMoveActionRequest): SessionRowMoveActionHandlers => {
        const rowId = request.sourceRowId;
        const cache = handlersByRowIdRef.current;
        let entry = cache.get(rowId);
        if (!entry) {
            entry = {
                sourceRowId: rowId,
                sourceLabel: request.sourceLabel,
                onMoveToFolder: () => {
                    const current = handlersByRowIdRef.current.get(rowId);
                    if (!current) return;
                    void dependenciesRef.current.openMoveSheetForTreeRow(current.sourceRowId, current.sourceLabel);
                },
                onMoveToWorkspaceRoot: () => {
                    const current = handlersByRowIdRef.current.get(rowId);
                    if (!current) return;
                    dependenciesRef.current.moveTreeRowToWorkspaceRoot(current.sourceRowId, current.sourceLabel);
                },
                onMoveUp: () => {
                    const current = handlersByRowIdRef.current.get(rowId);
                    if (!current) return;
                    dependenciesRef.current.moveTreeRowByKeyboard(current.sourceRowId, current.sourceLabel, 'up');
                },
                onMoveDown: () => {
                    const current = handlersByRowIdRef.current.get(rowId);
                    if (!current) return;
                    dependenciesRef.current.moveTreeRowByKeyboard(current.sourceRowId, current.sourceLabel, 'down');
                },
                sectionMove: {
                    readMenuItems: (iconColor) => dependenciesRef.current.readSectionMoveMenuItems(rowId, iconColor),
                    choose: (choice) => {
                        const current = handlersByRowIdRef.current.get(rowId);
                        if (!current) return;
                        dependenciesRef.current.moveTreeRowToSection(current.sourceRowId, current.sourceLabel, choice);
                    },
                },
                spaceMembership: { readMenu: (iconColor) => dependenciesRef.current.readSpaceMembershipMenu(rowId, iconColor) },
            };
            cache.set(rowId, entry);
        } else {
            entry.sourceLabel = request.sourceLabel;
        }

        return {
            onMoveToFolder: entry.onMoveToFolder,
            onMoveToWorkspaceRoot: entry.onMoveToWorkspaceRoot,
            onMoveUp: entry.onMoveUp,
            onMoveDown: entry.onMoveDown,
            sectionMove: entry.sectionMove,
            spaceMembership: entry.spaceMembership,
        };
    }, []);
}
