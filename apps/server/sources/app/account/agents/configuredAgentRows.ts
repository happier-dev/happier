import {
    ACP_CATALOG_ACCOUNT_ROW_KEY_V1, AcpCatalogContentV1Schema, StoredAcpCatalogContentV1Schema,
    AcpCatalogRowMutationV1Schema, AcpCatalogRowMutationResponseV1Schema, AcpCatalogRowReadResponseV1Schema,
    assertAcpCatalogContentForModeV1, openAcpCatalogContentV1, isFreshAcpCatalogSourceV1,
    listAcpCatalogSavedSecretRefsV1, listAcpCatalogEnvelopeSavedSecretDiagnosticsV1,
    type StoredAcpCatalogContentV1, type AcpCatalogRowMutationV1,
} from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { prepareAcpCatalogTransferV2 } from '@happier-dev/protocol/acp/catalog/transferAcpCatalogV2';
import type { AccountSettingsCleanupV1 } from '@happier-dev/protocol/account/settings/accountSettingsStoredContentEnvelope';
import { KIRO_ACP_STDERR_RULES } from '@happier-dev/plugins-kiro/agent/acp/transport';
import { isDeepStrictEqual } from 'node:util';
import { markAccountChanged } from '@/app/changes/markAccountChanged';
import { acquireAccountEncryptionTransitionFenceInTx } from '@/app/encryption/accountEncryptionTransition';
import { openPlainAccountSettingsDbValue, PlainAccountSettingsStorageUnavailableError } from '@/app/encryption/accountSettingsStorage';
import type { TeamOperationAuthenticationContext } from '@/app/teams/actorContext';
import { inTx, type Tx } from '@/storage/inTx';
import { mutateReservedAccountScopedKvRowInTx, readReservedAccountScopedKvRowInTx,
    type ReservedAccountScopedKvRowDomain } from '@/app/kv/reservedAccountScopedKvRow';

/** Reads retain the original inventory; only current, complete records are new writes. */
export const configuredAgentCatalogRowDomain: ReservedAccountScopedKvRowDomain<StoredAcpCatalogContentV1> = {
    label: 'Configured ACP catalog',
    parseStoredEnvelope(value) {
        const parsed = StoredAcpCatalogContentV1Schema.safeParse(value);
        return parsed.success ? parsed.data : null;
    },
    parseCandidateEnvelope(value) {
        const parsed = AcpCatalogContentV1Schema.safeParse(value);
        return parsed.success ? parsed.data : null;
    },
    assertEnvelopeForMode: assertAcpCatalogContentForModeV1,
};

export function markConfiguredAgentCatalogRowChangedInTx(tx: Tx, input: Readonly<{ accountId: string; revision: number }>): Promise<number> {
    return markAccountChanged(tx, { accountId: input.accountId, kind: 'account', entityId: ACP_CATALOG_ACCOUNT_ROW_KEY_V1,
        hint: { acpCatalog: true, revision: input.revision } });
}

export async function readConfiguredAgentCatalogRowInTx(tx: Tx, input: Readonly<{ accountId: string }>): Promise<ReturnType<typeof AcpCatalogRowReadResponseV1Schema.parse>> {
    const result = await readReservedAccountScopedKvRowInTx(tx, { ...input,
        physicalKey: ACP_CATALOG_ACCOUNT_ROW_KEY_V1, domain: configuredAgentCatalogRowDomain });
    return result.status === 'present' ? { status: 'present', revision: result.revision, content: result.envelope } : result;
}

type MutationInput = Readonly<{ accountId: string; authentication?: TeamOperationAuthenticationContext }>
    & Omit<AcpCatalogRowMutationV1, 'referencedSavedSecretIds' | 'savedSecretRevisions'>
    & Readonly<{ referencedSavedSecretIds?: readonly string[];
        savedSecretRevisions?: readonly Readonly<{ resourceId: string; expectedRevision: number }>[] }>;
type MutationResult = ReturnType<typeof AcpCatalogRowMutationResponseV1Schema.parse>;
type PreparedMutationResult = Exclude<MutationResult, { status: 'updated' }>
    | Readonly<{ status: 'updated'; revision: number; cursor: number; settingsCleanup?: AccountSettingsCleanupV1 }>;

