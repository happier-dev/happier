import type * as React from 'react';
import type { ShareGrantRowPresentation } from './ShareGrantRow.js';
import type { HappierShareHost } from '../presentation/sharing/ShareGrantRow.js';
import type { HappierShareSheetButtonProps } from '../presentation/sharing/ShareSheet.js';
import type { SharePrincipalPresentation } from './shareGrantModels.js';
import type { SelectionListStep, SelectionListPagination, SelectionListHeightBehavior } from './shareSelectionListTypes.js';

export type ShareSheetTextKey = 'common.add' | 'common.details' | 'common.done' | 'common.error' | 'common.loading' | 'common.noMatches' | 'common.retry' | 'friends.findFriends' | 'session.sharing.publicLink' | 'shareSheet.addPlaceholder' | 'shareSheet.allLoaded' | 'shareSheet.browseAll' | 'shareSheet.browseGroups' | 'shareSheet.browsePeople' | 'shareSheet.browseTeams' | 'shareSheet.cantAdd' | 'shareSheet.copyLink' | 'shareSheet.copyLinkFailed' | 'shareSheet.group' | 'shareSheet.linkCopied' | 'shareSheet.membersOnlyLink' | 'shareSheet.noConnectedPeople' | 'shareSheet.owner' | 'shareSheet.remove' | 'shareSheet.sendCopy' | 'shareSheet.team' | 'shareSheet.whoHasAccess' | 'shareSheet.whoHasAccessStale';
export type ShareSheetListRequest = Readonly<{
    rootStep: SelectionListStep; syncActiveStep?: SelectionListStep;
    onActiveStepChange(step: SelectionListStep): void;
    inputValue: string; onChangeInputValue(query: string): void; onInputFocus(): void;
    selectedOptionId: string | null; onSelect(): void; onRequestClose(): void;
    optionsHostInlineControls: true; selectionMark: 'none'; listAccessibilityLabel: string;
    testID: string; inputTestID: string; autoFocusInputOnWeb: boolean; autoFocusInputOnNative: false;
    surface?: 'none'; bodyFooter?: React.ReactNode; fillAvailableSpace: boolean;
    maxHeight?: number; heightBehavior: SelectionListHeightBehavior; pagination?: SelectionListPagination;
}>;
/** App SDK/native bindings; directory acquisition, grants and sharing policy stay with callers. */
export type ShareSheetHost = Readonly<{
    usePresentation(): Readonly<{ host: HappierShareHost; phone: boolean; writeClipboard(value: string): Promise<boolean> }>;
    useSharePresentation(): HappierShareHost;
    useGrantRowPresentation(): ShareGrantRowPresentation;
    text(key: ShareSheetTextKey): string;
    suggestions(kind: string): string;
    noMatchingPeople(query: string): string;
    PrincipalVisual: React.ComponentType<Readonly<{ principal: SharePrincipalPresentation; testID: string; size?: number }>>;
    Icon: React.ComponentType<Readonly<{ name: 'link' | 'copy' | 'info' | 'users' | 'plus' }>>;
    SecondaryText: React.ComponentType<Readonly<{ children: React.ReactNode }>>;
    Description: React.ComponentType<Readonly<{ children: React.ReactNode }>>;
    PublicLinkState: React.ComponentType<Readonly<{ stateLabel: string }>>;
    Button: React.ComponentType<HappierShareSheetButtonProps & Readonly<{ loading?: boolean }>>;
    List: React.ComponentType<ShareSheetListRequest>;
    ConnectedPeoplePrompt: React.ComponentType<Readonly<{ testID: string; title: string; actionLabel: string }>>;
    copyLinkFailed(): void;
    applicationBaseUrl(): string;
    announce(message: string): void;
    announceRemoval(principal: SharePrincipalPresentation): void;
}>;
