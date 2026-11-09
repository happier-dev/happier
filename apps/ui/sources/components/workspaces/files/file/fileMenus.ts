import type { TranslationKeyNoParams } from '@/text';

export type FileMenuSurface = 'page' | 'phone' | 'treeRow';
export type FileMenuAvailability = 'hidden' | 'enabled' | Readonly<{ disabledReason: string }>;
export type FileMenuIntent = Readonly<{ altKey?: boolean }>;
type FileMenuRun = (intent?: FileMenuIntent) => void | Promise<void>;
const EDITOR_CODE_MENU_TITLES = {
    'code.goToTypeDefinition': 'files.pane.menu.goToTypeDefinition', 'code.goToImplementation': 'files.pane.menu.goToImplementation',
    'code.peekReferences': 'files.pane.menu.peekReferences', 'code.suggest': 'files.pane.menu.suggest', 'code.signatureHelp': 'files.pane.menu.signatureHelp',
    'code.format': 'files.pane.menu.formatDocument', 'code.formatSelection': 'files.pane.menu.formatSelection', 'code.organizeImports': 'files.pane.menu.organizeImports',
    'code.expandSelection': 'files.pane.menu.expandSelection', 'code.shrinkSelection': 'files.pane.menu.shrinkSelection',
} as const satisfies Readonly<Record<string, TranslationKeyNoParams>>;
type CodeMenuCommandId = 'code.goToDefinition' | 'code.showInfo' | 'code.rename' | 'code.quickFix' | 'code.showProblems'
    | 'code.checkProjectProblems' | 'code.restart' | keyof typeof EDITOR_CODE_MENU_TITLES;
const CODE_MENU_TITLES: Readonly<Record<CodeMenuCommandId, TranslationKeyNoParams>> = {
    ...EDITOR_CODE_MENU_TITLES,
    'code.goToDefinition': 'files.pane.menu.goToDefinition', 'code.showInfo': 'files.pane.menu.showInfo',
    'code.rename': 'files.pane.menu.renameSymbol', 'code.quickFix': 'files.pane.menu.quickFix',
    'code.showProblems': 'files.pane.intelligence.checkProblems', 'code.checkProjectProblems': 'files.pane.intelligence.checkWholeProject',
    'code.restart': 'files.pane.menu.restartLanguageServices',
};
/** The language commands by group, in reading order: where to go, what to change, then the server itself. */
const CODE_MENU_GROUPS: readonly Readonly<{ group: FileMenuItem['group']; ids: readonly CodeMenuCommandId[] }>[] = [
    { group: 'navigate', ids: ['code.goToDefinition', 'code.goToTypeDefinition', 'code.goToImplementation', 'code.peekReferences', 'code.showInfo'] },
    { group: 'code', ids: ['code.suggest', 'code.signatureHelp', 'code.rename', 'code.quickFix', 'code.format', 'code.formatSelection',
        'code.organizeImports', 'code.expandSelection', 'code.shrinkSelection'] },
    { group: 'check', ids: ['code.showProblems', 'code.checkProjectProblems', 'code.restart'] },
];

/** Behaviour is supplied by its owner; the File page owns this one shared item inventory. */
export type FileMenuContext = Readonly<{
    machineReachable: boolean;
    unavailableReason: string;
    hasCachedContent: boolean;
    platform: 'web' | 'tauri' | 'ios' | 'android';
    isDirectory?: boolean;
    partial?: boolean;
    blame?: boolean;
    readBlame?: boolean;
    open?: FileMenuRun;
    openBeside?: FileMenuRun;
    openWithBlame?: FileMenuRun;
    toggleWrap?: FileMenuRun;
    chooseBackground?: FileMenuRun;
    showInfo?: FileMenuRun;
    raw?: FileMenuRun;
    copyContents?: FileMenuRun;
    selectLines?: FileMenuRun;
    revealInFiles?: FileMenuRun;
    openChanges?: FileMenuRun;
    /** P4: leave editing and drop the unsaved draft (the editor's own owner decides what that means). */
    discardEdits?: FileMenuRun;
    toggleBlame?: FileMenuRun;
    commands?: Partial<Readonly<Record<CodeMenuCommandId, FileMenuRun>>>;
    changes?: Readonly<{ discardAll?: FileMenuRun; restoreBeforeTurn?: FileMenuRun; restoreBeforeTurnTitle?: string }>;
    copyPath?: FileMenuRun;
    copyAbsolutePath?: FileMenuRun;
    copyLink?: FileMenuRun;
    mentionInComposer?: FileMenuRun;
    saveAsArtifact?: FileMenuRun;
    download?: FileMenuRun;
    shareFile?: FileMenuRun;
    rename?: FileMenuRun;
    openInDefaultApp?: FileMenuRun;
}>;

