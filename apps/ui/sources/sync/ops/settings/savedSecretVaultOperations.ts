import { PERSONAL_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1, PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1,
    SavedSecretVaultInvocationV1Schema, createSavedSecretVaultLinkDraftV1, type SavedSecretVaultQueryV1, type SavedSecretVaultTargetV1 } from '@happier-dev/protocol/account/settings/personalSavedSecretActionsV1';
import { PluginSecretSourceListResultV1Schema, PluginSecretSourceStoreResultV1Schema, PluginSecretSourceFailureV1Schema } from '@happier-dev/protocol/plugins/contributions/public-types';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { admitSavedSecretExternalSourceAudienceV1 } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { readRpcRequestDisposition } from '@happier-dev/sync-client';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { withActionAccountRequestSignal, type LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { readSavedSecretContentsInContext } from '@/sync/api/account/apiSavedSecretCatalog';
import { randomUUID } from '@/platform/randomUUID';
import { createSavedSecretResourcesWithCatalogMutationInContext, updateSavedSecretResourceInContext,
    type SavedSecretAdmittedMutationExecute } from './savedSecretResourceOperations';

type VaultInvocation = ReturnType<typeof SavedSecretVaultInvocationV1Schema.parse>;
type ExportInput = ReturnType<typeof PERSONAL_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1['secrets.export']['parse']>;
type ExportOutput = ReturnType<typeof PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1['secrets.export']['parse']>;

function refuseSavedSecretVaultOperation(code: string, repair?: string): never {
    throw Object.assign(new Error(code), { code, ...(repair ? { details: { repair } } : {}) });
}

/** The private native boundary shares the invoking Action's Account and lifetime. */
async function invokeVaultInContext(account: LazyActionAccountContext, machineId: string | undefined,
    operand: Omit<Extract<VaultInvocation, { operation: 'list' }>, 'accountEncryptionMode'>
        | Omit<Extract<VaultInvocation, { operation: 'store' }>, 'accountEncryptionMode'>,
    signal?: AbortSignal): Promise<unknown> {
    if (!machineId) refuseSavedSecretVaultOperation('target_unavailable');
    let dispatched = false;
    return withActionAccountRequestSignal(account, signal, async operationSignal => {
        operationSignal?.throwIfAborted();
        const { accountMode } = await account.resolveAccountEncryption();
        account.assertCurrent();
        const payload = SavedSecretVaultInvocationV1Schema.parse({ ...operand, accountEncryptionMode: accountMode });
        try {
            return await machineRpcWithServerScope<unknown, VaultInvocation>({
                machineId, serverId: account.serverId, accountId: account.accountId,
                method: RPC_METHODS.DAEMON_SECRET_SOURCE_INVOKE, payload,
                signal: operationSignal, operationTimeoutMs: null,
                onDispatched: () => { dispatched = true; },
                ...(accountMode === 'e2ee' ? { requireEncryptedPayload: true as const } : {}),
            });
        } catch (error) {
            if (operand.operation === 'store' && (dispatched || readRpcRequestDisposition(error) === 'outcomeUnknown')) {
                refuseSavedSecretVaultOperation('outcome_unknown');
            }
            refuseSavedSecretVaultOperation(operationSignal?.aborted ? 'cancelled' : 'target_unavailable');
        }
    });
}

export async function listSavedSecretVaultFieldsInContext(account: LazyActionAccountContext,
    query: SavedSecretVaultQueryV1, signal?: AbortSignal) {
    const { machineId, ...source } = query;
    const raw = await invokeVaultInContext(account, machineId, { operation: 'list', source }, signal);
    const parsed = PluginSecretSourceListResultV1Schema.safeParse(raw);
    if (!parsed.success) refuseSavedSecretVaultOperation('source_unavailable');
    if (!parsed.data.ok) refuseSavedSecretVaultOperation(parsed.data.code, 'repair' in parsed.data ? parsed.data.repair : undefined);
    return { fields: parsed.data.fields, ...(parsed.data.vaults ? { vaults: parsed.data.vaults } : {}) };
}

export async function storeSavedSecretValueInVaultInContext(account: LazyActionAccountContext,
    targetWithMachine: SavedSecretVaultTargetV1, title: string, value: string, signal?: AbortSignal) {
    const { machineId, ...target } = targetWithMachine;
    const raw = await invokeVaultInContext(account, machineId, { operation: 'store', target, title, value }, signal);
    const parsed = PluginSecretSourceStoreResultV1Schema.safeParse(raw);
    if (!parsed.success) refuseSavedSecretVaultOperation('outcome_unknown');
    if (!parsed.data.ok) refuseSavedSecretVaultOperation(parsed.data.code, 'repair' in parsed.data ? parsed.data.repair : undefined);
    return { kind: 'external' as const, contribution: target.contribution, account: parsed.data.account, reference: parsed.data.reference };
}

/** One metadata enumeration and one resource-owner transaction, with no native value read. */
export async function linkSavedSecretVaultItemsInContext(account: LazyActionAccountContext,
    input: ReturnType<typeof PERSONAL_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1['secrets.link']['parse']>,
    executeAdmittedMutation?: SavedSecretAdmittedMutationExecute, signal?: AbortSignal) {
    const { fields } = await listSavedSecretVaultFieldsInContext(account, input.source, signal);
    const selected = input.itemIds === undefined ? null : new Set(input.itemIds);
    const resources = fields.filter(field => !selected || selected.has(field.item.id)).map(field => ({
        id: randomUUID(), ...createSavedSecretVaultLinkDraftV1(input.source.contribution, field),
    }));
    if (!resources.length) return { secrets: [] };
    const result = await createSavedSecretResourcesWithCatalogMutationInContext(account, {
        scope: { serverId: account.serverId, accountId: account.accountId }, referenceScope: 'resources', resources,
        ...(executeAdmittedMutation ? { executeAdmittedMutation } : {}),
    });
    if (!result.ok) refuseSavedSecretVaultOperation(result.reason === 'changed' ? 'revision_conflict' : result.reason);
    return { secrets: resources.map(resource => ({ secretId: resource.id, secretRef: result.resourceRefs.get(resource.id)! })) };
}

/** A failed store never edits the inline original; a settled conversion retains its identity and references. */
export async function exportSavedSecretsToVaultInContext(account: LazyActionAccountContext, input: ExportInput,
    executeAdmittedMutation?: SavedSecretAdmittedMutationExecute, signal?: AbortSignal): Promise<ExportOutput> {
    const results: ExportOutput['results'] = [];
    for (const selected of input.secrets) {
        const identity = { secretId: selected.secretId, secretRef: formatSharedSavedSecretRefV1(selected.secretId) };
        try {
            signal?.throwIfAborted();
            const opened = await readSavedSecretContentsInContext(account, [identity.secretRef], signal,
                { expectedRevision: selected.expectedUpdatedAt, requireManage: true });
            signal?.throwIfAborted();
            if (!opened.ok) refuseSavedSecretVaultOperation(opened.reason === 'changed' ? 'revision_conflict' : 'secret_unavailable');
            const resource = opened.contents.get(identity.secretRef)!;
            if (resource.entry.relationship !== 'owner') refuseSavedSecretVaultOperation('not_found');
            const audience = admitSavedSecretExternalSourceAudienceV1(resource.entry.audience && {
                ...resource.entry.audience, accounts: resource.entry.audience.accounts.map(recipient => recipient.accountId),
            }, account.accountId);
            if (audience !== 'allowed') refuseSavedSecretVaultOperation(audience === 'audience_unavailable' ? 'secret_unavailable' : audience);
            if (resource.content.v !== 1) refuseSavedSecretVaultOperation('unsupported_source');
            const source = await storeSavedSecretValueInVaultInContext(account, input.target, resource.content.name, resource.content.value, signal);
            const converted = await updateSavedSecretResourceInContext(account, { resourceId: selected.secretId,
                expectedRevision: selected.expectedUpdatedAt, nextSource: source,
                ...(executeAdmittedMutation ? { executeAdmittedMutation } : {}) });
            if (!converted.ok) refuseSavedSecretVaultOperation(converted.reason === 'changed' ? 'revision_conflict' : converted.reason);
            results.push({ ...identity, status: 'exported', updatedAt: selected.expectedUpdatedAt + 1 });
        } catch (error) {
            const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code
                : signal?.aborted ? 'cancelled' : 'source_unavailable';
            const repair = PluginSecretSourceFailureV1Schema.shape.repair.safeParse(error instanceof Error && 'details' in error && error.details !== null && typeof error.details === 'object'
                && 'repair' in error.details ? error.details.repair : undefined);
            results.push({ ...identity, status: 'failed', code,
                ...(repair.success && repair.data ? { repair: repair.data } : {}) });
        }
    }
    return { results };
}
