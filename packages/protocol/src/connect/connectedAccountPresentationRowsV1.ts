import { QualifiedConnectedEntityRefSchema, QualifiedAcknowledgementSubjectSchema, ConnectedPresentationEntryV1Schema, ConnectedAcknowledgementEntryV1Schema, ConnectedPresentationRecordV1Schema, ConnectedAcknowledgementsRecordV1Schema, StoredConnectedPresentationContentV1Schema, StoredConnectedAcknowledgementsContentV1Schema, StoredConnectedRecordEnvelopeV1Schema, QualifiedConnectedDisclosureSubjectSchema, connectedEntitySubjectKeyV1, connectedAcknowledgementSubjectKeyV1 } from "./connectedAccountPresentationSchemasV1.js";
import type { QualifiedConnectedEntityRef, QualifiedAcknowledgementSubject, ConnectedPresentationEntryV1, ConnectedAcknowledgementEntryV1, ConnectedPresentationRecordV1, ConnectedAcknowledgementsRecordV1, ConnectedPresentationContentV1, ConnectedAcknowledgementsContentV1, StoredConnectedPresentationContentV1, StoredConnectedAcknowledgementsContentV1, ConnectedMetadataDiagnosticV1, QualifiedConnectedDisclosureSubject, LegacyConnectedMetadataInventoryV1, LegacyConnectedMetadataResultV1 } from "./connectedAccountPresentationSchemasV1.js";
export { QualifiedConnectedEntityRefSchema, QualifiedAcknowledgementSubjectSchema, ConnectedPresentationEntryV1Schema, ConnectedAcknowledgementEntryV1Schema, ConnectedPresentationRecordV1Schema, ConnectedAcknowledgementsRecordV1Schema, StoredConnectedPresentationRecordV1Schema, StoredConnectedAcknowledgementsRecordV1Schema, ConnectedPresentationContentV1Schema, ConnectedAcknowledgementsContentV1Schema, StoredConnectedPresentationContentV1Schema, StoredConnectedAcknowledgementsContentV1Schema, ConnectedMetadataRowFailureV1Schema, ConnectedPresentationRowReadResponseV1Schema, ConnectedAcknowledgementsRowReadResponseV1Schema, ConnectedPresentationRowMutationV1Schema, ConnectedAcknowledgementsRowMutationV1Schema, ConnectedMetadataRowMutationResponseV1Schema, ConnectedPresentationRowMutationResponseV1Schema, ConnectedAcknowledgementsRowMutationResponseV1Schema, AccountEncryptionMigrateConnectedPresentationDirectiveV1Schema, AccountEncryptionMigrateConnectedAcknowledgementsDirectiveV1Schema, AccountEncryptionMigrateConnectedPresentationResultV1Schema, AccountEncryptionMigrateConnectedAcknowledgementsResultV1Schema, QualifiedConnectedDisclosureSubjectSchema, connectedEntitySubjectKeyV1, connectedAcknowledgementSubjectKeyV1 } from "./connectedAccountPresentationSchemasV1.js";
export type { QualifiedConnectedEntityRef, QualifiedAcknowledgementSubject, ConnectedPresentationEntryV1, ConnectedAcknowledgementEntryV1, ConnectedPresentationRecordV1, ConnectedAcknowledgementsRecordV1, ConnectedPresentationContentV1, ConnectedAcknowledgementsContentV1, StoredConnectedPresentationContentV1, StoredConnectedAcknowledgementsContentV1, ConnectedMetadataDiagnosticV1, ConnectedPresentationCatalogSnapshotV1, ConnectedAcknowledgementsCatalogSnapshotV1, ConnectedPresentationRowMutationV1, ConnectedAcknowledgementsRowMutationV1, AccountEncryptionMigrateConnectedPresentationDirectiveV1, AccountEncryptionMigrateConnectedAcknowledgementsDirectiveV1, AccountEncryptionMigrateConnectedPresentationResultV1, AccountEncryptionMigrateConnectedAcknowledgementsResultV1, QualifiedConnectedDisclosureSubject, LegacyConnectedMetadataInventoryV1, ConnectedDisclosureEntryV1, LegacyConnectedMetadataResultV1 } from "./connectedAccountPresentationSchemasV1.js";
import * as z from 'zod/mini';
import tweetnacl from 'tweetnacl';

