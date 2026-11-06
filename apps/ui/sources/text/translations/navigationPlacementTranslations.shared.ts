

export type NavigationPlacementTranslation = Readonly<{
    customize: string; title: string; description: string;
    pinned: string; overflow: string; hidden: string; reset: string;
    appRail: string; sessionRail: string; workspaceRail: string; sessionTabBar: string; projectTabBar: string; phoneLauncher: string;
    composer: string;
    preview: string; linkedFiles: string; workflowStepTargets: string;
    auto: string; always: string; customizeTabs: string; contextSession: string;
    detailTitle: (params: { name: string }) => string; detailDescription: string; desktop: string; phone: string; deviceLabel: string;
    topTabs: string; topTabsDescription: string; rail: string; railDescription: string; phoneBar: string; phoneBarDescription: string; bar: string;
    pageTabsTitle: string; pageTabsDescription: string; pageTabsRow: string; pageTabsBottom: string; pageTabsTop: string;
    railGroupSession: string; railGroupCode: string; railGroupMachine: string; railGroupPlugins: string;
}>;


export const navigationPlacementTranslationsEnglish = { en: { preview: 'Preview', linkedFiles: "Linked files", workflowStepTargets: "Step targets", customize: 'Customize…', title: 'Navigation', description: 'Choose what stays visible, goes in More, or is hidden. Drag to reorder. Saved on this device.', pinned: 'Pinned', overflow: 'More', hidden: 'Hidden', reset: 'Reset', appRail: 'Left rail', sessionRail: 'Session rail', workspaceRail: 'Workspace rail', sessionTabBar: 'Phone tab bar', projectTabBar: 'Project tabs', phoneLauncher: 'Phone shortcuts', composer: 'Composer', auto: 'Automatic', always: 'Always', customizeTabs: 'Customize tabs…', contextSession: "Session", detailTitle: ({ name }: { name: string }) => `${name} navigation`, detailDescription: "Choose where each item goes on desktop and on phone. Saved on this device.", desktop: "Desktop", phone: "Phone", deviceLabel: "Device", topTabs: "Top tabs", topTabsDescription: "Pages that switch the main view. They show when there is more than one.", rail: "Right rail", railDescription: "Companions that open beside the page.", phoneBar: "Tab bar", phoneBarDescription: "Kept on the bar, in More, or hidden.", bar: "Bar", pageTabsTitle: "Page tabs", pageTabsDescription: "At the top, pages on the bar scroll in a strip above the page; tools stay below.", pageTabsRow: "Show pages", pageTabsBottom: "Bottom", pageTabsTop: "Top", railGroupSession: "Session", railGroupCode: "Code", railGroupMachine: "Machine", railGroupPlugins: "Plugins" } } satisfies Pick<Record<string, NavigationPlacementTranslation>, "en">;