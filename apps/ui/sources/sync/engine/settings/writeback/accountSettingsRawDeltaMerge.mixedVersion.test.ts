import { describe, expect, it } from 'vitest';

import { mergeCurrentSecretBindingsIntoRawBindings } from '@/sync/domains/settings/secretBindings';
import { mergePendingSettingsIntoRawBaseline } from './accountSettingsRawDeltaMerge';

describe('account settings raw delta merge mixed-version preservation', () => {
    it('preserves a qualified SCM selection as an unknown root field through the released preview parser and unrelated write', () => {
        // Provenance: ui-web-v0.2.2-preview.1775585938.1
        // commit 4913c1e533c872a0712ba1c25b3104fd470aacc2.
        // Its accountSettingsParse.ts blob c441053082fa2d5eae1760a8fd73b21ddad614b6
        // is byte-identical to the parser exercised here.
        const afterUnrelatedWholeSettingsWrite = mergePendingSettingsIntoRawBaseline({
            rawBaseline: {
                schemaVersion: 7,
                scmGitRepoPreferredBackend: 'git',
                scmGitRepoPreferredBackendQualifiedId: 'acme.scm/stacked',
            },
            pendingSettings: { analyticsOptOut: true },
            normalizeForPersistedStorage: (raw) => ({ value: raw, changed: false }),
        }).outgoingRaw;

        expect(afterUnrelatedWholeSettingsWrite).toMatchObject({
            scmGitRepoPreferredBackend: 'git',
            scmGitRepoPreferredBackendQualifiedId: 'acme.scm/stacked',
            analyticsOptOut: true,
        });
    });

    it('keeps newer Provider and purpose-binding bytes through an older UI settings write', () => {
        const providerSettingsV1 = {
            v: 1,
            connections: [{
                id: 'pc_managed',
                deployment: 'managed',
                purposeBindingDefaults: ['model-openai'],
            }],
            securityFingerprintsV1: { pc_managed: 'sha256:future-shape' },
        };
        const connectedAccountPurposeBindingsV1 = {
            v: 1,
            bindings: [{
                purpose: {
                    consumer: { pluginId: 'happier.agent.opencode', localId: 'opencode' },
                    purpose: 'model-openai',
                },
                target: {
                    kind: 'account',
                    account: {
                        service: {
                            pluginId: 'happier.connected-account.openai',
                            localId: 'subscription',
                        },
                        accountId: 'work',
                    },
                },
            }],
        };

        const merged = mergePendingSettingsIntoRawBaseline({
            rawBaseline: {
                schemaVersion: 6,
                providerSettingsV1,
                connectedAccountPurposeBindingsV1,
            },
            pendingSettings: { analyticsOptOut: true },
            normalizeForPersistedStorage: (raw) => ({ value: raw, changed: false }),
        });

        expect(merged.outgoingRaw).toEqual({
            schemaVersion: 6,
            analyticsOptOut: true,
            providerSettingsV1,
            connectedAccountPurposeBindingsV1,
        });
        expect(merged.outgoingRaw.providerSettingsV1).toBe(providerSettingsV1);
        expect(merged.outgoingRaw.connectedAccountPurposeBindingsV1)
            .toBe(connectedAccountPurposeBindingsV1);
    });

    it('writes the retained secret-binding carrier without leaking its derived runtime projection', () => {
        const opaqueCarrier = {
            OPENAI_API_KEY: 'secret-opaque',
            futureBindingRevision: 2,
        };
        const secretBindingsByProfileId = mergeCurrentSecretBindingsIntoRawBindings({
            rawBindings: {
                'opaque-profile': opaqueCarrier,
                'current-profile': { OPENAI_API_KEY: 'secret-current' },
            },
            currentBindings: {
                'current-profile': { OPENAI_API_KEY: 'secret-current' },
            },
            nextBindings: {
                'current-profile': { OPENAI_API_KEY: 'secret-current' },
            },
        });
        const merged = mergePendingSettingsIntoRawBaseline({
            rawBaseline: { schemaVersion: 7 },
            pendingSettings: JSON.parse(JSON.stringify({
                currentSecretBindingsByProfileId: {
                    'current-profile': { OPENAI_API_KEY: 'secret-current' },
                },
                secretBindingsByProfileId,
            })),
            normalizeForPersistedStorage: (raw) => ({ value: raw, changed: false }),
        });

        expect(merged.pendingRaw).toEqual({
            secretBindingsByProfileId: {
                'opaque-profile': opaqueCarrier,
                'current-profile': { OPENAI_API_KEY: 'secret-current' },
            },
        });
        expect(merged.outgoingRaw).toEqual({
            schemaVersion: 7,
            secretBindingsByProfileId: {
                'opaque-profile': opaqueCarrier,
                'current-profile': { OPENAI_API_KEY: 'secret-current' },
            },
        });
    });

    it('writes retained session-authoring carriers without leaking their typed runtime projections', () => {
        const favoriteModelSelectionsV1 = [
            {
                backendTargetKey: 'backend:codex',
                modelId: 'gpt-5.4',
                addedAtMs: 123,
            },
            {
                v: 2,
                futureSelection: true,
            },
        ];
        const lastEngineSelectionsByScopeV1 = {
            'server-1:backend:codex': {
                v: 1,
                modelId: 'gpt-5.4',
                updatedAt: 123,
            },
            'future-writer-scope': {
                v: 2,
                futureSelection: true,
            },
        };
        const merged = mergePendingSettingsIntoRawBaseline({
            rawBaseline: { schemaVersion: 7 },
            pendingSettings: JSON.parse(JSON.stringify({
                currentFavoriteModelSelectionsV1: [],
                currentRememberedEngineSelectionsByScopeV1: {},
                favoriteModelSelectionsV1,
                lastEngineSelectionsByScopeV1,
            })),
            normalizeForPersistedStorage: (raw) => ({ value: raw, changed: false }),
        });

        expect(merged.pendingRaw).toEqual({
            favoriteModelSelectionsV1,
            lastEngineSelectionsByScopeV1,
        });
        expect(merged.outgoingRaw).toEqual({
            schemaVersion: 7,
            favoriteModelSelectionsV1,
            lastEngineSelectionsByScopeV1,
        });
    });
});
