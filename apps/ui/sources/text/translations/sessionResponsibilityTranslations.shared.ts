

export type SessionResponsibilityTranslations = typeof en;



export const en = {
    responsibilitySectionTitle: 'Responsibility',
    responsibilityRowTitle: 'Responsible',
    responsibilityNoOne: 'No one',
    responsibilityUnnamedPerson: 'Unnamed person',
    responsibilityPickerTitle: 'Choose responsible person',
    responsibilitySearchPlaceholder: 'Search people with access',
    responsibilityAssignToMe: 'Assign to me',
    responsibilityPeopleWithAccess: 'People with access',
    responsibilityAccessHintOwner: 'Owner',
    responsibilityNoCandidates: 'No one else can access this session yet.',
    responsibilityAccessChanged: 'Access changed. This person can no longer be made responsible.',
    responsibilityUpdateFailed: 'Happier could not update the responsible person. Try again.',
    responsibilityApprovalPending: 'Waiting for approval. Nothing changed yet — the responsible person updates once it is approved.',
    responsibilityA11yEditable: ({ name }: { name: string }) =>
        `Responsible person, ${name}. Change responsible person.`,
    responsibilityA11yReadOnly: ({ name }: { name: string }) => `Responsible person, ${name}.`,
    responsibilityA11yEmpty: 'Responsible person, no one. Change responsible person.',
    responsibilityAssignedToYou: 'Assigned to you',
    responsibilitySharedWithYou: 'Shared with you',
};


export const sessionResponsibilityTranslationsEnglish: Pick<Record<
    'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant',
    SessionResponsibilityTranslations
>, "en"> = { en };