export type FileMenuItem = Readonly<{
    id: string;
    /** Rows of one group sit together and groups are separated, in this order (lab BL1 M): open, view,
     *  navigate, code (edits), check (language services), share, then change (what drops or restores work). */
    group: 'open' | 'view' | 'navigate' | 'code' | 'check' | 'share' | 'change';
    titleKey: TranslationKeyNoParams;
    title?: string;
    destructive?: boolean;
    surfaces: readonly FileMenuSurface[];
    state(context: FileMenuContext): FileMenuAvailability;
    run(context: FileMenuContext, intent?: FileMenuIntent): void | Promise<void>;
}>;

const everySurface: readonly FileMenuSurface[] = ['page', 'phone', 'treeRow'];
const pageSurfaces: readonly FileMenuSurface[] = ['page', 'phone'];
type FileMenuCallback = (context: FileMenuContext) => FileMenuRun | undefined;

function item(input: Readonly<{
    id: string;
    group: FileMenuItem['group'];
    titleKey: TranslationKeyNoParams;
    callback: FileMenuCallback;
    surfaces?: readonly FileMenuSurface[];
    requiresMachine?: boolean;
    requiresContent?: boolean;
    destructive?: boolean;
    visible?: (context: FileMenuContext) => boolean;
}>): FileMenuItem {
    const availability = (context: FileMenuContext): FileMenuAvailability => {
        if (!input.callback(context) || input.visible?.(context) === false) return 'hidden';
        if (!context.machineReachable && (input.requiresMachine || (input.requiresContent && !context.hasCachedContent))) {
            return { disabledReason: context.unavailableReason };
        }
        return 'enabled';
    };
    return {
        id: input.id, group: input.group, titleKey: input.titleKey, destructive: input.destructive,
        surfaces: input.surfaces ?? everySurface,
        state: availability,
        run: (context, intent) => {
            // The same admission is enforced for keyboard/menu consumers as for the rendered row.
            if (availability(context) === 'enabled') return input.callback(context)?.(intent);
        },
    };
}

