import type { SupportedLanguage } from '../_all';



export type AccountActorTranslations = {
    accountActorYou: string;
    accountActorFormerMember: string;
    accountActorUnnamedMember: string;
    accountActorSentBy: (params: { name: string }) => string;
};


export const sessionMessageAccountActorTranslationsEnglish: Pick<Record<SupportedLanguage, AccountActorTranslations>, "en"> = { en: { accountActorYou: 'You', accountActorFormerMember: 'Former member', accountActorUnnamedMember: 'Happier member', accountActorSentBy: ({ name }) => `Sent by ${name}` } };