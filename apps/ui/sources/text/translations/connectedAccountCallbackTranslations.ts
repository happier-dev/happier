import { mcpSignInTranslations } from './mcpSignInTranslations';

export type CallbackCopy = Omit<(typeof mcpSignInTranslations)['en']['callback'], 'openServers'> & Readonly<{ openConnections: string }>;
type Overrides = Pick<CallbackCopy, 'connectedBody' | 'pasteBody' | 'invalidBody' | 'unfinishedBody' | 'openConnections'>;
export type Locale = keyof typeof mcpSignInTranslations;

export function callbackCopy(locale: Locale, overrides: Overrides): CallbackCopy {
    return { ...mcpSignInTranslations[locale].callback, ...overrides };
}

/** Same callback slots as MCP, with connection-screen recovery for generic accounts. */
export const connectedAccountCallbackTranslations = {
    en: callbackCopy('en', {
        connectedBody: 'Taking you back to your connected accounts…',
        pasteBody: 'Paste it on the connection screen where you started signing in. It only works there, once.',
        invalidBody: 'Start signing in again from the connection screen.',
        unfinishedBody: 'Return to the connection screen to continue signing in, or paste this code there.',
        openConnections: 'Open connected accounts',
    }),
} satisfies Pick<Record<Locale, CallbackCopy>, 'en'>;