import { createStoredReadSchema } from '../json/storedReadSchema.js';

import { buildQualifiedPluginContributionKey, type PluginContributionIdentityV1 } from '../plugins/contributionIdentity.js';
import { sameQualifiedConnectedAccountRef } from './qualifiedConnectedAccountPersistence.js';
import { readBuiltInLegacyConnectedServiceIdForQualifiedService } from './connectedServiceBindings.js';
import { connectedServiceProfileKey } from './connectedServiceProfilePreferences.js';
import { BackendTargetKeyV2Schema } from '../backends/targets/backendTargetRefV2.js';
import { isAccountScopedBlobCiphertextForKind } from '../crypto/accountScopedCipherEnvelope.js';
import { openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext, type AccountScopedCryptoMaterial } from '../crypto/accountScopedCipher.js';

export const CONNECTED_PRESENTATION_ACCOUNT_KV_KEY_V1 = '@happier/account/connected-presentation/v1/catalog' as const;
export const CONNECTED_ACKNOWLEDGEMENTS_ACCOUNT_KV_KEY_V1 = '@happier/account/connected-acknowledgements/v1/catalog' as const;
export const CONNECTED_PRESENTATION_ACCOUNT_CIPHER_KIND_V1 = 'account_connected_presentation_catalog' as const;
export const CONNECTED_ACKNOWLEDGEMENTS_ACCOUNT_CIPHER_KIND_V1 = 'account_connected_acknowledgement_catalog' as const;
export const CONNECTED_PRESENTATION_SOURCE_ROOTS_V1 = ['connectedServicesProfileLabelByKey'] as const;
export const CONNECTED_ACKNOWLEDGEMENTS_SOURCE_ROOTS_V1 = ['connectedServicesDefaultAuthPoolAdoptionDismissedByKey', 'dismissedCLIWarnings'] as const;
export const CONNECTED_DISCLOSURE_SOURCE_ROOT_V1 = 'connectedServicesCollapsedItemKeysV1' as const;
export const CONNECTED_METADATA_ROWS_ROUTE_V1 = '/v1/account/entity-rows/connected-metadata' as const;
export const CONNECTED_PRESENTATION_ROWS_ROUTE_V1 = `${CONNECTED_METADATA_ROWS_ROUTE_V1}/presentation` as const;
export const CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1 = `${CONNECTED_METADATA_ROWS_ROUTE_V1}/acknowledgements` as const;
const storedPresentationEntry = createStoredReadSchema(ConnectedPresentationEntryV1Schema);
const storedAcknowledgementEntry = createStoredReadSchema(ConnectedAcknowledgementEntryV1Schema);

type Mode = 'plain' | 'e2ee';
type CipherKind = typeof CONNECTED_PRESENTATION_ACCOUNT_CIPHER_KIND_V1 | typeof CONNECTED_ACKNOWLEDGEMENTS_ACCOUNT_CIPHER_KIND_V1;
type Content = StoredConnectedPresentationContentV1 | StoredConnectedAcknowledgementsContentV1;
function assertContentForMode(content: Content, mode: Mode, kind: CipherKind): void {
    if ((mode === 'plain') !== (content.t === 'plain') || (content.t === 'encrypted' && !isAccountScopedBlobCiphertextForKind({ kind, ciphertext: content.c }))) throw new Error('account-mode-mismatch');
}
export function assertConnectedPresentationContentForModeV1(content: StoredConnectedPresentationContentV1, mode: Mode): void {
    assertContentForMode(content, mode, CONNECTED_PRESENTATION_ACCOUNT_CIPHER_KIND_V1);
}
export function assertConnectedAcknowledgementsContentForModeV1(content: StoredConnectedAcknowledgementsContentV1, mode: Mode): void {
    assertContentForMode(content, mode, CONNECTED_ACKNOWLEDGEMENTS_ACCOUNT_CIPHER_KIND_V1);
}
type OpenInput = Readonly<{ mode: Mode; material: AccountScopedCryptoMaterial | null; content: unknown }>;
type OpenResult<Record> = Readonly<{ status: 'opened'; record: Record }>
    | Readonly<{ status: 'partial'; record: Record; diagnostics: readonly ConnectedMetadataDiagnosticV1[] }>
    | Readonly<{ status: 'unavailable'; reason: 'account-mode-mismatch' | 'encryption-material-unavailable' | 'invalid-stored-content' }>;
