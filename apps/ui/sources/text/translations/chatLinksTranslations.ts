import type { SupportedLanguage } from '../_all';

export type ChatLinksCopy = Readonly<{ title: string; description: string; browser: string; embedded: string; managed: string }>;

export const chatLinksTranslations = {
  "en": {"title": "Open links from chats in", "description": "Choose where chat links open on this device. Machine localhost links always open in the app.", "browser": "Your browser", "embedded": "Embedded", "managed": "Managed"},
} as const satisfies Pick<Record<SupportedLanguage, ChatLinksCopy>, 'en'>;
