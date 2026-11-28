import { mcpSignInTranslations } from './mcpSignInTranslations';

const denialCopy = {
    deniedTitle: 'Sign-in failed',
    providerDeniedTitle: ({ providerName }: { providerName: string }) => `Sign-in with ${providerName} failed`,
    cancelledTitle: 'You cancelled the sign-in',
    deniedBody: 'The provider declined the sign-in.',
    tryAgain: 'Try again',
};

export type CallbackCopy = Omit<(typeof mcpSignInTranslations)['en']['callback'], 'openServers'>
    & Readonly<{ openConnections: string }> & Readonly<typeof denialCopy>;
type Overrides = Pick<CallbackCopy, 'connectedBody' | 'pasteBody' | 'invalidBody' | 'unfinishedBody' | 'openConnections'>;
export type Locale = keyof typeof mcpSignInTranslations;

export function callbackCopy(locale: Locale, overrides: Overrides): CallbackCopy {
    return { ...mcpSignInTranslations[locale].callback, ...denialCopy, ...overrides };
}

/** Same callback slots as MCP, with connection-screen recovery for generic accounts. */
export const connectedAccountCallbackTranslations = {
    en: callbackCopy('en', {
        connectedBody: 'Taking you back to your connected accounts…',
        pasteBody: 'To finish connecting, paste this code on the connection screen for the same Happier account.',
        invalidBody: 'Start signing in again from the connection screen.',
        unfinishedBody: 'Return to the connection screen to continue signing in, or paste this code there.',
        openConnections: 'Open connected accounts',
    }),
} satisfies Pick<Record<Locale, CallbackCopy>, 'en'>;