function openContent<Entry>(input: OpenInput, kind: CipherKind, contentSchema: z.ZodMiniType<Content>, entrySchema: z.ZodMiniType<Entry>,
    entryKey: (entry: Entry) => string, root: string): OpenResult<{ v: 1; entries: Entry[] }> {
    const content = contentSchema.safeParse(input.content);
    if (!content.success) return { status: 'unavailable', reason: 'invalid-stored-content' };
    try { assertContentForMode(content.data, input.mode, kind); } catch { return { status: 'unavailable', reason: 'account-mode-mismatch' }; }
    if (input.mode === 'plain' && input.material !== null) return { status: 'unavailable', reason: 'account-mode-mismatch' };
    let value: unknown;
    if (content.data.t === 'plain') value = content.data.v;
    else {
        if (!input.material) return { status: 'unavailable', reason: 'encryption-material-unavailable' };
        value = openAccountScopedBlobCiphertext({ kind, material: input.material, ciphertext: content.data.c })?.value;
    }
    const record = StoredConnectedRecordEnvelopeV1Schema.safeParse(value);
    if (!record.success) return { status: 'unavailable', reason: 'invalid-stored-content' };
    const diagnostics: ConnectedMetadataDiagnosticV1[] = [];
    const entries: Array<{ entry: Entry; key: string }> = [];
    const seen = new Set<string>();
    const duplicateKeys = new Set<string>();
    for (const [index, raw] of record.data.entries.entries()) {
        const parsed = entrySchema.safeParse(raw);
        if (!parsed.success) { diagnostics.push({ root, key: String(index), reason: 'invalid-stored-content' }); continue; }
        const key = entryKey(parsed.data);
        if (seen.has(key)) { duplicateKeys.add(key); diagnostics.push({ root, key, reason: 'duplicate-subject' }); }
        seen.add(key); entries.push({ entry: parsed.data, key });
    }
    const projected = { v: 1 as const, entries: entries.filter(entry => !duplicateKeys.has(entry.key)).map(entry => entry.entry) };
    return diagnostics.length ? { status: 'partial', record: projected, diagnostics } : { status: 'opened', record: projected };
}
export function openConnectedPresentationContentV1(input: OpenInput): OpenResult<ConnectedPresentationRecordV1> {
    return openContent(input, CONNECTED_PRESENTATION_ACCOUNT_CIPHER_KIND_V1, StoredConnectedPresentationContentV1Schema, storedPresentationEntry,
        entry => connectedEntitySubjectKeyV1(entry.subject), CONNECTED_PRESENTATION_ACCOUNT_KV_KEY_V1);
}
export function openConnectedAcknowledgementsContentV1(input: OpenInput): OpenResult<ConnectedAcknowledgementsRecordV1> {
    return openContent(input, CONNECTED_ACKNOWLEDGEMENTS_ACCOUNT_CIPHER_KIND_V1, StoredConnectedAcknowledgementsContentV1Schema, storedAcknowledgementEntry,
        entry => connectedAcknowledgementSubjectKeyV1(entry.subject), CONNECTED_ACKNOWLEDGEMENTS_ACCOUNT_KV_KEY_V1);
}
type SealInput<Record> = Readonly<{ record: Record; mode: Mode; material: AccountScopedCryptoMaterial | null; randomBytes?: (length: number) => Uint8Array }>;
function sealContent<Record>(input: SealInput<Record>, kind: CipherKind, recordSchema: z.ZodMiniType<Record>) {
    const record = recordSchema.parse(input.record);
    if (input.mode === 'plain') {
        if (input.material !== null) throw new Error('account-mode-mismatch');
        return { t: 'plain' as const, v: record };
    }
    if (!input.material) throw new Error('encryption-material-unavailable');
    return { t: 'encrypted' as const, c: sealAccountScopedBlobCiphertext({ kind, material: input.material, payload: record, randomBytes: input.randomBytes ?? tweetnacl.randomBytes }) };
}
export function sealConnectedPresentationContentV1(input: SealInput<ConnectedPresentationRecordV1>): ConnectedPresentationContentV1 {
    return sealContent(input, CONNECTED_PRESENTATION_ACCOUNT_CIPHER_KIND_V1, ConnectedPresentationRecordV1Schema);
}
export function sealConnectedAcknowledgementsContentV1(input: SealInput<ConnectedAcknowledgementsRecordV1>): ConnectedAcknowledgementsContentV1 {
    return sealContent(input, CONNECTED_ACKNOWLEDGEMENTS_ACCOUNT_CIPHER_KIND_V1, ConnectedAcknowledgementsRecordV1Schema);
}
function serviceKeys(service: PluginContributionIdentityV1): readonly string[] {
    const legacy = readBuiltInLegacyConnectedServiceIdForQualifiedService(service);
    return legacy ? [buildQualifiedPluginContributionKey(service), legacy] : [buildQualifiedPluginContributionKey(service)];
}
function objectRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function connectedDisclosureSubjectKeyV1(subject: QualifiedConnectedDisclosureSubject): string {
    const parsed = QualifiedConnectedDisclosureSubjectSchema.parse(subject);
    return parsed.kind === 'account' ? connectedEntitySubjectKeyV1(parsed)
        : JSON.stringify(['group-member', parsed.group.service.pluginId, parsed.group.service.localId, parsed.group.groupId, parsed.accountId]);
}
function addCandidate<Subject>(candidates: Map<string, Map<string, Subject>>, address: string, identity: string, subject: Subject): void {
    const existing = candidates.get(address) ?? new Map<string, Subject>();
    existing.set(identity, subject); candidates.set(address, existing);
}
function readQualifiedLegacyValues<Subject, Value extends string | boolean>(input: Readonly<{
    raw: Readonly<Record<string, unknown>>; root: string; candidates: Map<string, Map<string, Subject>>;
    kind: 'string' | 'boolean'; diagnostics: ConnectedMetadataDiagnosticV1[];
}>): Array<{ subject: Subject; value: Value; keys: readonly string[] }> {
    const source = input.raw[input.root];
    if (source === undefined && !Object.hasOwn(input.raw, input.root)) return [];
    if (!objectRecord(source)) { input.diagnostics.push({ root: input.root, reason: 'invalid-stored-content' }); return []; }
    const accepted = new Map<string, { subject: Subject; value: Value; keys: string[] }>();
    const conflicts = new Set<string>();
    for (const [key, value] of Object.entries(source)) {
        if (typeof value !== input.kind) { input.diagnostics.push({ root: input.root, key, reason: 'invalid-stored-content' }); continue; }
        const candidates = input.candidates.get(key);
        if (!candidates?.size || candidates.size !== 1) {
            input.diagnostics.push({ root: input.root, key, reason: candidates?.size ? 'ambiguous-subject' : 'unknown-subject' }); continue;
        }
        const [identity, subject] = [...candidates][0]!;
        const previous = accepted.get(identity);
        if (previous && previous.value !== value) {
            conflicts.add(identity); input.diagnostics.push({ root: input.root, key, reason: 'conflicting-values' }); continue;
        }
        if (previous) previous.keys.push(key);
        else accepted.set(identity, { subject, value: value as Value, keys: [key] });
    }
    return [...accepted].flatMap(([identity, entry]) => conflicts.has(identity) ? [] : [entry]);
}
/** Enumerate exact proven addresses. Punctuation in an identity never supplies a parser. */
function buildLegacyConnectedMetadataCandidates(raw: Readonly<Record<string, unknown>>, inventory: LegacyConnectedMetadataInventoryV1, diagnostics: ConnectedMetadataDiagnosticV1[]) {
    const labelCandidates = new Map<string, Map<string, QualifiedConnectedEntityRef>>();
    const acknowledgementCandidates = new Map<string, Map<string, QualifiedAcknowledgementSubject>>();
    const disclosureCandidates = new Map<string, Map<string, QualifiedConnectedDisclosureSubject>>();
    const sourceHasEntries = (root: string) => { const value = raw[root]; return objectRecord(value) && Object.keys(value).length > 0; };
    for (const entity of inventory.entities) {
        const parsed = QualifiedConnectedEntityRefSchema.safeParse(entity);
        if (!parsed.success) {
            for (const root of [CONNECTED_PRESENTATION_SOURCE_ROOTS_V1[0], CONNECTED_ACKNOWLEDGEMENTS_SOURCE_ROOTS_V1[0], CONNECTED_DISCLOSURE_SOURCE_ROOT_V1]) {
                if (sourceHasEntries(root)) diagnostics.push({ root, reason: 'invalid-inventory' });
            }
            continue;
        }
        const subject = parsed.data;
        if (subject.kind === 'account') {
            for (const serviceId of serviceKeys(subject.account.service)) {
                for (const key of [connectedServiceProfileKey({ serviceId, profileId: subject.account.accountId }), `${serviceId}/${subject.account.accountId}`]) {
                    addCandidate(labelCandidates, key, connectedEntitySubjectKeyV1(subject), subject);
                }
                addCandidate(disclosureCandidates, `${serviceId}:account:${subject.account.accountId}`, connectedDisclosureSubjectKeyV1(subject), subject);
            }
        } else {
            for (const agent of inventory.agents) {
                if (!BackendTargetKeyV2Schema.safeParse(agent.agentTargetKey).success) {
                    if (sourceHasEntries(CONNECTED_ACKNOWLEDGEMENTS_SOURCE_ROOTS_V1[0])) diagnostics.push({ root: CONNECTED_ACKNOWLEDGEMENTS_SOURCE_ROOTS_V1[0], reason: 'invalid-inventory' });
                    continue;
                }
                const acknowledgement: QualifiedAcknowledgementSubject = { kind: 'adoption', agentTargetKey: agent.agentTargetKey, service: subject.service, groupId: subject.groupId };
                for (const serviceId of serviceKeys(subject.service)) for (const agentKey of [agent.agentTargetKey, agent.legacyAgentId]) {
                    addCandidate(acknowledgementCandidates, `${agentKey}:${serviceId}:${subject.groupId}`, connectedAcknowledgementSubjectKeyV1(acknowledgement), acknowledgement);
                }
            }
        }
    }
    for (const subject of inventory.disclosureSubjects ?? []) {
        const parsed = QualifiedConnectedDisclosureSubjectSchema.safeParse(subject);
        if (!parsed.success) { diagnostics.push({ root: CONNECTED_DISCLOSURE_SOURCE_ROOT_V1, reason: 'invalid-inventory' }); continue; }
        const value = parsed.data;
        for (const serviceId of serviceKeys(value.kind === 'account' ? value.account.service : value.group.service)) {
            const key = value.kind === 'account' ? `${serviceId}:account:${value.account.accountId}` : `${serviceId}:pool:${value.group.groupId}:${value.accountId}`;
            addCandidate(disclosureCandidates, key, connectedDisclosureSubjectKeyV1(value), value);
        }
    }
    return { labelCandidates, acknowledgementCandidates, disclosureCandidates };
}
export function readLegacyConnectedMetadataV1(raw: unknown, inventory: LegacyConnectedMetadataInventoryV1): LegacyConnectedMetadataResultV1 {
    const diagnostics: ConnectedMetadataDiagnosticV1[] = [];
    if (!objectRecord(raw)) return { status: 'partial', presentation: { v: 1, entries: [] }, acknowledgements: { v: 1, entries: [] }, disclosure: [], diagnostics: [{ root: 'accountSettings', reason: 'invalid-stored-content' }] };
    const { labelCandidates, acknowledgementCandidates, disclosureCandidates } = buildLegacyConnectedMetadataCandidates(raw, inventory, diagnostics);
    const labels = readQualifiedLegacyValues<QualifiedConnectedEntityRef, string>({ raw, root: CONNECTED_PRESENTATION_SOURCE_ROOTS_V1[0], candidates: labelCandidates, kind: 'string', diagnostics });
    const acknowledgements: ConnectedAcknowledgementEntryV1[] = readQualifiedLegacyValues<QualifiedAcknowledgementSubject, boolean>({ raw, root: CONNECTED_ACKNOWLEDGEMENTS_SOURCE_ROOTS_V1[0], candidates: acknowledgementCandidates, kind: 'boolean', diagnostics })
        .map(entry => ({ v: 1, subject: entry.subject, acknowledged: entry.value }));
    const warningRoot = CONNECTED_ACKNOWLEDGEMENTS_SOURCE_ROOTS_V1[1];
    const warnings = raw[warningRoot];
    if (Object.hasOwn(raw, warningRoot)) {
        if (!objectRecord(warnings)) diagnostics.push({ root: warningRoot, reason: 'invalid-stored-content' });
        else {
            const readWarnings = (values: unknown, scope: Extract<QualifiedAcknowledgementSubject, { kind: 'warning' }>['scope'], key: string) => {
                if (!objectRecord(values)) { diagnostics.push({ root: warningRoot, key, reason: 'invalid-stored-content' }); return; }
                for (const [warningId, value] of Object.entries(values)) {
                    if (typeof value !== 'boolean') diagnostics.push({ root: warningRoot, key: JSON.stringify([key, warningId]), reason: 'invalid-stored-content' });
                    else acknowledgements.push({ v: 1, subject: { kind: 'warning', warningId, scope }, acknowledged: value });
                }
            };
            readWarnings(warnings.global === undefined ? {} : warnings.global, { kind: 'account' }, 'global');
            const perMachine = warnings.perMachine === undefined ? {} : warnings.perMachine;
            if (!objectRecord(perMachine)) diagnostics.push({ root: warningRoot, key: 'perMachine', reason: 'invalid-stored-content' });
            else for (const [machineId, values] of Object.entries(perMachine)) readWarnings(values, { kind: 'machine', machineId }, machineId);
            if (Object.keys(warnings).some(key => key !== 'global' && key !== 'perMachine')) diagnostics.push({ root: warningRoot, reason: 'unknown-stored-fields' });
        }
    }
    const disclosure = readQualifiedLegacyValues<QualifiedConnectedDisclosureSubject, boolean>({ raw, root: CONNECTED_DISCLOSURE_SOURCE_ROOT_V1, candidates: disclosureCandidates, kind: 'boolean', diagnostics })
        .map(entry => ({ subject: entry.subject, collapsed: entry.value }));
    return { status: diagnostics.length ? 'partial' : 'ready', presentation: { v: 1, entries: labels.map(entry => ({ v: 1, subject: entry.subject, label: entry.value })) },
        acknowledgements: { v: 1, entries: acknowledgements }, disclosure, diagnostics };
}
export function removeLegacyConnectedMetadataSubjectV1(input: Readonly<{ raw: Readonly<Record<string, unknown>>; inventory: LegacyConnectedMetadataInventoryV1; subject: QualifiedConnectedEntityRef }>): Readonly<{ raw: Readonly<Record<string, unknown>>; diagnostics: readonly ConnectedMetadataDiagnosticV1[] }> {
    const subject = QualifiedConnectedEntityRefSchema.parse(input.subject);
    const subjectKey = connectedEntitySubjectKeyV1(subject);
    const diagnostics: ConnectedMetadataDiagnosticV1[] = [];
    const candidates = buildLegacyConnectedMetadataCandidates(input.raw, input.inventory, diagnostics);
    const raw: Record<string, unknown> = { ...input.raw };
    function removeQualified<Subject, Value extends string | boolean>(root: string, addresses: Map<string, Map<string, Subject>>, kind: 'string' | 'boolean', matches: (candidate: Subject) => boolean): void {
        const accepted = readQualifiedLegacyValues<Subject, Value>({ raw: input.raw, root, candidates: addresses, kind, diagnostics });
        if (diagnostics.some(diagnostic => diagnostic.root === root && diagnostic.reason === 'invalid-inventory')) return;
        const keys = accepted.filter(entry => matches(entry.subject)).flatMap(entry => entry.keys);
        const source = input.raw[root];
        if (!keys.length || !objectRecord(source)) return;
        const remaining: Record<string, unknown> = { ...source };
        for (const key of keys) delete remaining[key];
        raw[root] = remaining;
    }
    removeQualified<QualifiedConnectedEntityRef, string>(CONNECTED_PRESENTATION_SOURCE_ROOTS_V1[0], candidates.labelCandidates, 'string', candidate => connectedEntitySubjectKeyV1(candidate) === subjectKey);
    removeQualified<QualifiedAcknowledgementSubject, boolean>(CONNECTED_ACKNOWLEDGEMENTS_SOURCE_ROOTS_V1[0], candidates.acknowledgementCandidates, 'boolean', candidate => subject.kind === 'group' && candidate.kind === 'adoption'
        && connectedEntitySubjectKeyV1({ kind: 'group', service: candidate.service, groupId: candidate.groupId }) === subjectKey);
    removeQualified<QualifiedConnectedDisclosureSubject, boolean>(CONNECTED_DISCLOSURE_SOURCE_ROOT_V1, candidates.disclosureCandidates, 'boolean', candidate => {
        if (subject.kind === 'account') return sameQualifiedConnectedAccountRef(candidate.kind === 'account' ? candidate.account
            : { service: candidate.group.service, accountId: candidate.accountId }, subject.account);
        return candidate.kind === 'group-member' && connectedEntitySubjectKeyV1({ kind: 'group', ...candidate.group }) === subjectKey;
    });
    return { raw, diagnostics };
}
export function removeConnectedMetadataSubjectV1(input: Readonly<{ presentation: ConnectedPresentationRecordV1; acknowledgements: ConnectedAcknowledgementsRecordV1; subject: QualifiedConnectedEntityRef }>) {
    const key = connectedEntitySubjectKeyV1(input.subject);
    const presentation = ConnectedPresentationRecordV1Schema.parse(input.presentation);
    const acknowledgements = ConnectedAcknowledgementsRecordV1Schema.parse(input.acknowledgements);
    return { presentation: { v: 1 as const, entries: presentation.entries.filter(entry => connectedEntitySubjectKeyV1(entry.subject) !== key) },
        acknowledgements: { v: 1 as const, entries: acknowledgements.entries.filter(entry => input.subject.kind !== 'group' || entry.subject.kind !== 'adoption'
            || connectedEntitySubjectKeyV1({ kind: 'group', service: entry.subject.service, groupId: entry.subject.groupId }) !== key) } };
}
export function applyConnectedPresentationMutationV1(record: ConnectedPresentationRecordV1, change: Readonly<{ subject: QualifiedConnectedEntityRef; label: string | null }>): ConnectedPresentationRecordV1 {
    const source = ConnectedPresentationRecordV1Schema.parse(record);
    const key = connectedEntitySubjectKeyV1(change.subject);
    const label = change.label?.trim() ?? '';
    const entries = source.entries.filter(entry => connectedEntitySubjectKeyV1(entry.subject) !== key);
    if (label) entries.push({ v: 1, subject: QualifiedConnectedEntityRefSchema.parse(change.subject), label });
    return { v: 1, entries };
}
export function applyConnectedAcknowledgementMutationV1(record: ConnectedAcknowledgementsRecordV1, change: Readonly<{ subject: QualifiedAcknowledgementSubject; acknowledged: boolean | null }>): ConnectedAcknowledgementsRecordV1 {
    const source = ConnectedAcknowledgementsRecordV1Schema.parse(record);
    const key = connectedAcknowledgementSubjectKeyV1(change.subject);
    const entries = source.entries.filter(entry => connectedAcknowledgementSubjectKeyV1(entry.subject) !== key);
    if (change.acknowledged !== null) entries.push({ v: 1, subject: QualifiedAcknowledgementSubjectSchema.parse(change.subject), acknowledged: change.acknowledged });
    return { v: 1, entries };
}
/** Adapter for the existing label display selector; the catalog remains the authority. */
export function projectConnectedPresentationLabelsV1(catalog: Readonly<{ entries: readonly ConnectedPresentationEntryV1[] }>): Record<string, string> {
    const labels: Record<string, string> = {};
    for (const entry of catalog.entries) {
        const key = entry.subject.kind === 'account'
            ? connectedServiceProfileKey({ serviceId: buildQualifiedPluginContributionKey(entry.subject.account.service), profileId: entry.subject.account.accountId })
            : connectedEntitySubjectKeyV1(entry.subject);
        labels[key] = entry.label;
    }
    return labels;
}
