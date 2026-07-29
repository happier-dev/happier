import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { parseAccountSettings } from '@/sync/domains/settings/parse/accountSettingsParse';
import { mergePendingSettingsIntoRawBaseline } from './accountSettingsRawDeltaMerge';

describe('account settings raw delta merge mixed-version preservation', () => {
    it('preserves a qualified SCM selection as an unknown root field through the released preview parser and unrelated write', () => {
        // Provenance: ui-web-v0.2.2-preview.1775585938.1
        // commit 4913c1e533c872a0712ba1c25b3104fd470aacc2.
        // Its accountSettingsParse.ts blob c441053082fa2d5eae1760a8fd73b21ddad614b6
        // is byte-identical to the parser exercised here.
        const releasedParsed = parseAccountSettings({
            settings: {
                schemaVersion: 7,
                scmGitRepoPreferredBackend: 'git',
                scmGitRepoPreferredBackendQualifiedId: 'acme.scm/stacked',
            },
            schema: z.object({
                schemaVersion: z.number(),
                scmGitRepoPreferredBackend: z.enum(['git', 'sapling']),
            }),
            defaults: {
                schemaVersion: 7,
                scmGitRepoPreferredBackend: 'git' as const,
            },
            supportedSchemaVersion: 7,
            pruneResult: (settings) => settings,
            debugEnabled: false,
            isDev: false,
        });
        const afterUnrelatedWholeSettingsWrite = {
            ...releasedParsed,
            analyticsOptOut: true,
        };

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
});
