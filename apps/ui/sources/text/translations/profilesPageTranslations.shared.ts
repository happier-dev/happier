

export function translated(value: typeof english): typeof english {
    return value;
}



export const english = {
    profilesPage: {
        searchPlaceholder: 'Search profiles',
        emptyTitle: 'No profiles yet',
        newProfileTitle: 'New profile',
        notFoundTitle: 'This profile no longer exists',
        notFoundDescription: 'It may have been deleted on another device.',
        backToProfiles: 'Back to profiles',
        discardDraft: 'Discard',
        detailDescription: 'Used when a new session starts with this profile.',
        builtInDetailDescription: 'A ready-made profile. Saving your changes creates your own copy.',
        enabledHint: 'Offered when you pick a profile for a new session.',
        pickerSection: 'Profile picker',
        pickerSectionDescription: 'Where this choice appears when you start a session.',
        showFirst: 'Show first',
        showFirstDescription: 'Lists the machine environment among your favorites.',
        environmentDescription: 'Environment variables set when a session starts with this profile. Values can refer to the machine\'s own variables.',
        descriptionTitle: 'Description',
        descriptionHint: 'Optional. Shown when you pick this profile.',
    },
};


export const profilesPageTranslationsEnglish = { en: english };