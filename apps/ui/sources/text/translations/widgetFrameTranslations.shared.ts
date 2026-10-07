

export type WidgetFrameTranslation = Readonly<{
    styleCard: string;
    stylePlain: string;
    surfaceHome: string;
    surfaceBoard: string;
    surfaceCompanion: string;
    /** ⋯ menu: give this one widget a card. */
    showFrame: string;
    /** ⋯ menu: draw this one widget plain. */
    hideFrame: string;
    thisWidgetOnly: string;
    /** "Board uses Card": what the surface does for every other widget. */
    surfaceUses: (params: Readonly<{ surface: string; style: string }>) => string;
    useSurfaceDefault: (params: Readonly<{ surface: string }>) => string;
    likeTheOthers: (params: Readonly<{ style: string }>) => string;
    appearanceTitle: string;
    appearanceDescription: string;
    /** A preview tile's caption: "Board · Card". */
    previewLabel: (params: Readonly<{ surface: string; style: string }>) => string;
    /** A one-shot chip on a widget that just arrived. */
    newChip: string;
    /** The undoable notice after a widget's frame changed. */
    noticeChanged: string;
    /** Appearance → Widgets: how the Add popover opens (Gallery | List), also switched in the popover. */
    addViewTitle: string;
    addViewDescription: string;
}>;


export const widgetFrameTranslationsEnglish = { en: {
        styleCard: 'Card',
        stylePlain: 'Plain',
        surfaceHome: 'Home',
        surfaceBoard: 'Board',
        surfaceCompanion: 'Companion',
        showFrame: 'Show frame',
        hideFrame: 'Hide frame',
        thisWidgetOnly: 'This widget only',
        surfaceUses: ({ surface, style }) => `${surface} uses ${style}`,
        useSurfaceDefault: ({ surface }) => `Use the ${surface} default`,
        likeTheOthers: ({ style }) => `${style}, like the others`,
        appearanceTitle: 'Widgets',
        appearanceDescription: 'How widgets are framed on this device. To change one widget, use its ⋯ menu.',
        previewLabel: ({ surface, style }) => `${surface} · ${style}`,
        noticeChanged: 'Frame changed',
        addViewTitle: 'Adding widgets',
        addViewDescription: 'How the Add popover opens. Switching it there changes this too.',
        newChip: 'New',
    } } satisfies Pick<Readonly<Record<string, WidgetFrameTranslation>>, "en">;