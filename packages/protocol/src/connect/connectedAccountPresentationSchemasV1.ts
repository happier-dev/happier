import * as z from 'zod/mini';
import { lazyDefinition } from '../lazyZodSchema.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import { QualifiedConnectedAccountRefSchema, QualifiedConnectedAccountIdSchema } from './qualifiedConnectedAccountPersistence.js';
import { ConnectedServiceAuthGroupIdSchema } from './connectedServiceBindings.js';
import { BackendTargetKeyV2Schema } from '../backends/targets/backendTargetRefV2.js';
import { listSavedSecretReferenceCarrierPathsV1 } from '../account/settings/savedSecretReferenceV1.js';
import { ProviderAccountSubscriptionMonthlyPriceV1Schema } from './accountSubscription.js';


export const QualifiedConnectedEntityRefSchema = lazyDefinition(() => z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('account'), account: asProtocolZod(QualifiedConnectedAccountRefSchema) }),
    z.strictObject({ kind: z.literal('group'), service: asProtocolZod(PluginContributionIdentityV1Schema), groupId: ConnectedServiceAuthGroupIdSchema }),
]));
export type QualifiedConnectedEntityRef = z.infer<typeof QualifiedConnectedEntityRefSchema>;
export const QualifiedAcknowledgementSubjectSchema = lazyDefinition(() => z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('adoption'), agentTargetKey: BackendTargetKeyV2Schema, service: asProtocolZod(PluginContributionIdentityV1Schema), groupId: ConnectedServiceAuthGroupIdSchema }),
    z.strictObject({ kind: z.literal('warning'), warningId: z.string(), scope: z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('account') }), z.strictObject({ kind: z.literal('machine'), machineId: z.string() }),
    ]) }),
]));
export type QualifiedAcknowledgementSubject = z.infer<typeof QualifiedAcknowledgementSubjectSchema>;

export function connectedEntitySubjectKeyV1(subject: QualifiedConnectedEntityRef): string {
    const parsed = QualifiedConnectedEntityRefSchema.parse(subject);
    return parsed.kind === 'account' ? JSON.stringify(['account', parsed.account.service.pluginId, parsed.account.service.localId, parsed.account.accountId])
        : JSON.stringify(['group', parsed.service.pluginId, parsed.service.localId, parsed.groupId]);
}
export function connectedAcknowledgementSubjectKeyV1(subject: QualifiedAcknowledgementSubject): string {
    const parsed = QualifiedAcknowledgementSubjectSchema.parse(subject);
    return parsed.kind === 'adoption' ? JSON.stringify(['adoption', parsed.agentTargetKey, parsed.service.pluginId, parsed.service.localId, parsed.groupId])
        : JSON.stringify(['warning', parsed.warningId, parsed.scope.kind, parsed.scope.kind === 'machine' ? parsed.scope.machineId : null]);
}
export const ConnectedPresentationEntryV1Schema = lazyDefinition(() => z.strictObject({ v: z.literal(1), subject: QualifiedConnectedEntityRefSchema, label: z.string(),
    subscriptionMonthlyPrice: z.optional(ProviderAccountSubscriptionMonthlyPriceV1Schema),
}).check(z.superRefine((entry, context) => {
    if (entry.subscriptionMonthlyPrice && entry.subject.kind !== 'account') context.addIssue({ code: 'custom', path: ['subscriptionMonthlyPrice'], message: 'Subscription price requires an exact connected account' });
})));
export type ConnectedPresentationEntryV1 = z.infer<typeof ConnectedPresentationEntryV1Schema>;
export const ConnectedAcknowledgementEntryV1Schema = lazyDefinition(() => z.strictObject({ v: z.literal(1), subject: QualifiedAcknowledgementSubjectSchema, acknowledged: z.boolean() }));
export type ConnectedAcknowledgementEntryV1 = z.infer<typeof ConnectedAcknowledgementEntryV1Schema>;
export const ConnectedPresentationRecordV1Schema = lazyDefinition(() => z.strictObject({ v: z.literal(1), entries: z.array(ConnectedPresentationEntryV1Schema) })
    .check(z.superRefine((record, context) => {
        const keys = record.entries.map(entry => connectedEntitySubjectKeyV1(entry.subject));
        if (new Set(keys).size !== keys.length) context.addIssue({ code: 'custom', path: ['entries'], message: 'Connected presentation subjects must be unique' });
    })));
