import { describe, expect, it } from 'vitest';

import { AccountEncryptionMigrateAcpCatalogDirectiveV1Schema, ACP_CATALOG_ACCOUNT_CIPHER_KIND_V1, AcpCatalogRecordV1Schema, AcpCatalogRowMutationV1Schema, AcpCatalogRowReadResponseV1Schema, listAcpCatalogSavedSecretRefsV1, openAcpCatalogContentV1, readFreshAcpCatalogSourceV1, rewriteAcpCatalogSavedSecretRefsV1, sealAcpCatalogContentV1, sealAcpCatalogMigrationContentV1 } from './catalogRowsV1.js';
import { sealAccountScopedBlobCiphertext } from '../../crypto/accountScopedCipher.js';
import { formatSharedSavedSecretRefV1 } from '../../account/settings/savedSecretReferenceV1.js';

const definition = { id: 'custom', name: 'custom', title: 'Custom', command: 'custom-agent', args: [], env: {},
    capabilities: { supportsLoadSession: false, supportsModes: 'unknown' as const, supportsModels: 'unknown' as const, supportsConfigOptions: 'unknown' as const, promptImageSupport: 'unknown' as const },
    createdAt: 1, updatedAt: 1 };

describe('Account ACP catalog rows', () => {
    it('retains canonical definition defaults while closing current row fields', () => {
        const { capabilities: _capabilities, env: _env, args: _args, ...minimal } = definition;
        expect(openAcpCatalogContentV1({ mode: 'plain', material: null,
            content: { t: 'plain', v: { v: 1, definitions: [minimal] } } }))
            .toEqual({ status: 'opened', record: { v: 1, definitions: [definition] } });
    });

    it('refuses a stored projection which would discard a secret reference while allowing harmless forward fields', () => {
        const record = AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [definition] });
        expect(openAcpCatalogContentV1({ mode: 'plain', material: null, content: { t: 'plain', v: {
            ...record, futureLabel: 'harmless',
        } } })).toMatchObject({ status: 'opened', record });
        expect(openAcpCatalogContentV1({ mode: 'plain', material: null, admission: 'migration', content: { t: 'plain', v: {
            ...record, futureLabel: 'harmless',
        } } })).toMatchObject({ status: 'opened', record, migrationSource: {
            payload: { ...record, futureLabel: 'harmless' },
        } });
        expect(openAcpCatalogContentV1({ mode: 'plain', material: null, admission: 'migration',
            content: { t: 'plain', v: record } })).toMatchObject({ status: 'opened', record });
        expect(openAcpCatalogContentV1({ mode: 'plain', material: null, content: { t: 'plain', v: {
            ...record, futureCredential: { t: 'savedSecret', secretId: 'hidden' },
        } } })).toMatchObject({ status: 'partial', reason: 'incomplete-inventory', record,
            diagnostics: [{ path: 'futureCredential', reason: 'unclassified_reference' }] });
    });

    it('does not mask an additive secret identity on an otherwise known reference carrier', () => {
        const record = AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [definition] });
        expect(openAcpCatalogContentV1({ mode: 'plain', material: null, content: { t: 'plain', v: {
            ...record, definitions: [{ ...record.definitions[0], env: { TOKEN: { t: 'savedSecret', secretId: formatSharedSavedSecretRefV1('known'), savedSecretId: 'other' } } }],
        } } })).toMatchObject({ status: 'partial', reason: 'incomplete-inventory',
            diagnostics: [{ path: 'definitions[0].env.TOKEN.savedSecretId', reason: 'unclassified_reference' }] });
    });

    it('keeps active personal or malformed shared references repair-only without hiding valid neighbors', () => {
        const valid = { ...definition, env: { TOKEN: { t: 'savedSecret', secretId: formatSharedSavedSecretRefV1('ready') } } };
        for (const secretId of ['legacy-personal', 'happier:shared-secret:v1:']) {
            const unsafe = { ...definition, id: 'unsafe', name: 'unsafe', env: { TOKEN: { t: 'savedSecret', secretId } } };
            expect(openAcpCatalogContentV1({ mode: 'plain', material: null, content: { t: 'plain', v: {
                v: 1, definitions: [valid, unsafe],
            } } })).toMatchObject({ status: 'partial', reason: 'incomplete-inventory',
                record: { v: 1, definitions: [valid] },
                diagnostics: expect.arrayContaining([{ path: 'definitions[1].env.TOKEN', reason: 'unclassified_reference' }]),
            });
        }
    });

    it('preserves independent valid neighbors as a repair-only projection', () => {
        const record = AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [definition] });
        expect(openAcpCatalogContentV1({ mode: 'plain', material: null, content: { t: 'plain', v: {
            ...record, definitions: [...record.definitions, { id: 'broken', command: 42 }],
        } } })).toMatchObject({ status: 'partial', reason: 'incomplete-inventory', record,
            diagnostics: [{ path: 'definitions[1]', reason: 'invalid_definition' }] });
    });

    it('distinguishes genuinely absent sources from invalid or retained configured inventory', () => {
        expect(readFreshAcpCatalogSourceV1({})).toMatchObject({ status: 'ready', record: { v: 1, definitions: [] } });
        expect(readFreshAcpCatalogSourceV1({ acpCatalogSettingsV1: { v: 2, backends: [] } })).toMatchObject({ status: 'ready' });
        expect(readFreshAcpCatalogSourceV1({ acpCatalogSettingsV1: { v: 2, backends: [definition] } })).toMatchObject({ status: 'unavailable', reason: 'source-transfer-required' });
        for (const raw of [null, 'broken', { acpCatalogSettingsV1: null }, { acpCatalogSettingsV1: {} }, { acpCatalogSettingsV1: { v: 1, backends: [] } }, { acpCatalogSettingsV1: { v: 3, backends: [] } }]) {
            expect(readFreshAcpCatalogSourceV1(raw)).toMatchObject({ status: 'unavailable', reason: 'invalid-stored-content' });
        }
        expect(readFreshAcpCatalogSourceV1({ acpCatalogSettingsV1: { v: 2, backends: [], extension: { t: 'savedSecret', secretId: 'hidden' } } }))
            .toMatchObject({ status: 'unavailable', reason: 'invalid-stored-content' });
    });

    it('captures a singleton tombstone revision in the conversion directive', () => {
        expect(AccountEncryptionMigrateAcpCatalogDirectiveV1Schema.safeParse({ expectedRevision: 4, content: null }).success).toBe(true);
    });

    it('admits captured predecessor cleanup only with matching initial source currentness', () => {
        const mutation = { expectedRevision: 'absent', source: 'predecessor', sourceSettingsVersion: 4,
            content: { t: 'plain', v: { v: 1, definitions: [definition] } },
            settingsCleanup: { expectedSettingsVersion: 4, nextSettings: { t: 'plain', v: { language: 'en' } } },
        };
        expect(AcpCatalogRowMutationV1Schema.safeParse(mutation).success).toBe(true);
        expect(AcpCatalogRowMutationV1Schema.safeParse({ ...mutation,
            settingsCleanup: { ...mutation.settingsCleanup, expectedSettingsVersion: 3 },
        }).success).toBe(false);
        const { settingsCleanup: _cleanup, ...uncaptured } = mutation;
        expect(AcpCatalogRowMutationV1Schema.safeParse(uncaptured).success).toBe(false);
        expect(AcpCatalogRowMutationV1Schema.safeParse({ ...mutation,
            settingsCleanup: { ...mutation.settingsCleanup, nextSettings: null },
        }).success).toBe(false);
        expect(AcpCatalogRowMutationV1Schema.safeParse({ ...mutation, expectedRevision: 2,
            source: undefined, sourceSettingsVersion: undefined,
        }).success).toBe(false);
    });

    it('preserves the stored read bytes until the canonical opener decides partial authority', () => {
        const content = { t: 'plain', v: { v: 1, definitions: [definition, { id: 'broken' }], futureCredential: { t: 'savedSecret', secretId: 'hidden' } },
            futureEnvelopeCredential: { t: 'savedSecret', secretId: 'outer-hidden' },
        };
        expect(AcpCatalogRowReadResponseV1Schema.safeParse({ status: 'present', revision: 2, content }))
            .toMatchObject({ success: true, data: { status: 'present', revision: 2, content } });
    });

    it('does not grant complete authority after dropping a reference outside the content payload', () => {
        const record = AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [definition] });
        const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(9) };
        for (const mode of ['plain', 'e2ee'] as const) {
            const content = sealAcpCatalogContentV1({ record, mode, material: mode === 'plain' ? null : material });
            expect(openAcpCatalogContentV1({ mode, material: mode === 'plain' ? null : material,
                content: { ...content, futureLabel: 'harmless' },
            })).toEqual({ status: 'opened', record });
            expect(openAcpCatalogContentV1({ mode, material: mode === 'plain' ? null : material,
                content: { ...content, futureEnvelopeCredential: { t: 'savedSecret', secretId: formatSharedSavedSecretRefV1('hidden') } },
            })).toMatchObject({ status: 'partial', reason: 'incomplete-inventory', record,
                diagnostics: [{ path: 'futureEnvelopeCredential', reason: 'unclassified_reference' }],
            });
            expect(openAcpCatalogContentV1({ mode, material: mode === 'plain' ? null : material, admission: 'migration',
                content: { ...content, futureLabel: 'harmless' },
            })).toMatchObject({ status: 'opened', record, migrationSource: {
                content: { ...content, futureLabel: 'harmless' }, payload: record,
            } });
        }
    });

    it('censuses and rewrites only the typed configured credential slots', () => {
        const oldReference = formatSharedSavedSecretRefV1('old');
        const newReference = formatSharedSavedSecretRefV1('new');
        const record = AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [{ ...definition,
            env: { TOKEN: { t: 'savedSecret', secretId: oldReference }, URL: { t: 'literal', v: 'old' } },
        }] });
        expect(listAcpCatalogSavedSecretRefsV1(record)).toEqual([{ path: 'definitions[0].env.TOKEN', secretId: oldReference }]);
        expect(rewriteAcpCatalogSavedSecretRefsV1(record, oldReference, newReference).definitions[0].env).toEqual({ TOKEN: { t: 'savedSecret', secretId: newReference }, URL: { t: 'literal', v: 'old' } });
        expect(sealAcpCatalogContentV1({ record, mode: 'plain', material: null })).toEqual({ t: 'plain', v: record });
        expect(openAcpCatalogContentV1({ mode: 'e2ee', material: null, content: { t: 'plain', v: record } })).toMatchObject({ status: 'unavailable', reason: 'account-mode-mismatch' });
    });

    it('converts complete original payload and envelope metadata losslessly without relaxing new writes', () => {
        const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(9) };
        const payload = { v: 1, futureCatalog: { label: 'retained' }, definitions: [{ ...definition,
            futureDefinition: { value: 7 }, env: { LABEL: { t: 'literal', v: 'value', futureLiteral: true } },
            capabilities: { ...definition.capabilities, futureCapability: { enabled: true } },
        }] };
        const content = { t: 'plain', v: payload, futureEnvelope: { label: 'retained' } };
        const opened = openAcpCatalogContentV1({ mode: 'plain', material: null, content, admission: 'migration' });
        expect(opened.status).toBe('opened');
        if (opened.status !== 'opened') return;
        expect(AcpCatalogRecordV1Schema.safeParse(payload).success).toBe(false);
        const encrypted = sealAcpCatalogMigrationContentV1({ source: opened.migrationSource, mode: 'e2ee', material });
        expect(encrypted).toMatchObject({ t: 'encrypted', futureEnvelope: content.futureEnvelope });
        const reopened = openAcpCatalogContentV1({ mode: 'e2ee', material, content: encrypted, admission: 'migration' });
        expect(reopened).toMatchObject({ status: 'opened', migrationSource: { payload } });
        if (reopened.status !== 'opened') return;
        expect(sealAcpCatalogMigrationContentV1({ source: reopened.migrationSource, mode: 'plain', material: null })).toEqual(content);
        expect(() => sealAcpCatalogMigrationContentV1({ source: { ...opened.migrationSource,
            content: { ...content, c: 'future-metadata-collides-with-target' },
        }, mode: 'e2ee', material })).toThrow('invalid-stored-content');
    });

    it('roundtrips the full inventory through the dedicated E2EE kind without requiring a key for Plain Accounts', () => {
        const record = AcpCatalogRecordV1Schema.parse({ v: 1, definitions: Array.from({ length: 257 }, (_, index) => ({
            ...definition, id: `custom-${index}`, name: `custom-${index}`,
        })) });
        const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(9) };
        const content = sealAcpCatalogContentV1({ record, mode: 'e2ee', material, randomBytes: length => new Uint8Array(length).fill(3) });
        expect(openAcpCatalogContentV1({ mode: 'e2ee', material, content })).toEqual({ status: 'opened', record });
        expect(openAcpCatalogContentV1({ mode: 'e2ee', material, content, admission: 'migration' })).toMatchObject({ status: 'opened', record });
        const retainedExtension = { t: 'encrypted' as const, c: sealAccountScopedBlobCiphertext({
            kind: ACP_CATALOG_ACCOUNT_CIPHER_KIND_V1, material, payload: { ...record, futureLabel: 'retained' },
            randomBytes: length => new Uint8Array(length).fill(4),
        }) };
        expect(openAcpCatalogContentV1({ mode: 'e2ee', material, content: retainedExtension })).toEqual({ status: 'opened', record });
        expect(openAcpCatalogContentV1({ mode: 'e2ee', material, content: retainedExtension, admission: 'migration' }))
            .toMatchObject({ status: 'opened', record, migrationSource: {
                content: retainedExtension, payload: { ...record, futureLabel: 'retained' },
            } });
        expect(openAcpCatalogContentV1({ mode: 'plain', material: null, content })).toMatchObject({ status: 'unavailable', reason: 'account-mode-mismatch' });
        expect(openAcpCatalogContentV1({ mode: 'e2ee', material: null, content })).toMatchObject({ status: 'unavailable', reason: 'encryption-material-unavailable' });
    });
});
