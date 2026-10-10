import { z } from 'zod/mini';
import { lazyDefinition } from '../lazyZodSchema.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { SecretStringV1Schema, listSecretStringCarrierPathsV1 } from '../crypto/settingsSecretStringSchemasV1.js';
import { listSavedSecretReferenceCarrierPathsV1, parseSavedSecretRefV1 } from '../account/settings/savedSecretReferenceV1.js';


const text = () => z.string().check(z.minLength(1));
export const RemoteHostAuthModeV1Schema = lazyDefinition(() => z.enum(['agent', 'keyfile', 'password']));
export type RemoteHostAuthModeV1 = z.infer<typeof RemoteHostAuthModeV1Schema>;
const remoteHostFields = () => ({
    id: text(), name: text(), createdAt: z.number(), updatedAt: z.number(), lastUsedAt: z.nullable(z.number()),
    linkedMachineId: z.optional(z.nullable(z.string())), linkedRelayProfileId: z.optional(z.nullable(z.string())),
});
const sshFields = () => ({ target: text(), port: z.optional(z.nullable(z.int().check(z.minimum(1), z.maximum(65535)))), authMode: RemoteHostAuthModeV1Schema });
const reference = lazyDefinition(() => z.string().check(z.refine(value => {
    try { return parseSavedSecretRefV1(value).kind === 'shared_resource'; } catch { return false; }
}, 'An SSH credential must reference a SavedSecret resource')));
export const RemoteHostSshProfileV1Schema = lazyDefinition(() => z.strictObject({ ...sshFields(),
    passwordSecretRef: z.optional(z.nullable(reference)), identityPrivateKeySecretRef: z.optional(z.nullable(reference)),
}));
export const RemoteHostRecordV1Schema = lazyDefinition(() => z.strictObject({ ...remoteHostFields(), ssh: RemoteHostSshProfileV1Schema }));
export type RemoteHostRecordV1 = z.infer<typeof RemoteHostRecordV1Schema>;
export const StoredRemoteHostRecordV1Schema = createStoredReadSchema(RemoteHostRecordV1Schema);
/** Only the bounded development cutover opens these retired material fields. */
export const LegacyRemoteHostRecordV1Schema = lazyDefinition(() => z.strictObject({ ...remoteHostFields(), ssh: z.strictObject({ ...sshFields(),
    passwordEnc: z.optional(z.nullable(SecretStringV1Schema)), identityPrivateKeyEnc: z.optional(z.nullable(SecretStringV1Schema)),
}) }));
export type LegacyRemoteHostRecordV1 = z.infer<typeof LegacyRemoteHostRecordV1Schema>;
export const StoredLegacyRemoteHostRecordV1Schema = createStoredReadSchema(LegacyRemoteHostRecordV1Schema);
export const RemoteHostCatalogRecordV1Schema = lazyDefinition(() => z.strictObject({ v: z.literal(1), hosts: z.array(RemoteHostRecordV1Schema) })
    .check(z.superRefine((record, context) => {
        const ids = new Set<string>();
        record.hosts.forEach((host, index) => {
            if (ids.has(host.id)) context.addIssue({ code: 'custom', path: ['hosts', index, 'id'], message: 'Host identities must be unique' });
            ids.add(host.id);
        });
    })));
