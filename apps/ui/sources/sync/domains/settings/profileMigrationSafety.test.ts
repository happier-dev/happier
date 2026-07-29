import { describe, expect, it } from 'vitest';

import { applySettings, settingsParse } from './settings';

describe('AI launch profile migration safety', () => {
    it('round-trips legacy, slim, malformed, and future rows with their bindings through unrelated writes', () => {
        const legacy = {
            id: 'azure-openai',
            name: 'Azure OpenAI',
            environmentVariables: [{ name: 'AZURE_OPENAI_API_VERSION', value: '2025-04-01-preview' }],
            envVarRequirements: [{ name: 'AZURE_OPENAI_API_KEY', kind: 'secret', required: true }],
            createdAt: 1,
            updatedAt: 1,
        };
        const slim = {
            v: 2,
            id: 'review-profile',
            name: 'Review profile',
            extraEnvironmentVariables: [{ name: 'MY_SAFE_FLAG', value: '1' }],
            defaultPermissionModeByTargetKey: {},
            defaultPersistenceModeByTargetKey: {},
            compatibilityByTargetKey: {},
            createdAt: 2,
            updatedAt: 2,
        };
        const future = { v: 99, id: 'future-profile', opaque: { preserve: ['exactly'] } };
        const malformed = { v: 2, id: '', malformed: true };
        const rawProfiles = [legacy, slim, future, malformed] as const;
        const rawBindings = {
            'azure-openai': { AZURE_OPENAI_API_KEY: 'secret-azure' },
            'future-profile': { FUTURE_API_KEY: 'secret-future' },
            'pending-custom': { COMPANY_API_KEY: 'secret-company' },
        } as const;

        const parsed = settingsParse({
            profiles: rawProfiles,
            secrets: [
                { id: 'secret-azure', name: 'Azure', kind: 'apiKey', encryptedValue: { _isSecretValue: true, encryptedValue: { t: 'enc-v1', c: 'YQ' } }, createdAt: 1, updatedAt: 1 },
                { id: 'secret-future', name: 'Future', kind: 'apiKey', encryptedValue: { _isSecretValue: true, encryptedValue: { t: 'enc-v1', c: 'Yg' } }, createdAt: 1, updatedAt: 1 },
                { id: 'secret-company', name: 'Company', kind: 'apiKey', encryptedValue: { _isSecretValue: true, encryptedValue: { t: 'enc-v1', c: 'Yw' } }, createdAt: 1, updatedAt: 1 },
            ],
            secretBindingsByProfileId: rawBindings,
            providerSettingsV1: {
                v: 1,
                connections: [], connectionTombstones: [], accountGrants: [], machineGrants: [],
                secretBindingsByConnectionId: {}, manualModelsByConnectionId: {}, modelVisibilityByRef: {},
                experimentalBindingConfirmations: [], defaultsByAgentTargetKey: {},
                migration: { v: 1, completedSources: [], pendingCustomProfileIds: ['pending-custom'] },
            },
        });
        const afterUnrelatedWrite = applySettings(parsed, { useProfiles: true });

        expect(afterUnrelatedWrite.profiles).toEqual(rawProfiles);
        expect(afterUnrelatedWrite.secretBindingsByProfileId).toEqual(rawBindings);
    });
});
