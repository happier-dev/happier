import { describe, expect, it, vi } from 'vitest';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';

vi.mock('@happier-dev/agents', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@happier-dev/agents')>();
    return {
        ...actual,
        getAllAgentCatalogDefinitions: () => [
            ...actual.getAllAgentCatalogDefinitions(),
            { id: 'acme.review.backend' },
        ],
    };
});

vi.mock('@/agents/registry/registryCore', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/agents/registry/registryCore')>();
    return {
        ...actual,
        getAgentCore: (agentId: string) => ({
            permissions: {
                modeGroup: agentId === 'claude' ? 'claude' : 'codexLike',
            },
        }),
    };
});

describe('account provider universe projection', () => {
    it('derives account backend and permission defaults from the shared provider universe instead of the UI-local agent list', async () => {
        vi.resetModules();
        const { ACCOUNT_BACKEND_SETTING_ARTIFACTS } = await import('./accountBackendSettingDefinitions');
        const { ACCOUNT_PERMISSION_SETTING_ARTIFACTS } = await import('./accountPermissionSettingDefinitions');

        const acmeTargetKey = resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'acme.review.backend' });
        const claudeTargetKey = resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'claude' });

        expect(ACCOUNT_BACKEND_SETTING_ARTIFACTS.defaults.backendEnabledByTargetKey).toMatchObject({
            [claudeTargetKey]: true,
            [acmeTargetKey]: true,
        });
        expect(ACCOUNT_BACKEND_SETTING_ARTIFACTS.defaults.backendCliSourcePreferenceByTargetKey).toEqual({});
        expect(ACCOUNT_PERMISSION_SETTING_ARTIFACTS.defaults.sessionDefaultPermissionModeByTargetKey).toMatchObject({
            [claudeTargetKey]: 'default',
            [acmeTargetKey]: 'default',
        });
    });

    it('migrates legacy account provider settings for every provider in the shared provider universe', async () => {
        vi.resetModules();
        const { applyAccountSettingsCompatibilityMigrations } = await import('../../parse/accountSettingsCompatibilityMigrations');

        const acmeTargetKey = resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'acme.review.backend' });
        const claudeTargetKey = resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'claude' });
        const migrated = applyAccountSettingsCompatibilityMigrations({
            input: {
                backendEnabledById: {
                    claude: false,
                    'acme.review.backend': false,
                },
                backendCliSourcePreferenceById: {
                    claude: 'managed-first',
                    'acme.review.backend': 'system-first',
                },
                sessionDefaultPermissionModeByAgent: {
                    claude: 'read-only',
                    'acme.review.backend': 'read-only',
                },
                newSessionDefaultPersistenceModeByAgentV1: {
                    claude: 'direct',
                    'acme.review.backend': 'persisted',
                },
            },
            settings: {
                backendEnabledByTargetKey: {},
                backendCliSourcePreferenceByTargetKey: {},
                sessionDefaultPermissionModeByTargetKey: {},
                newSessionDefaultPersistenceModeByTargetKeyV1: {},
            } as Record<string, unknown>,
            inputSchemaVersion: 5,
            supportedSchemaVersion: 6,
        });

        expect(migrated.backendEnabledByTargetKey).toMatchObject({
            [claudeTargetKey]: false,
            [acmeTargetKey]: false,
        });
        expect(migrated.backendCliSourcePreferenceByTargetKey).toMatchObject({
            [claudeTargetKey]: 'managed-first',
            [acmeTargetKey]: 'system-first',
        });
        expect(migrated.sessionDefaultPermissionModeByTargetKey).toMatchObject({
            [claudeTargetKey]: 'read-only',
            [acmeTargetKey]: 'read-only',
        });
        expect(migrated.newSessionDefaultPersistenceModeByTargetKeyV1).toMatchObject({
            [claudeTargetKey]: 'direct',
            [acmeTargetKey]: 'persisted',
        });
    });

    it('normalizes predecessor Oh My Pi account target keys through the generic V2 owner', async () => {
        vi.resetModules();
        const { ACCOUNT_BACKEND_SETTING_DEFINITIONS } = await import('./accountBackendSettingDefinitions');
        const { ACCOUNT_PERMISSION_SETTING_DEFINITIONS } = await import('./accountPermissionSettingDefinitions');
        const qualifiedKey = 'agent:happier.agent.ohmypi/ohmypi';

        expect(ACCOUNT_BACKEND_SETTING_DEFINITIONS.backendEnabledByTargetKey.schema.parse({
            'agent:ohMyPi': false,
        })).toEqual({
            [qualifiedKey]: false,
        });
        expect(ACCOUNT_BACKEND_SETTING_DEFINITIONS.backendCliSourcePreferenceByTargetKey.schema.parse({
            'agent:ohMyPi': 'managed-first',
        })).toEqual({
            [qualifiedKey]: 'managed-first',
        });
        expect(ACCOUNT_PERMISSION_SETTING_DEFINITIONS.sessionDefaultPermissionModeByTargetKey.schema.parse({
            'agent:ohMyPi': 'read-only',
        })).toEqual({
            [qualifiedKey]: 'read-only',
        });
    });
});
