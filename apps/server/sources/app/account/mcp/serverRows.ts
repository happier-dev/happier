import {
    MCP_SERVER_CATALOG_ACCOUNT_KEY_V1, McpServerCatalogContentV1Schema, StoredMcpServerCatalogContentV1Schema,
    McpServerCatalogRowMutationV1Schema, listMcpServerCatalogSavedSecretRefsV1,
    parseMcpServerCatalogMigrationContentV1,
    assertMcpServerCatalogContentForModeV1, type StoredMcpServerCatalogContentV1,
    type McpServerCatalogContentV1, type McpServerCatalogRowMutationResponseV1,
} from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { isDeepStrictEqual } from 'node:util';
import { markAccountChanged } from '@/app/changes/markAccountChanged';
import { acquireAccountEncryptionTransitionFenceInTx } from '@/app/encryption/accountEncryptionTransition';
import type { TeamOperationAuthenticationContext } from '@/app/teams/actorContext';
import type { Tx } from '@/storage/inTx';
import { mutateReservedAccountScopedKvRowInTx, readReservedAccountScopedKvRowInTx, type ReservedAccountScopedKvRowDomain } from '@/app/kv/reservedAccountScopedKvRow';

export const mcpServerCatalogRowDomain: ReservedAccountScopedKvRowDomain<StoredMcpServerCatalogContentV1> = {
    label: 'MCP server catalog',
    parseStoredEnvelope(value) {
        const parsed = StoredMcpServerCatalogContentV1Schema.safeParse(value);
        return parsed.success ? parsed.data : null;
    },
    parseCandidateEnvelope(value) {
        const parsed = McpServerCatalogContentV1Schema.safeParse(value);
        return parsed.success ? parsed.data : null;
    },
    assertEnvelopeForMode: assertMcpServerCatalogContentForModeV1,
};

export function markMcpServerCatalogRowChangedInTx(tx: Tx, input: Readonly<{ accountId: string; revision: number }>): Promise<number> {
    return markAccountChanged(tx, { accountId: input.accountId, kind: 'account', entityId: MCP_SERVER_CATALOG_ACCOUNT_KEY_V1,
        hint: { mcpServerCatalog: true, revision: input.revision } });
}

/** Stored contents remain intact until the authorized domain opener diagnoses every entry. */
export async function readMcpServerCatalogRowInTx(tx: Tx, input: Readonly<{ accountId: string }>) {
    const result = await readReservedAccountScopedKvRowInTx(tx, { ...input,
        physicalKey: MCP_SERVER_CATALOG_ACCOUNT_KEY_V1, domain: mcpServerCatalogRowDomain });
    return result.status === 'present'
        ? { status: 'present' as const, revision: result.revision, content: result.envelope }
        : result;
}

/** First admission captures Settings; subsequent mutations use only this row's CAS. */
export async function mutateMcpServerCatalogRowInTx(tx: Tx, input: Readonly<{
    accountId: string; expectedRevision: number | 'absent'; content: McpServerCatalogContentV1 | null;
    sourceSettingsVersion?: number; referencedSavedSecretIds?: readonly string[];
    savedSecretRevisions?: readonly Readonly<{ resourceId: string; expectedRevision: number }>[];
    authentication?: TeamOperationAuthenticationContext;
}>): Promise<McpServerCatalogRowMutationResponseV1> {
    const mutation = McpServerCatalogRowMutationV1Schema.parse({
        expectedRevision: input.expectedRevision, content: input.content,
        sourceSettingsVersion: input.sourceSettingsVersion,
        referencedSavedSecretIds: input.referencedSavedSecretIds,
        savedSecretRevisions: input.savedSecretRevisions,
    });
    const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, input.accountId);
    if (fence.status === 'account_not_found') return { status: 'account-not-found' };
    if (fence.status === 'account_inconsistent') return { status: 'account-inconsistent', reason: fence.reason };
    if (mutation.content !== null) {
        try { assertMcpServerCatalogContentForModeV1(mutation.content, fence.account.currentness.encryptionMode); }
        catch { return { status: 'account-mode-mismatch' }; }
    }
    if (mutation.expectedRevision === 'absent' && fence.account.settingsVersion !== mutation.sourceSettingsVersion) {
        return { status: 'settings-conflict', revision: fence.account.settingsVersion };
    }
    const current = await readMcpServerCatalogRowInTx(tx, { accountId: input.accountId });
    if (current.status === 'present' && !parseMcpServerCatalogMigrationContentV1(current.content)) {
        return { status: 'invalid-stored-content' };
    }
    if (current.status !== 'present' && current.status !== 'absent' && current.status !== 'deleted') return current;
    const references = mutation.content?.t === 'plain'
        ? [...new Set(listMcpServerCatalogSavedSecretRefsV1(mutation.content.v).map(reference => reference.secretId))]
        : mutation.referencedSavedSecretIds;
    if (mutation.content?.t === 'plain' && !isDeepStrictEqual([...references].sort(), [...new Set(mutation.referencedSavedSecretIds)].sort())) {
        return { status: 'invalid-reference' };
    }
    if (!(await (await import('@/app/account/savedSecrets/savedSecretResourceService')).validateSavedSecretResourceReferencesInTx(tx, {
        accountId: input.accountId, authentication: input.authentication, references,
        savedSecretRevisions: mutation.savedSecretRevisions,
    }))) return { status: 'invalid-reference' };
    return mutateReservedAccountScopedKvRowInTx(tx, { accountId: input.accountId,
        physicalKey: MCP_SERVER_CATALOG_ACCOUNT_KEY_V1, expectedRevision: mutation.expectedRevision,
        envelope: mutation.content, domain: mcpServerCatalogRowDomain,
        markChanged: ({ tx: changeTx, revision }) => markMcpServerCatalogRowChangedInTx(changeTx, { accountId: input.accountId, revision }),
    });
}
