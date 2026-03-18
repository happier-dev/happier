import type { SupportedLanguage } from '../_all';

const settingsAcpCatalogTranslationExtension = {
    acpCatalog: 'ACP Backends',
    acpCatalogSubtitle: 'Manage built-in and custom ACP backends',
    acpCatalogBuiltIn: 'Built-in ACP',
    acpCatalogBuiltInFooter: 'Built-in generic ACP agents are defined in the shared catalog and run through the shared ACP runtime.',
    acpCatalogBackends: 'Custom backends',
    acpCatalogBackendsFooter: 'Each custom backend is a selectable ACP-compatible CLI definition with its own launcher, defaults, and auth settings.',
    acpCatalogBackendsEmptyTitle: 'No custom ACP backends',
    acpCatalogBackendsEmptySubtitle: 'Add a backend to create a selectable custom ACP backend choice.',
    acpCatalogAddBackend: 'Add ACP backend',
    acpCatalogAddBackendSubtitle: 'Create a custom ACP backend choice',
    acpCatalogBackendEditorTitle: 'ACP backend',
    acpCatalogBasics: 'Basics',
    acpCatalogLauncher: 'Launcher',
    acpCatalogEnv: 'Environment',
    acpCatalogAddEnv: 'Add env var',
    acpCatalogAddEnvSubtitle: 'Store literal values or bind Saved Secrets',
    acpCatalogEnvEmptyTitle: 'No env vars',
    acpCatalogEnvEmptySubtitle: 'Add launch-time variables for this backend.',
    acpCatalogAuth: 'Authentication',
    acpCatalogAuthSupport: 'Auth support',
    acpCatalogAuthParser: 'Status parser',
    acpCatalogCapabilities: 'Capabilities',
    acpCatalogTransportProfile: 'Transport profile',
    acpCatalogSupportsModes: 'Supports modes',
    acpCatalogSupportsModels: 'Supports models',
    acpCatalogSupportsConfigOptions: 'Supports config options',
    acpCatalogPromptImageSupport: 'Prompt image support',
    acpCatalogFieldId: 'Id',
    acpCatalogFieldName: 'Name',
    acpCatalogFieldTitle: 'Title',
    acpCatalogFieldDescription: 'Description',
    acpCatalogFieldCommand: 'Command',
    acpCatalogFieldArgs: 'Args (one per line)',
    acpCatalogMachineLoginKey: 'Machine login key',
    acpCatalogDocsUrl: 'Docs URL',
    acpCatalogLoginCommand: 'Login command',
    acpCatalogLoginArgs: 'Login args (one per line)',
    acpCatalogStatusCommand: 'Status command tokens (one per line)',
    acpCatalogDefaultMode: 'Default mode',
    acpCatalogDefaultModel: 'Default model',
    acpCatalogDeleteBackendTitle: 'Delete ACP backend?',
    acpCatalogDeleteBackendConfirm: ({ name }: { name: string }) => `Delete "${name}"?`,
    acpCatalogValidationFailed: 'ACP catalog settings are invalid.',
} as const;

const newSessionAcpCatalogTranslationExtension = {} as const;

export const acpCatalogTranslationExtensions: Record<
    SupportedLanguage,
    {
        readonly settings: typeof settingsAcpCatalogTranslationExtension;
        readonly newSession: typeof newSessionAcpCatalogTranslationExtension;
    }
> = {
    en: { settings: settingsAcpCatalogTranslationExtension, newSession: newSessionAcpCatalogTranslationExtension },
    ru: { settings: settingsAcpCatalogTranslationExtension, newSession: newSessionAcpCatalogTranslationExtension },
    pl: { settings: settingsAcpCatalogTranslationExtension, newSession: newSessionAcpCatalogTranslationExtension },
    es: { settings: settingsAcpCatalogTranslationExtension, newSession: newSessionAcpCatalogTranslationExtension },
    it: { settings: settingsAcpCatalogTranslationExtension, newSession: newSessionAcpCatalogTranslationExtension },
    pt: { settings: settingsAcpCatalogTranslationExtension, newSession: newSessionAcpCatalogTranslationExtension },
    ca: { settings: settingsAcpCatalogTranslationExtension, newSession: newSessionAcpCatalogTranslationExtension },
    'zh-Hans': { settings: settingsAcpCatalogTranslationExtension, newSession: newSessionAcpCatalogTranslationExtension },
    'zh-Hant': { settings: settingsAcpCatalogTranslationExtension, newSession: newSessionAcpCatalogTranslationExtension },
    ja: { settings: settingsAcpCatalogTranslationExtension, newSession: newSessionAcpCatalogTranslationExtension },
};

export type AcpCatalogTranslationExtension = (typeof acpCatalogTranslationExtensions)['en'];

export const acpCatalogTranslationExtension = acpCatalogTranslationExtensions.en;
