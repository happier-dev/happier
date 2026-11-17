import type { SupportedLanguage } from '../_all';

export type EmptyEditorCopy = Readonly<{
    title: string;
    reason: string;
    openFile: string;
    changedInSession: string;
    recent: string;
    projectTitle: string;
    projectReason: string;
    changedInProject: string;
    openChangedFileA11y: (params: { name: string }) => string;
}>;

/** The editor column with nothing open (lab ade-shell EM1). */
export const paneEmptyEditorTranslations = {
    en: { title: 'Open a file beside the session', reason: 'Read or edit any file in this project while the session works.', openFile: 'Open file…', changedInSession: 'Changed in this session', recent: 'Recent', projectTitle: 'Open a file in this project', projectReason: 'Read or edit any file here; agents keep working in their sessions.', changedInProject: 'Uncommitted changes', openChangedFileA11y: ({ name }: { name: string }) => `Open ${name}` },
} as const satisfies Pick<Record<SupportedLanguage, EmptyEditorCopy>, 'en'>;

export type ShortcutsSheetCopy = Readonly<{
    footer: string;
    openSettings: string;
    hostA11y: string;
}>;

/** The `?` shortcut sheet (lab ade-shell KB1). */
export const paneShortcutsSheetTranslations = {
    en: { footer: 'Review keys work when a diff has focus and you are not typing.', openSettings: 'Change shortcuts in Settings', hostA11y: 'Show shortcuts for' },
} as const satisfies Pick<Record<SupportedLanguage, ShortcutsSheetCopy>, 'en'>;
