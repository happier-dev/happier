import { describe, expect, it } from 'vitest';
import { ACCOUNT_SETTING_ARTIFACTS, accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';

describe('account agent target projection', () => {
    it('keeps target-keyed Account defaults in the Protocol catalog while accepting explicit external backend targets', () => {
        const acmeTargetKey = resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'acme.review.backend' });
        const claudeTargetKey = resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'claude' });

        expect(ACCOUNT_SETTING_ARTIFACTS.defaults.backendEnabledByTargetKey).toEqual({});
        expect(ACCOUNT_SETTING_ARTIFACTS.defaults.backendCliSourcePreferenceByTargetKey).toEqual({});
        expect(ACCOUNT_SETTING_ARTIFACTS.defaults.sessionDefaultPermissionModeByTargetKey).toEqual({});
        expect(ACCOUNT_SETTING_ARTIFACTS.shape.backendEnabledByTargetKey.parse({
            [claudeTargetKey]: true,
            [acmeTargetKey]: true,
        })).toEqual({
            [claudeTargetKey]: true,
            [acmeTargetKey]: true,
        });
        expect(ACCOUNT_SETTING_ARTIFACTS.shape.sessionDefaultPermissionModeByTargetKey.parse({
            [claudeTargetKey]: 'default',
            [acmeTargetKey]: 'default',
        })).toEqual({
            [claudeTargetKey]: 'default',
            [acmeTargetKey]: 'default',
        });
    });

    it('migrates legacy authoring defaults only for registered executable Agents while preserving external backend preferences', async () => {
        const { applyAccountSettingsCompatibilityMigrations } = await import('../../parse/accountSettingsCompatibilityMigrations');

        const acmeTargetKey = resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'acme.review.backend' });
        const claudeTargetKey = resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'claude' });
        const protocolClaudeTargetKey = 'agent:happier.agent.claude/claude';
        const input = {
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
        };
        const migrated = applyAccountSettingsCompatibilityMigrations({
            input,
            settings: accountSettingsParse(input),
            inputSchemaVersion: 5,
            supportedSchemaVersion: 6,
        });

        expect(migrated.backendEnabledByTargetKey).toMatchObject({
            [protocolClaudeTargetKey]: false,
            [acmeTargetKey]: false,
        });
        expect(migrated.backendCliSourcePreferenceByTargetKey).toMatchObject({
            [protocolClaudeTargetKey]: 'managed-first',
            [acmeTargetKey]: 'system-first',
        });
        expect(migrated.sessionDefaultPermissionModeByTargetKey).toMatchObject({
            [claudeTargetKey]: 'read-only',
        });
        expect(migrated.sessionDefaultPermissionModeByTargetKey).not.toHaveProperty(acmeTargetKey);
        expect(migrated.newSessionDefaultPersistenceModeByTargetKeyV1).toMatchObject({
            [claudeTargetKey]: 'direct',
        });
        expect(migrated.newSessionDefaultPersistenceModeByTargetKeyV1).not.toHaveProperty(acmeTargetKey);
    });

    it('normalizes predecessor Oh My Pi account target keys through the generic V2 owner', async () => {
        const qualifiedKey = 'agent:happier.agent.ohmypi/ohmypi';

        expect(ACCOUNT_SETTING_ARTIFACTS.shape.backendEnabledByTargetKey.parse({
            'agent:ohMyPi': false,
        })).toEqual({
            [qualifiedKey]: false,
        });
        expect(ACCOUNT_SETTING_ARTIFACTS.shape.backendCliSourcePreferenceByTargetKey.parse({
            'agent:ohMyPi': 'managed-first',
        })).toEqual({
            [qualifiedKey]: 'managed-first',
        });
        expect(ACCOUNT_SETTING_ARTIFACTS.shape.sessionDefaultPermissionModeByTargetKey.parse({
            'agent:ohMyPi': 'read-only',
        })).toEqual({
            [qualifiedKey]: 'read-only',
        });
    });
});