export type ConnectedPresentationRecordV1 = z.infer<typeof ConnectedPresentationRecordV1Schema>;
export const ConnectedAcknowledgementsRecordV1Schema = lazyDefinition(() => z.strictObject({ v: z.literal(1), entries: z.array(ConnectedAcknowledgementEntryV1Schema) })
    .check(z.superRefine((record, context) => {
        const keys = record.entries.map(entry => connectedAcknowledgementSubjectKeyV1(entry.subject));
        if (new Set(keys).size !== keys.length) context.addIssue({ code: 'custom', path: ['entries'], message: 'Connected acknowledgement subjects must be unique' });
    })));
export type ConnectedAcknowledgementsRecordV1 = z.infer<typeof ConnectedAcknowledgementsRecordV1Schema>;
/** These metadata domains declare no SavedSecret slots. Inspect the original
 * stored JSON before tolerant projection can erase a future carrier. */
const storedConnectedMetadataAdmission = lazyDefinition(() => z.unknown().check(z.superRefine((raw, context) => {
    if (listSavedSecretReferenceCarrierPathsV1(raw).length) {
        context.addIssue({ code: 'custom', message: 'Stored connected metadata contains an unclassified SavedSecret reference' });
    }
})));
export const StoredConnectedPresentationRecordV1Schema = lazyDefinition(() => z.pipe(storedConnectedMetadataAdmission,
    createStoredReadSchema(ConnectedPresentationRecordV1Schema)));
export const StoredConnectedAcknowledgementsRecordV1Schema = lazyDefinition(() => z.pipe(storedConnectedMetadataAdmission,
    createStoredReadSchema(ConnectedAcknowledgementsRecordV1Schema)));
export const ConnectedPresentationContentV1Schema = lazyDefinition(() => z.discriminatedUnion('t', [
    z.strictObject({ t: z.literal('plain'), v: ConnectedPresentationRecordV1Schema }), z.strictObject({ t: z.literal('encrypted'), c: z.string().check(z.minLength(1)) }),
]));
export type ConnectedPresentationContentV1 = z.infer<typeof ConnectedPresentationContentV1Schema>;
export const ConnectedAcknowledgementsContentV1Schema = lazyDefinition(() => z.discriminatedUnion('t', [
    z.strictObject({ t: z.literal('plain'), v: ConnectedAcknowledgementsRecordV1Schema }), z.strictObject({ t: z.literal('encrypted'), c: z.string().check(z.minLength(1)) }),
]));
export type ConnectedAcknowledgementsContentV1 = z.infer<typeof ConnectedAcknowledgementsContentV1Schema>;
const StoredConnectedContentEnvelopeV1Schema = lazyDefinition(() => z.pipe(storedConnectedMetadataAdmission,
    createStoredReadSchema(lazyDefinition(() => z.discriminatedUnion('t', [
    z.strictObject({ t: z.literal('plain'), v: z.unknown() }), z.strictObject({ t: z.literal('encrypted'), c: z.string().check(z.minLength(1)) }),
])))));
export const StoredConnectedPresentationContentV1Schema = StoredConnectedContentEnvelopeV1Schema;
export const StoredConnectedAcknowledgementsContentV1Schema = StoredConnectedContentEnvelopeV1Schema;
export type StoredConnectedPresentationContentV1 = z.infer<typeof StoredConnectedPresentationContentV1Schema>;
export type StoredConnectedAcknowledgementsContentV1 = z.infer<typeof StoredConnectedAcknowledgementsContentV1Schema>;
export const StoredConnectedRecordEnvelopeV1Schema = lazyDefinition(() => z.pipe(storedConnectedMetadataAdmission,
    z.object({ v: z.literal(1), entries: z.array(z.unknown()) })));