export class ConfiguredAgentCatalogTransactionAbort extends Error {
    constructor(readonly result: Exclude<MutationResult, { status: 'updated' }>) { super(result.status); }
}

/** Source admission and resource-use captures share the canonical row's fenced transaction. */
async function applyConfiguredAgentCatalogMutationInTx(tx: Tx, input: MutationInput,
    savedSecretRefs?: ReadonlyMap<string, string>): Promise<PreparedMutationResult> {
    const mutation = AcpCatalogRowMutationV1Schema.parse({ expectedRevision: input.expectedRevision, content: input.content,
        source: input.source, sourceSettingsVersion: input.sourceSettingsVersion,
        settingsCleanup: input.settingsCleanup,
        referencedSavedSecretIds: input.referencedSavedSecretIds, savedSecretRevisions: input.savedSecretRevisions });
    const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, input.accountId);
    if (fence.status === 'account_not_found') return { status: 'account-not-found' };
    if (fence.status === 'account_inconsistent') return { status: 'account-inconsistent', reason: fence.reason };
    try { assertAcpCatalogContentForModeV1(mutation.content, fence.account.currentness.encryptionMode); }
    catch { return { status: 'account-mode-mismatch' }; }
    const current = await readConfiguredAgentCatalogRowInTx(tx, { accountId: input.accountId });
    if (current.status !== 'present' && current.status !== 'absent' && current.status !== 'deleted') return current;
    const currentRevision = current.status === 'absent' ? 'absent' : current.revision;
    if (currentRevision !== mutation.expectedRevision) return { status: 'conflict', revision: currentRevision === 'absent' ? -1 : currentRevision };
    if (current.status === 'present' && (listAcpCatalogEnvelopeSavedSecretDiagnosticsV1(current.content).length > 0
        || current.content.t === 'plain'
        && openAcpCatalogContentV1({ mode: 'plain', material: null, content: current.content }).status !== 'opened')) {
        return { status: 'invalid-stored-content' };
    }
    if (mutation.expectedRevision === 'absent') {
        if (fence.account.settingsVersion !== mutation.sourceSettingsVersion) {
            return { status: 'settings-conflict', revision: fence.account.settingsVersion };
        }
        if (mutation.settingsCleanup?.nextSettings
            && mutation.settingsCleanup.nextSettings.t !== (fence.account.currentness.encryptionMode === 'plain' ? 'plain' : 'encrypted')) {
            return { status: 'account-mode-mismatch' };
        }
        if (fence.account.currentness.encryptionMode === 'plain') {
            try {
                const source = openPlainAccountSettingsDbValue({ accountId: input.accountId, dbValue: fence.account.settings });
                const raw = source?.t === 'plain' ? source.v : {};
                if (mutation.source === 'fresh') {
                    if (!isFreshAcpCatalogSourceV1(raw)) return { status: 'source-transfer-required' };
                } else {
                    const prepared = prepareAcpCatalogTransferV2({ rawSettings: raw, sourceSettingsVersion: fence.account.settingsVersion,
                        savedSecretRefs, kiroStderrRules: KIRO_ACP_STDERR_RULES });
                    if (prepared.status !== 'ready' || mutation.content.t !== 'plain'
                        || !isDeepStrictEqual(prepared.record, mutation.content.v)) return { status: 'source-transfer-required' };
                }
                if (Object.hasOwn(raw, 'acpCatalogSettingsV1')) {
                    const remaining = { ...raw };
                    delete remaining.acpCatalogSettingsV1;
                    if (!mutation.settingsCleanup || !isDeepStrictEqual(mutation.settingsCleanup.nextSettings, { t: 'plain', v: remaining })) {
                        return { status: 'source-transfer-required' };
                    }
                } else if (mutation.settingsCleanup) return { status: 'source-transfer-required' };
            } catch (error) {
                if (error instanceof PlainAccountSettingsStorageUnavailableError) return { status: 'invalid-stored-content' };
                throw error;
            }
        }
        // E2EE stays opaque: source capture and sealed cleanup are the authorized client's declarations at this exact version.
    }
    const references = mutation.content.t === 'plain'
        ? [...new Set(listAcpCatalogSavedSecretRefsV1(mutation.content.v).map(reference => reference.secretId))]
        : mutation.referencedSavedSecretIds;
    if (mutation.content.t === 'plain' && !isDeepStrictEqual([...references].sort(), [...new Set(mutation.referencedSavedSecretIds)].sort())) {
        return { status: 'invalid-reference' };
    }
    const { validateSavedSecretResourceReferencesInTx } = await import('@/app/account/savedSecrets/savedSecretResourceService');
    if (!(await validateSavedSecretResourceReferencesInTx(tx, { accountId: input.accountId, authentication: input.authentication,
        references, savedSecretRevisions: mutation.savedSecretRevisions ?? [] }))) return { status: 'invalid-reference' };
    const result = await mutateReservedAccountScopedKvRowInTx(tx, { accountId: input.accountId, physicalKey: ACP_CATALOG_ACCOUNT_ROW_KEY_V1,
        expectedRevision: mutation.expectedRevision, envelope: mutation.content, domain: configuredAgentCatalogRowDomain,
        markChanged: ({ tx: changeTx, revision }) => markConfiguredAgentCatalogRowChangedInTx(changeTx, { accountId: input.accountId, revision }) });
    return result.status === 'updated' ? { ...result, ...(mutation.settingsCleanup ? { settingsCleanup: mutation.settingsCleanup } : {}) } : result;
}

