

export type WorkspaceBarTranslation = Readonly<{
    workspaceBar: Readonly<{
        tabsLabel: string;
        tabMenuLabel: string;
        pinTab: string;
        unpinTab: string;
        splitRight: string;
        splitDown: string;
        maximizePane: string;
        restorePane: string;
        closeTab: string;
        closeOtherTabs: string;
        closeTabsToRight: string;
        moreTabs: (params: Readonly<{ count: number }>) => string;
        searchTabs: string;
        splitPane: string;
        openInNewTab: string;
        openToRight: string;
        openBelow: string;
        newTab: string;
    }>;
}>;



export const en: WorkspaceBarTranslation = {
    workspaceBar: {
        tabsLabel: 'Open tabs',
        tabMenuLabel: 'Tab options',
        pinTab: 'Pin tab',
        unpinTab: 'Unpin tab',
        splitRight: 'Split right',
        splitDown: 'Split down',
        maximizePane: 'Maximize pane',
        restorePane: 'Restore pane',
        closeTab: 'Close tab',
        closeOtherTabs: 'Close other tabs',
        closeTabsToRight: 'Close tabs to the right',
        moreTabs: ({ count }) => (count === 1 ? '1 more tab' : `${count} more tabs`),
        searchTabs: 'Search tabs',
        splitPane: 'Split the focused pane',
        openInNewTab: 'Open in new tab',
        openToRight: 'Open to the right',
        openBelow: 'Open below',
        newTab: 'New tab',
    },
};


export const workspaceBarTranslationsEnglish: Pick<Readonly<Record<'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant', WorkspaceBarTranslation>>, "en"> = { en };