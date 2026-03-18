import type { SupportedLanguage } from '../_all';

const authenticationTranslationExtension = {
    title: 'Authentication',
    footer: 'Machine-local CLI authentication for this backend.',
    statusTitle: 'Status',
    loggedInAsTitle: 'Logged in as',
    methodTitle: 'Method',
    sourceTitle: 'Source',
    reasonTitle: 'Details',
    lastCheckedTitle: 'Last checked',
    stateLoggedIn: 'Logged in',
    stateLoggedOut: 'Not logged in',
    stateUnknown: 'Status unknown',
    logInTitle: 'Log in',
    logInSubtitle: 'Open a terminal to authenticate this CLI on the machine.',
    reauthenticateTitle: 'Re-authenticate',
    reauthenticateSubtitle: 'Open a terminal to refresh this CLI login on the machine.',
    checkNowTitle: 'Check now',
    checkNowSubtitle: 'Refresh machine-local authentication details.',
    terminalTitle: 'Provider login terminal',
    methods: {
        apiKeyEnv: 'API key from environment',
        authTokenEnv: 'Auth token from environment',
        credentialsFile: 'Credentials file',
        oauthCli: 'CLI login session',
        configFile: 'Config file',
        gcloudAdc: 'Google ADC',
        unknown: 'Unknown method',
    },
    reasons: {
        missingCredentials: 'No credentials were found.',
        expired: 'Stored credentials have expired.',
        cliMissing: 'The CLI is not installed on the machine.',
        probeFailed: 'The CLI status probe failed.',
        timeout: 'The CLI status probe timed out.',
        unsupported: 'This backend does not expose local auth status.',
        interactiveBlocked: 'This backend requires an interactive login flow.',
        notConfigured: 'This backend is not configured on the machine.',
    },
    sources: {
        environment: 'Environment',
        file: 'Local file',
        command: 'CLI command',
        mixed: 'Multiple sources',
    },
} as const;

export const providerAuthenticationTranslationExtensions: Record<
    SupportedLanguage,
    {
        readonly settingsProviders: {
            readonly authentication: typeof authenticationTranslationExtension;
        };
    }
> = {
    en: { settingsProviders: { authentication: authenticationTranslationExtension } },
    ru: { settingsProviders: { authentication: authenticationTranslationExtension } },
    pl: { settingsProviders: { authentication: authenticationTranslationExtension } },
    es: { settingsProviders: { authentication: authenticationTranslationExtension } },
    it: { settingsProviders: { authentication: authenticationTranslationExtension } },
    pt: { settingsProviders: { authentication: authenticationTranslationExtension } },
    ca: { settingsProviders: { authentication: authenticationTranslationExtension } },
    'zh-Hans': { settingsProviders: { authentication: authenticationTranslationExtension } },
    'zh-Hant': { settingsProviders: { authentication: authenticationTranslationExtension } },
    ja: { settingsProviders: { authentication: authenticationTranslationExtension } },
};

export type ProviderAuthenticationTranslationExtension = (typeof providerAuthenticationTranslationExtensions)['en'];

export const providerAuthenticationTranslationExtension = providerAuthenticationTranslationExtensions.en;