export type RemoteHostCatalogRecordV1 = z.infer<typeof RemoteHostCatalogRecordV1Schema>;
export const StoredRemoteHostCatalogRecordV1Schema = createStoredReadSchema(RemoteHostCatalogRecordV1Schema);
export const RemoteHostCatalogContentV1Schema = lazyDefinition(() => z.discriminatedUnion('t', [
    z.strictObject({ t: z.literal('plain'), v: RemoteHostCatalogRecordV1Schema }),
    z.strictObject({ t: z.literal('encrypted'), c: text() }),
]));
export type RemoteHostCatalogContentV1 = z.infer<typeof RemoteHostCatalogContentV1Schema>;
/** Inspect discarded envelope fields before the canonical stored projection. */
const storedEnvelopeAdmission = lazyDefinition(() => z.unknown().check(z.superRefine((raw, context) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return;
    const known = new Set('t' in raw && raw.t === 'plain' ? ['t', 'v'] : ['t', 'c']);
    const extras = Object.fromEntries(Object.entries(raw).filter(([key]) => !known.has(key)));
    if (listSavedSecretReferenceCarrierPathsV1(extras).length || listSecretStringCarrierPathsV1(extras).length)
        context.addIssue({ code: 'custom', message: 'Stored envelope contains unrecognized credential material' });
})));
/** Stored bodies stay intact until the domain can diagnose independent bad entries. */
export const StoredRemoteHostCatalogContentV1Schema = lazyDefinition(() => z.pipe(storedEnvelopeAdmission, z.discriminatedUnion('t', [
    z.object({ t: z.literal('plain'), v: z.unknown() }), z.object({ t: z.literal('encrypted'), c: text() }),
])));
export type RemoteHostStoredCatalogContentV1 = z.infer<typeof StoredRemoteHostCatalogContentV1Schema>;
export type StoredRemoteHostCatalogContentV1 = RemoteHostStoredCatalogContentV1;
export type RemoteHostCatalogDiagnosticV1 = Readonly<{ index: number; id: string | null; reason: 'invalid-stored-content' | 'duplicate-identity' }>;
export const revision = lazyDefinition(() => z.int().check(z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)));
export const RemoteHostCatalogRowFailureV1Schema = lazyDefinition(() => z.strictObject({
    status: z.enum(['account-not-found', 'account-inconsistent', 'account-mode-mismatch', 'invalid-stored-content', 'references-invalid', 'references-conflict']),
    reason: z.optional(z.string()),
}));
export const RemoteHostCatalogRowReadResponseV1Schema = lazyDefinition(() => z.union([
    z.strictObject({ status: z.literal('present'), revision, content: StoredRemoteHostCatalogContentV1Schema }),
    z.strictObject({ status: z.literal('absent') }), z.strictObject({ status: z.literal('deleted'), revision }), RemoteHostCatalogRowFailureV1Schema,
]));
export type RemoteHostCatalogRowReadResponseV1 = z.infer<typeof RemoteHostCatalogRowReadResponseV1Schema>;
export const RemoteHostCatalogRowMutationV1Schema = lazyDefinition(() => z.strictObject({
    expectedRevision: z.union([revision, z.literal('absent')]), content: RemoteHostCatalogContentV1Schema,
    sourceSettingsVersion: z.optional(revision),
    referencedSavedSecretRevisions: z._default(z.array(z.strictObject({ resourceId: z.string().check(z.minLength(1), z.maxLength(128)), revision })), []),
}).check(z.superRefine((mutation, context) => {
    if (mutation.expectedRevision === 'absent' && mutation.sourceSettingsVersion === undefined)
        context.addIssue({ code: 'custom', path: ['sourceSettingsVersion'], message: 'First host catalog write requires captured source currentness' });
    if (mutation.expectedRevision !== 'absent' && mutation.sourceSettingsVersion !== undefined)
        context.addIssue({ code: 'custom', path: ['sourceSettingsVersion'], message: 'Source currentness only initializes the catalog' });
    const ids = mutation.referencedSavedSecretRevisions.map(resource => resource.resourceId);
    if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', path: ['referencedSavedSecretRevisions'], message: 'Resource revisions must be unique' });
})));
export type RemoteHostCatalogRowMutationV1 = z.infer<typeof RemoteHostCatalogRowMutationV1Schema>;
export const RemoteHostCatalogRowMutationResponseV1Schema = lazyDefinition(() => z.union([
    z.strictObject({ status: z.literal('updated'), revision, cursor: revision }),
    z.strictObject({ status: z.literal('conflict'), revision: z.int().check(z.minimum(-1)) }),
    z.strictObject({ status: z.literal('settings-conflict'), revision }), RemoteHostCatalogRowFailureV1Schema,
]));
export type RemoteHostCatalogRowMutationResponseV1 = z.infer<typeof RemoteHostCatalogRowMutationResponseV1Schema>;
export const AccountEncryptionMigrateRemoteHostsDirectiveV1Schema = lazyDefinition(() => z.strictObject({ expectedRevision: revision,
    content: z.nullable(RemoteHostCatalogContentV1Schema) }));
export type AccountEncryptionMigrateRemoteHostsDirectiveV1 = z.infer<typeof AccountEncryptionMigrateRemoteHostsDirectiveV1Schema>;
export const AccountEncryptionMigrateRemoteHostsResultV1Schema = lazyDefinition(() => z.strictObject({ revision,
    content: z.nullable(RemoteHostCatalogContentV1Schema) }));
export type AccountEncryptionMigrateRemoteHostsResultV1 = z.infer<typeof AccountEncryptionMigrateRemoteHostsResultV1Schema>;
export type RemoteHostCatalogSnapshotV1 = Readonly<{ status: 'loading' }>
    | Readonly<{ status: 'unavailable'; reason: string }>
    | Readonly<{ status: 'ready' | 'partial'; hosts: readonly RemoteHostRecordV1[]; diagnostics: readonly RemoteHostCatalogDiagnosticV1[];
        revision: number | 'absent'; cleanup?: 'pending' }>;
