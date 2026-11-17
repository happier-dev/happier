import type { SupportedLanguage } from '../_all';
import { botTemplateEditorTranslations } from './botTemplateEditorTranslations';
import { botStoreTranslations } from './botStoreTranslations';
import { botTemplateSharingTranslations, botTemplateVersionReportTranslations } from './botTemplateSharingTranslations';
import { botTemplatePresentationTranslations } from './botTemplatePresentationTranslations';
import { botTemplatePageTranslations } from './botTemplatePageTranslations';

export function copy(words: readonly string[], language: SupportedLanguage) {
    return {
        ...botStoreTranslations(language),
        ...botTemplateEditorTranslations[language],
        ...botTemplateSharingTranslations[language],
        ...botTemplateVersionReportTranslations[language],
        ...botTemplatePresentationTranslations[language],
        ...botTemplatePageTranslations[language],
        title: words[0]!,
        leavePrompt: words[22]!,
        leaveKept: words[23]!,
        leftOut: words[24]!,
        description: words[25]!,
        private: words[26]!,
        giveCopy: words[1]!,
        giveCopyDescription: words[2]!,
        review: words[3]!,
        preview: words[4]!,
        instructions: words[5]!,
        firstTask: words[6]!,
        version: words[7]!,
        notes: words[8]!,
        recipient: words[9]!,
        privateDraft: words[10]!,
        shared: words[11]!,
        saving: words[12]!,
        unsaved: words[13]!,
        saved: words[14]!,
        saveFailed: words[15]!,
        conflict: words[16]!,
        reviewOther: words[17]!,
        useOtherBase: words[18]!,
        unavailable: words[19]!,
        madeFrom: ({ name }: { name: string }) => words[20]!.replace('{name}', () => name),
        byline: ({ author, version, sharing }: { author: string; version: string; sharing: string }) => words[21]!.replace('{author}', () => author).replace('{version}', () => version).replace('{sharing}', () => sharing),
    };
}

export type BotTemplateTranslations = ReturnType<typeof copy>;

export const botTemplateTranslations: Pick<Record<SupportedLanguage, BotTemplateTranslations>, 'en'> = {
    "en": copy(["Bot template", "Give a copy", "Make a template others can start their own from", "Review template", "What they get", "Instructions", "First task", "Release version", "Release notes", "Can-copy recipient", "Private draft", "Shared", "Saving…", "Unsaved changes", "Saved", "Your edits are kept. Try saving again.", "Another revision was saved. Review it before replacing your edits.", "Review other revision", "Use this revision as the save base", "Template unavailable", "Template · made from {name}", "By {author} · {version} · {sharing}", "Save before leaving? Your edits stay in this Account’s open draft until this app closes.", "Leave with edits kept", "Left out", "Description", "Private"], "en"),
};
