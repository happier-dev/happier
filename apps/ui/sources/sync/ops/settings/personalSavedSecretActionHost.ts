import { createPersonalSavedSecretActionExecuteV1 } from '@happier-dev/protocol/account/settings/personalSavedSecretActionsV1';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { readSavedSecretCatalogMetadataInContext, readSavedSecretContentsInContext } from '@/sync/api/account/apiSavedSecretCatalog';
import { homeDomainFailureFromActionFailure } from '@/sync/api/home/homeDomainActions';
import { createSavedSecretResource, updateSavedSecretResource, deleteSavedSecretResource,
    type SavedSecretAdmittedMutationExecute } from './savedSecretResourceOperations';
import { parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { readProfileTransferSourceInContext } from '@/sync/api/account/apiProfileCatalog';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { listSavedSecretVaultFieldsInContext, linkSavedSecretVaultItemsInContext, exportSavedSecretsToVaultInContext,
    storeSavedSecretValueInVaultInContext } from './savedSecretVaultOperations';
import { readPluginAccountAvailability } from '@/sync/domains/plugins/availability/projection';
import { installedSecretSourceDeclarations, listSavedSecretSources } from '@/sync/api/account/savedSecretCatalogPresentation';

function refusal(reason: string, details?: unknown): never {
    throw Object.assign(new Error(reason === 'changed' ? 'revision_conflict' : reason), {
        code: reason === 'changed' ? 'revision_conflict' : reason, ...(details === undefined ? {} : { details }),
    });
}
/** Captured Account resources remain the sole personal secret storage authority. */
export function createUiPersonalSavedSecretActionExecute(account: LazyActionAccountContext,
    home: NonNullable<ActionExecutorDeps['homeDomainAction']>): NonNullable<ActionExecutorDeps['personalSavedSecretActionExecute']> {
    return async ({ actionId, input, context }) => {
        const scope = { serverId: account.serverId, accountId: account.accountId };
        const executeAdmittedMutation: SavedSecretAdmittedMutationExecute = async mutation => {
            account.assertCurrent(); context.signal?.throwIfAborted();
            if(mutation.actionId!=='secrets.shared.create'&&mutation.actionId!=='secrets.shared.update'&&mutation.actionId!=='secrets.shared.delete'&&mutation.actionId!=='secrets.shared.promote')refusal('unsupported_action');
            const output = await home({ actionId: mutation.actionId, input: mutation.input, context, signal: context.signal });
            const failed=ActionExecuteFailureSchema.safeParse(output);
            if (failed.success) {
                return { kind: 'failed', failure: homeDomainFailureFromActionFailure(failed.data) };
            }
            return { kind: 'succeeded', value: mutation.parse(output) };
        };
        const read = async () => {
            const catalog = await readSavedSecretCatalogMetadataInContext(account, context.signal);
            account.assertCurrent();
            if (!catalog.ok) refusal(catalog.failure.code ?? 'unavailable');
            return catalog.resources.filter((entry): entry is Extract<typeof entry, { ref: string }> =>
                'ref' in entry && entry.relationship === 'owner');
        };
        const execute = createPersonalSavedSecretActionExecuteV1({
            list: async () => {
                const secrets = [];
                for (const entry of await read()) {
                    const ref = parseSavedSecretRefV1(entry.ref);
                    if (ref.kind !== 'shared_resource' || !entry.name || !entry.kind || entry.revision === null) continue;
                    const opened = entry.storage?.kind === 'external'
                        ? await readSavedSecretContentsInContext(account, [entry.ref], context.signal, { expectedRevision: entry.revision }) : null;
                    const content = opened?.ok ? opened.contents.get(entry.ref)?.content : undefined;
                    secrets.push({ secretId: ref.resourceId, name: entry.name, kind: entry.kind, revision: entry.revision,
                        ...(content?.v === 2 && content.source.kind === 'external' ? { source: content.source } : {}) });
                }
                return secrets;
            },
            sources: () => listSavedSecretSources(installedSecretSourceDeclarations(readPluginAccountAvailability(scope).readInstalledPlugins()))
                .map(({ contribution, title, capabilities }) => ({ contribution, title,
                    ...(capabilities ? { capabilities } : {}) })),
            browse: query => listSavedSecretVaultFieldsInContext(account, query, context.signal),
            link: args => linkSavedSecretVaultItemsInContext(account, args, executeAdmittedMutation, context.signal),
            export: args => exportSavedSecretsToVaultInContext(account, args, executeAdmittedMutation, context.signal),
            create: async args => {
                const source = args.storeIn && args.value !== undefined
                    ? await storeSavedSecretValueInVaultInContext(account, args.storeIn, args.name, args.value, context.signal) : args.source;
                const result = await createSavedSecretResource({ scope, name: args.name, kind: source?.kind === 'passkey' ? 'other' : args.kind ?? 'apiKey',
                    ...(source ? { source } : { value: args.value }), signal: context.signal,
                    accountGrants: [], teamGrants: [], groupGrants: [], executeAdmittedMutation });
                if (!result.ok) refusal(result.reason);
                const ref = parseSavedSecretRefV1(result.resourceRef);
                if (ref.kind !== 'shared_resource') refusal('invalid_resource_reference');
                return { secretId: ref.resourceId, secretRef: result.resourceRef };
            },
            update: async args => {
                const resource = (await read()).find(resource => {
                    const ref = parseSavedSecretRefV1(resource.ref);
                    return ref.kind === 'shared_resource' && ref.resourceId === args.secretId;
                });
                if (!resource) refusal('not_found');
                if (resource.revision !== args.expectedUpdatedAt) refusal('changed');
                const result = await updateSavedSecretResource({ scope, resourceId: args.secretId, expectedRevision: args.expectedUpdatedAt,
                    ...(args.name === undefined ? {} : { nextName: args.name }), ...(args.value === undefined ? {} : { nextValue: args.value }),
                    ...(args.source === undefined ? {} : { nextSource: args.source }), executeAdmittedMutation,
                    decryptDataKeyEnvelope: async encryptedDataKey => {
                        const { encryption } = await account.resolveAccountEncryption(); account.assertCurrent();
                        return encryption ? encryption.decryptEncryptionKey(encryptedDataKey, scope) : null;
                    } });
                if (!result.ok) refusal(result.reason);
                return { revision: args.expectedUpdatedAt + 1 };
            },
            delete: async args => {
                const baseline = await readProfileTransferSourceInContext(account);
                const result = await deleteSavedSecretResource({ scope, resourceId: args.secretId, expectedRevision: args.expectedUpdatedAt,
                    expectedSettingsVersion: baseline.source.version, executeAdmittedMutation });
                if (!result.ok) refusal(result.reason, 'references' in result ? { references: result.references } : undefined);
            },
        });
        return execute(actionId, input);
    };
}
