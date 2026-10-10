import { describe, expect, it } from 'vitest';

import { settingsParse } from './settings';
import { mergePendingSettingsIntoRawBaseline } from '@/sync/engine/settings/writeback/accountSettingsRawDeltaMerge';

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
        const rawProfiles = [legacy, slim, future, malformed, ...Array.from({ length: 253 }, (_, index) => ({
            ...legacy, id: `legacy-${index}`,
        }))];
        const rawBindings = {
            'azure-openai': { AZURE_OPENAI_API_KEY: 'secret-azure' },
            'future-profile': { FUTURE_API_KEY: 'secret-future' },
            'pending-custom': { COMPANY_API_KEY: 'secret-company' },
        } as const;

        const raw = {
            profiles: rawProfiles,
            secrets: [
                { id: 'secret-azure', name: 'Azure', kind: 'apiKey', encryptedValue: { _isSecretValue: true, encryptedValue: { t: 'enc-v1', c: 'YQ' } }, createdAt: 1, updatedAt: 1 },
                { id: 'secret-future', name: 'Future', kind: 'apiKey', encryptedValue: { _isSecretValue: true, encryptedValue: { t: 'enc-v1', c: 'Yg' } }, createdAt: 1, updatedAt: 1 },
                { id: 'secret-company', name: 'Company', kind: 'apiKey', encryptedValue: { _isSecretValue: true, encryptedValue: { t: 'enc-v1', c: 'Yw' } }, createdAt: 1, updatedAt: 1 },
                ...Array.from({ length: 254 }, (_, index) => ({
                    id: `legacy-secret-${index}`, name: `Legacy ${index}`, kind: 'apiKey',
                    encryptedValue: { _isSecretValue: true, encryptedValue: { t: 'enc-v1', c: 'x'.repeat(600) } },
                    createdAt: 1, updatedAt: 1,
                })),
            ],
            secretBindingsByProfileId: rawBindings,
            providerSettingsV1: {
                v: 1,
                connections: [], connectionTombstones: [], accountGrants: [], machineGrants: [],
                secretBindingsByConnectionId: {}, manualModelsByConnectionId: {}, modelVisibilityByRef: {},
                experimentalBindingConfirmations: [], defaultsByAgentTargetKey: {},
                migration: { v: 1, completedSources: [], pendingCustomProfileIds: ['pending-custom'] },
            },
        };
        const parsed = settingsParse(raw);
        const afterUnrelatedWrite = mergePendingSettingsIntoRawBaseline({ rawBaseline: raw,
            pendingSettings: { useProfiles: true }, normalizeForPersistedStorage: value => ({ value, changed: false }),
        }).outgoingRaw;

        expect(afterUnrelatedWrite.profiles).toEqual(rawProfiles);
        expect(afterUnrelatedWrite.secrets).toEqual(parsed.secrets);
        expect(afterUnrelatedWrite.secrets).toHaveLength(257);
        expect(settingsParse(JSON.parse(JSON.stringify(afterUnrelatedWrite))).secrets).toEqual(parsed.secrets);
        expect(afterUnrelatedWrite.secretBindingsByProfileId).toEqual(rawBindings);
        expect(parsed).not.toHaveProperty('profiles');
        expect(parsed).not.toHaveProperty('secretBindingsByProfileId');
    });
});