export const FILE_MENU_ITEMS: readonly FileMenuItem[] = [
    item({ id: 'open', group: 'open', titleKey: 'common.open', callback: c => c.open, surfaces: ['treeRow'] }),
    item({ id: 'openBeside', group: 'open', titleKey: 'files.pane.menu.openBeside', callback: c => c.openBeside, surfaces: ['treeRow'] }),
    item({ id: 'openWithBlame', group: 'open', titleKey: 'files.pane.menu.openWithBlame', callback: c => c.openWithBlame,
        surfaces: ['treeRow'], visible: c => c.readBlame === true && !c.isDirectory }),
    item({ id: 'wrap', group: 'view', titleKey: 'files.pane.menu.wrap', callback: c => c.toggleWrap, surfaces: pageSurfaces }),
    // Blame is a way of viewing the file, beside Wrap lines (lab BL1 M).
    item({ id: 'blame', group: 'view', titleKey: 'files.pane.menu.showBlame', callback: c => c.toggleBlame,
        surfaces: pageSurfaces, visible: c => c.readBlame === true && !c.isDirectory }),
    item({ id: 'background', group: 'view', titleKey: 'files.pane.menu.background', callback: c => c.chooseBackground, surfaces: pageSurfaces }),
    item({ id: 'info', group: 'view', titleKey: 'common.info', callback: c => c.showInfo, surfaces: pageSurfaces }),
    item({ id: 'raw', group: 'view', titleKey: 'files.pane.menu.raw', callback: c => c.raw, surfaces: pageSurfaces, requiresContent: true }),
    item({ id: 'copyContents', group: 'view', titleKey: 'files.pane.menu.copyContents', callback: c => c.copyContents, surfaces: pageSurfaces, requiresContent: true }),
    item({ id: 'selectLines', group: 'view', titleKey: 'files.fileActions.selectLines', callback: c => c.selectLines,
        surfaces: pageSurfaces, visible: c => !c.partial && !c.isDirectory }),
    item({ id: 'revealInFiles', group: 'view', titleKey: 'files.pane.menu.revealInFiles', callback: c => c.revealInFiles, surfaces: pageSurfaces }),
    item({ id: 'openChanges', group: 'view', titleKey: 'files.openChanges', callback: c => c.openChanges, surfaces: pageSurfaces }),
    ...CODE_MENU_GROUPS.flatMap(({ group, ids }) => ids.map(id => item({
        id, group, titleKey: CODE_MENU_TITLES[id], callback: c => c.commands?.[id], surfaces: pageSurfaces, requiresMachine: true,
    }))),
    item({ id: 'copyPath', group: 'share', titleKey: 'files.pane.menu.copyPath', callback: c => c.copyPath }),
    item({ id: 'copyAbsolutePath', group: 'share', titleKey: 'files.pane.menu.copyAbsolutePath', callback: c => c.copyAbsolutePath, surfaces: ['phone'] }),
    item({ id: 'copyLink', group: 'share', titleKey: 'files.pane.menu.copyHappierLink', callback: c => c.copyLink }),
    item({ id: 'mentionInComposer', group: 'share', titleKey: 'entityDragDrop.composer.mentionInComposer', callback: c => c.mentionInComposer }),
    item({ id: 'saveAsArtifact', group: 'share', titleKey: 'files.pane.menu.saveAsArtifact', callback: c => c.saveAsArtifact, requiresMachine: true }),
    item({ id: 'download', group: 'share', titleKey: 'files.repositoryTree.actions.download', callback: c => c.download, requiresContent: true }),
    item({ id: 'shareFile', group: 'share', titleKey: 'common.share', callback: c => c.shareFile,
        visible: c => c.platform === 'android', requiresContent: true }),
    item({ id: 'rename', group: 'share', titleKey: 'files.repositoryTree.actions.renameEllipsis', callback: c => c.rename, surfaces: ['treeRow'], requiresMachine: true }),
    item({ id: 'openInDefaultApp', group: 'share', titleKey: 'files.pane.menu.openInDefaultApp', callback: c => c.openInDefaultApp,
        visible: c => c.platform !== 'web', requiresMachine: true }),
    item({ id: 'discardEdits', group: 'change', titleKey: 'files.pane.page.discardEdits', callback: c => c.discardEdits, surfaces: pageSurfaces }),
    item({ id: 'restoreBeforeTurn', group: 'change', titleKey: 'files.pane.menu.restoreBeforeTurnFallback', callback: c => c.changes?.restoreBeforeTurn, requiresMachine: true }),
    item({ id: 'discard', group: 'change', titleKey: 'files.pane.menu.discardAllChanges', callback: c => c.changes?.discardAll, requiresMachine: true, destructive: true }),
];

export function resolveFileMenuItems(context: FileMenuContext, surface: FileMenuSurface) {
    return FILE_MENU_ITEMS.filter(item => item.surfaces.includes(surface)).flatMap(item => {
        const state = item.state(context);
        return state === 'hidden' ? [] : [{ ...item,
            titleKey: item.id === 'blame' && context.blame ? 'files.pane.menu.hideBlame' as const : item.titleKey,
            ...(item.id === 'restoreBeforeTurn' && context.changes?.restoreBeforeTurnTitle ? { title: context.changes.restoreBeforeTurnTitle } : {}),
            state, run: (intent?: FileMenuIntent) => item.run(context, intent) }];
    });
}