export type ConnectedMetadataDiagnosticV1 = Readonly<{ root: string; key?: string; reason: string }>;
type CatalogSnapshot<Entry> = Readonly<{ status: 'ready'; entries: readonly Entry[]; revision: number; diagnostics: readonly [] }>
    | Readonly<{ status: 'loading' }> | Readonly<{ status: 'unavailable'; reason: string }>
    | Readonly<{ status: 'partial'; entries: readonly Entry[]; revision: number | 'absent'; diagnostics: readonly ConnectedMetadataDiagnosticV1[] }>;
export type ConnectedPresentationCatalogSnapshotV1 = CatalogSnapshot<ConnectedPresentationEntryV1>;
export type ConnectedAcknowledgementsCatalogSnapshotV1 = CatalogSnapshot<ConnectedAcknowledgementEntryV1>;

const revision = lazyDefinition(() => z.int().check(z.minimum(0), z.maximum(Number.MAX_SAFE_INTEGER)));
export const ConnectedMetadataRowFailureV1Schema = lazyDefinition(() => z.strictObject({
    status: z.enum(['account-not-found', 'account-inconsistent', 'account-mode-mismatch', 'invalid-stored-content']), reason: z.optional(z.string()),
}));
function rowReadSchema<Envelope>(content: z.ZodMiniType<Envelope>) {
    return lazyDefinition(() => z.union([
        z.strictObject({ status: z.literal('present'), revision, content }), z.strictObject({ status: z.literal('absent') }),
        z.strictObject({ status: z.literal('deleted'), revision }), ConnectedMetadataRowFailureV1Schema,
    ]));
}
function rowMutationSchema<Envelope>(content: z.ZodMiniType<Envelope>) {
    return lazyDefinition(() => z.strictObject({ expectedRevision: z.union([revision, z.literal('absent')]), content: z.nullable(content), sourceSettingsVersion: z.optional(revision) })
        .check(z.superRefine((mutation, context) => {
            if (mutation.expectedRevision === 'absent' && (mutation.sourceSettingsVersion === undefined || mutation.content === null)) {
                context.addIssue({ code: 'custom', path: ['sourceSettingsVersion'], message: 'First destination authority requires source currentness' });
            }
            if (mutation.sourceSettingsVersion !== undefined && (mutation.expectedRevision !== 'absent' || mutation.content === null)) {
                context.addIssue({ code: 'custom', path: ['sourceSettingsVersion'], message: 'Source admission initializes destination authority only' });
            }
        })));
}
export const ConnectedPresentationRowReadResponseV1Schema = rowReadSchema(StoredConnectedPresentationContentV1Schema);
export const ConnectedAcknowledgementsRowReadResponseV1Schema = rowReadSchema(StoredConnectedAcknowledgementsContentV1Schema);
export const ConnectedPresentationRowMutationV1Schema = rowMutationSchema(ConnectedPresentationContentV1Schema);
export type ConnectedPresentationRowMutationV1 = z.infer<typeof ConnectedPresentationRowMutationV1Schema>;
export const ConnectedAcknowledgementsRowMutationV1Schema = rowMutationSchema(ConnectedAcknowledgementsContentV1Schema);
export type ConnectedAcknowledgementsRowMutationV1 = z.infer<typeof ConnectedAcknowledgementsRowMutationV1Schema>;
export const ConnectedMetadataRowMutationResponseV1Schema = lazyDefinition(() => z.union([
    z.strictObject({ status: z.literal('updated'), revision, cursor: revision }), z.strictObject({ status: z.literal('conflict'), revision: z.int().check(z.minimum(-1)) }),
    z.strictObject({ status: z.literal('settings-conflict'), revision }), ConnectedMetadataRowFailureV1Schema,
]));
export const ConnectedPresentationRowMutationResponseV1Schema = ConnectedMetadataRowMutationResponseV1Schema;
export const ConnectedAcknowledgementsRowMutationResponseV1Schema = ConnectedMetadataRowMutationResponseV1Schema;
export const AccountEncryptionMigrateConnectedPresentationDirectiveV1Schema = lazyDefinition(() => z.strictObject({ expectedRevision: revision, content: z.nullable(ConnectedPresentationContentV1Schema) }));
export type AccountEncryptionMigrateConnectedPresentationDirectiveV1 = z.infer<typeof AccountEncryptionMigrateConnectedPresentationDirectiveV1Schema>;
export const AccountEncryptionMigrateConnectedAcknowledgementsDirectiveV1Schema = lazyDefinition(() => z.strictObject({ expectedRevision: revision, content: z.nullable(ConnectedAcknowledgementsContentV1Schema) }));
export type AccountEncryptionMigrateConnectedAcknowledgementsDirectiveV1 = z.infer<typeof AccountEncryptionMigrateConnectedAcknowledgementsDirectiveV1Schema>;
export const AccountEncryptionMigrateConnectedPresentationResultV1Schema = lazyDefinition(() => z.strictObject({ revision, content: z.nullable(ConnectedPresentationContentV1Schema) }));
export type AccountEncryptionMigrateConnectedPresentationResultV1 = z.infer<typeof AccountEncryptionMigrateConnectedPresentationResultV1Schema>;
export const AccountEncryptionMigrateConnectedAcknowledgementsResultV1Schema = lazyDefinition(() => z.strictObject({ revision, content: z.nullable(ConnectedAcknowledgementsContentV1Schema) }));
export type AccountEncryptionMigrateConnectedAcknowledgementsResultV1 = z.infer<typeof AccountEncryptionMigrateConnectedAcknowledgementsResultV1Schema>;

