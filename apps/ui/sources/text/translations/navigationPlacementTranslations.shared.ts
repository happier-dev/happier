

export type NavigationPlacementTranslation = Readonly<{
    customize: string; title: string; description: string;
    auto: string; pinned: string; overflow: string; hidden: string; reset: string;
    keepInBar?: string; moveToMore?: string; hide?: string;
    tabMenuTitle?: (params: { title: string; source: string }) => string;
    appRail: string; sessionRail: string; workspaceRail: string; sessionTabBar: string; projectTabBar: string; phoneLauncher: string;
    composer: string; composerDescription: string; shown: string; inPlus: string; always: string; customizeTabs: string; customizeComposer: string;
    inField: string; alwaysReachable: string; stopNote: string; pendingNote: string; menuOnly: string; preview: string;
    linkedFiles: string; attachmentsUnavailable: string;
    contextSession: string; contextProject: string; contextNewSession: string; contextWorkflow: string; contextDiscussion: string;
    workflowStepTargets: string; workflowRunTarget: string;
    /** The app rail's bands (owner Q8), named only in its customizer. */
    railBandWork: string; railBandTogether: string; railBandLibrary: string; railBandPlugins: string; railBandFooter: string;
    /** One detail page kind's customizer (plan T): device choice, its addressed lists and the phone page-tab position. */
    detailTitle: (params: { name: string }) => string; detailDescription: string; desktop: string; phone: string; deviceLabel: string;
    topTabs: string; topTabsDescription: string; rail: string; railDescription: string; phoneBar: string; phoneBarDescription: string; bar: string;
    pageTabsTitle: string; pageTabsDescription: string; pageTabsRow: string; pageTabsBottom: string; pageTabsTop: string;
    railGroupSession: string; railGroupCode: string; railGroupMachine: string; railGroupPlugins: string;
}>;


export const navigationPlacementTranslationsEnglish = { en: { auto: 'Automatic', customize: 'Customize…', title: 'Navigation', description: 'Choose what stays visible, goes in More, or is hidden. Drag to reorder. Saved on this device.', pinned: 'Pinned', overflow: 'More', hidden: 'Hidden', reset: 'Reset', keepInBar: 'Keep in bar', moveToMore: 'Move to More', hide: 'Hide', tabMenuTitle: ({ title, source }: { title: string; source: string }) => `${title} · from ${source}`, appRail: 'Left rail', sessionRail: 'Session rail', workspaceRail: 'Workspace rail', sessionTabBar: 'Phone tab bar', projectTabBar: 'Project tabs', phoneLauncher: 'Phone shortcuts', composer: 'Composer', composerDescription: 'Choose what stays in the row, goes in + or is hidden. Drag to reorder. Saved on this device.', shown: 'Shown', inPlus: 'In +', always: 'Always', customizeTabs: 'Customize tabs…', customizeComposer: 'Customize composer…', inField: 'In the field', alwaysReachable: 'Always reachable', stopNote: 'Shown while a turn runs', pendingNote: 'In the row while it needs you', menuOnly: 'Opens from +', preview: 'Preview', linkedFiles: "Linked files", attachmentsUnavailable: "Attachment uploads aren’t available on this Home or build.", contextSession: "Session", contextProject: "Project", contextNewSession: "New session", contextWorkflow: "Workflow", contextDiscussion: "Discussion", workflowStepTargets: "Step targets", workflowRunTarget: "Run target", railBandWork: "Work", railBandTogether: "Together", railBandLibrary: "Library", railBandPlugins: "Plugins", railBandFooter: "Footer" , detailDescription: "Choose where each item goes on desktop and on phone. Saved on this device.", desktop: "Desktop", phone: "Phone", deviceLabel: "Device", topTabs: "Top tabs", topTabsDescription: "Pages that switch the main view. They show when there is more than one.", rail: "Right rail", railDescription: "Companions that open beside the page.", phoneBar: "Tab bar", phoneBarDescription: "Kept on the bar, in More, or hidden.", bar: "Bar", pageTabsTitle: "Page tabs", pageTabsDescription: "At the top, pages on the bar scroll in a strip above the page; tools stay below.", pageTabsRow: "Show pages", pageTabsBottom: "Bottom", pageTabsTop: "Top", railGroupSession: "Session", railGroupCode: "Code", railGroupMachine: "Machine", railGroupPlugins: "Plugins", detailTitle: ({ name }: { name: string }) => `${name} navigation` } } satisfies Pick<Record<string, NavigationPlacementTranslation>, "en">;
