import type { SupportedLanguage } from '../_all';
import { botTemplateUpdateTranslations } from './botTemplateUpdateTranslations';
import { botTemplateSetupTranslations } from './botTemplateSetupTranslations';

export function copy(words: readonly string[], language: SupportedLanguage) {
    return {
        ...botTemplateUpdateTranslations[language],
        ...botTemplateSetupTranslations[language],
        makeOwn: words[0]!, create: words[1]!, source: words[2]!,
        acceptedVersion: ({ version }: { version: string }) => words[3]!.replace('{version}', () => version),
        follow: words[4]!, independentCopy: words[5]!,
        memoryRules: words[6]!, skills: words[7]!, needs: words[8]!, required: words[9]!, optional: words[10]!,
        inputs: words[11]!, executable: words[12]!, binary: words[13]!, download: words[14]!,
        releaseChanged: words[15]!, copyIntro: words[16]!,
    };
}

export const botTemplateRecipientTranslations = {
    en: copy(['Make my own', 'Create Bot', 'Template source', 'Accepted version {version}', 'Follow template updates', 'Independent copy', 'Memory rules', 'Skills', 'Needs', 'Required', 'Optional', 'Inputs', 'Executable', 'Binary · Base64', 'Download', "Template changed. Review the current version before creating your copy.", "Choose where your copy runs. Create starts your Bot with the template instructions."], 'en'),
} satisfies Pick<Record<SupportedLanguage, ReturnType<typeof copy>>, 'en'>;