/** S2 consumes the same source admission/CAS, then composes this projection into its one outer Settings write. */
export async function transferConfiguredAgentCatalogSourceInTx(tx: Tx, input: Readonly<{
    accountId: string; authentication?: TeamOperationAuthenticationContext;
    mutation: AcpCatalogRowMutationV1 & Readonly<{ expectedRevision: 'absent'; source: 'fresh' | 'predecessor'; sourceSettingsVersion: number }>;
    /** Proven incumbent promotion identities, never a client-supplied mapping. */
    savedSecretRefs?: ReadonlyMap<string, string>;
}>): Promise<PreparedMutationResult> {
    if (input.mutation.expectedRevision !== 'absent') throw new Error('ACP source transfer requires initial authority');
    return applyConfiguredAgentCatalogMutationInTx(tx, { accountId: input.accountId, authentication: input.authentication, ...input.mutation }, input.savedSecretRefs);
}

/** The ordinary row owner commits captured source cleanup in the caller's rollback boundary. */
export async function mutateConfiguredAgentCatalogRowInTx(tx: Tx, input: MutationInput): Promise<MutationResult> {
    const result = await applyConfiguredAgentCatalogMutationInTx(tx, input);
    if (result.status !== 'updated') return result;
    if (result.settingsCleanup) {
        const { writeAccountSettingsInTx } = await import('@/app/accountSettings/writeAccountSettingsInTx');
        const settings = await writeAccountSettingsInTx({ tx, accountId: input.accountId,
            expectedVersion: result.settingsCleanup.expectedSettingsVersion, next: { kind: 'v2', content: result.settingsCleanup.nextSettings } }).catch(error => {
                if (error instanceof PlainAccountSettingsStorageUnavailableError) throw new ConfiguredAgentCatalogTransactionAbort({ status: 'invalid-stored-content' });
                throw error;
            });
        if (settings.status !== 'success') throw new ConfiguredAgentCatalogTransactionAbort(settings.status === 'version_mismatch'
            ? { status: 'settings-conflict', revision: settings.currentVersion } : { status: 'invalid-stored-content' });
    }
    return { status: 'updated', revision: result.revision, cursor: result.cursor };
}

export async function mutateConfiguredAgentCatalogRow(input: MutationInput): Promise<MutationResult> {
    try { return await inTx(tx => mutateConfiguredAgentCatalogRowInTx(tx, input)); }
    catch (error) { if (error instanceof ConfiguredAgentCatalogTransactionAbort) return error.result; throw error; }
}