export const QualifiedConnectedDisclosureSubjectSchema = lazyDefinition(() => z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('account'), account: asProtocolZod(QualifiedConnectedAccountRefSchema) }),
    z.strictObject({ kind: z.literal('group-member'), group: z.strictObject({ service: asProtocolZod(PluginContributionIdentityV1Schema), groupId: ConnectedServiceAuthGroupIdSchema }), accountId: asProtocolZod(QualifiedConnectedAccountIdSchema) }),
]));
export type QualifiedConnectedDisclosureSubject = z.infer<typeof QualifiedConnectedDisclosureSubjectSchema>;
export type LegacyConnectedMetadataInventoryV1 = Readonly<{
    entities: readonly QualifiedConnectedEntityRef[]; agents: readonly Readonly<{ agentTargetKey: string; legacyAgentId: string }>[];
    disclosureSubjects?: readonly QualifiedConnectedDisclosureSubject[];
}>;
export type ConnectedDisclosureEntryV1 = Readonly<{ subject: QualifiedConnectedDisclosureSubject; collapsed: boolean }>;
export type LegacyConnectedMetadataResultV1 = Readonly<{
    status: 'ready' | 'partial'; presentation: ConnectedPresentationRecordV1; acknowledgements: ConnectedAcknowledgementsRecordV1;
    disclosure: readonly ConnectedDisclosureEntryV1[]; diagnostics: readonly ConnectedMetadataDiagnosticV1[];
}>;

export const ConnectedMetadataCleanupV1Schema = lazyDefinition(() => z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('complete') }), z.strictObject({ status: z.literal('cleanup-pending'), reason: z.string() }),
]));

export type ConnectedMetadataCleanupV1 = Readonly<z.infer<typeof ConnectedMetadataCleanupV1Schema>>;
