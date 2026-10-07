

export type NavigationPlacementTranslation = Readonly<{
    customize: string; title: string; description: string;
    pinned: string; overflow: string; hidden: string; reset: string;
    appRail: string; sessionRail: string; workspaceRail: string; sessionTabBar: string;
}>;


export const navigationPlacementTranslationsEnglish = { en: { customize: 'Customize…', title: 'Navigation', description: 'Choose what stays visible, goes in More, or is hidden. Drag to reorder. Saved on this device.', pinned: 'Pinned', overflow: 'More', hidden: 'Hidden', reset: 'Reset', appRail: 'Left rail', sessionRail: 'Session rail', workspaceRail: 'Workspace rail', sessionTabBar: 'Phone tab bar' } } satisfies Pick<Record<string, NavigationPlacementTranslation>, "en">;