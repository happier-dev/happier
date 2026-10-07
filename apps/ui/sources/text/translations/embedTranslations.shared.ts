

export function translated(value: typeof english): typeof english {
    return value;
}



export const english = {
    embed: {
        errors: {
            originNotAllowed: 'This page isn’t allowed to show this conversation.',
            originNotAllowedReason: 'Add this site to the embed’s allowed sites in Happier.',
            unavailable: 'This conversation isn’t available here.',
            encrypted: 'This conversation is encrypted and can’t be opened here.',
            createNotGranted: 'This app can’t start new chats.',
            unsupportedVersion: 'This chat needs a newer embed.',
            unsupportedVersionReason: 'Update @happier-dev/embed in this app.',
        },
        nothingToShow: 'Nothing to show yet',
        nothingToShowReason: 'This app hasn’t opened a conversation.',
        reconnecting: 'Reconnecting…',
        previewUnavailable: 'Preview unavailable',
        previewUser: "Analyse this lead and record the result: Acme Robotics, 40 seats, evaluating in Q4.",
        previewAgent: "Strong fit. Budget is confirmed and the champion owns the decision. I recorded the analysis:",
        previewFollowUp: "Should we move this lead to qualified?",
    },
};


export const embedTranslationsEnglish = { en: english };