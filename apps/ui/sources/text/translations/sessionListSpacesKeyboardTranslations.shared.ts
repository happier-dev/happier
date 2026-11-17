export function commands(open: string, select: (ordinal: number) => string) {
    return {
        sessionListFilterOpen: open,
        sessionListSpaceSelect1: select(1),
        sessionListSpaceSelect2: select(2),
        sessionListSpaceSelect3: select(3),
        sessionListSpaceSelect4: select(4),
        sessionListSpaceSelect5: select(5),
        sessionListSpaceSelect6: select(6),
        sessionListSpaceSelect7: select(7),
        sessionListSpaceSelect8: select(8),
        sessionListSpaceSelect9: select(9),
    };
}

export const sessionListSpacesKeyboardTranslations = {
    en: commands('Open list filters', ordinal => `Select space ${ordinal}`),
};
