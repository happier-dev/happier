

export type SessionReminderTranslations = typeof en;



export const en = {
    due: 'Reminder due',
    title: 'Remind me',
    inOneHour: 'In 1 hour',
    inThreeHours: 'In 3 hours',
    tomorrowMorning: 'Tomorrow morning',
    nextWeek: 'Next week',
    custom: 'Choose date and time…',
    customTitle: 'Choose date and time',
   
    customPlaceholder: '2026-09-08 09:00',
    futureTimeRequired: 'Choose a time in the future.',
    setReminder: 'Set reminder',
    reminderSaved: 'Reminder saved',
    presetSaveFailedAfterReminder: 'Your reminder is saved, but saving the preset was not confirmed. Retry the preset or close.',
    presetsSaveFailed: 'Saving presets was not confirmed. Your edits are kept here; try again.',
    presetsChanged: 'The saved presets differ from the list you opened. Close and reopen to review the latest list.',
    remove: 'Remove reminder',
    dateLabel: 'Date', timeLabel: 'Time', addToPresets: 'Add to presets', presetPreviewUnavailable: 'Choose a valid future time to preview the preset.', managePresets: 'Manage presets', managePresetsMessage: 'Rename, reorder, or remove your saved reminder choices.', presetName: 'Preset name', movePresetUp: 'Move preset up', movePresetDown: 'Move preset down', renamePresetLabel: ({ preset }: { preset: string }) => `Rename “${preset}”`, movePresetUpLabel: ({ preset }: { preset: string }) => `Move “${preset}” up`, movePresetDownLabel: ({ preset }: { preset: string }) => `Move “${preset}” down`, deletePresetLabel: ({ preset }: { preset: string }) => `Delete “${preset}”`, noPresets: 'No saved presets', noPresetsMessage: 'Save one the next time you choose a custom reminder.',
};


export const sessionReminderTranslationsEnglish: Pick<Record<
    'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant',
    SessionReminderTranslations
>, "en"> = { en };