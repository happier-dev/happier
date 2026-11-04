import { randomUUID } from 'node:crypto';
import { createPersonalSavedSecretActionExecuteV1, createSavedSecretVaultLinkDraftV1, type PersonalSavedSecretActionPortV1, type SavedSecretVaultQueryV1, type SavedSecretVaultTargetV1 } from '@happier-dev/protocol/account/settings/personalSavedSecretActionsV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { prepareSavedSecretResourceUpdateContentV1, sealSavedSecretResourceStoredContentV1, type SavedSecretExternalSourceV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { SharedSavedSecretMutationOutputV1Schema, SharedSavedSecretDeleteOutputV1Schema, SharedSavedSecretUpdateInputV1Schema, SharedSavedSecretPromoteOutputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { admitSavedSecretExternalSourceAudienceV1, admitSavedSecretResourceAudienceV1, listAccountSettingsSavedSecretReferences } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { PluginSecretSourceStoreResultV1Schema, type PluginSecretSourceListResultV1, type PluginSecretSourceStoreResultV1 } from '@happier-dev/protocol/plugins/contributions/public-types';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import type { StoredCredentials } from '@/persistence';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { fetchAccountProfile } from '@/api/accountProfile';
import axios from '@/api/client/credentialAxios';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { CONNECTED_PRESENTATION_ROWS_ROUTE_V1, ConnectedPresentationRowReadResponseV1Schema,
    openConnectedPresentationContentV1, projectConnectedPresentationLabelsV1 } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import { humanizeConnectedServiceIdentity, resolveConnectedAccountPrimaryNameV1,
    resolveQualifiedConnectedAccountLabel } from '@happier-dev/protocol/connect/connectedServiceProfilePreferences';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { resolveCliAccountStorageContext } from '@/api/client/accountKvJsonTransport';
import { runWithServerHttpBaseUrl, resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { getRandomBytes } from '@/api/encryption';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { assertSavedSecretNativeSourceAccessForOperation, readSavedSecretCatalogForOperation, SavedSecretOperationAdmissionError } from "@/settings/secrets/savedSecretCatalogRead";
import { type SavedSecretOperationContextV1 } from "@/settings/secrets/savedSecretOperationContext";
import { createSavedSecretMaterializerFromSnapshotV1, type SavedSecretCatalogResourceInputV1, type SavedSecretMaterializerV1 } from './savedSecretCatalog';

type SharedSavedSecretUpdateInputV1 = ReturnType<typeof SharedSavedSecretUpdateInputV1Schema.parse>;

function refusal(code: string, details?: unknown): never {
    throw Object.assign(new Error(code), { code, ...(details === undefined ? {} : { details }) });
}
type CliOwnedSavedSecretOperationParams = Readonly<{
    credentials: StoredCredentials; operationContext?: SavedSecretOperationContextV1; serverHttpBaseUrl?: string;
    isCredentialCurrent?: () => boolean | Promise<boolean>;
}>;
type OwnedSavedSecretOperation = Readonly<{
    accountId: string;
    scopeKey: string;
    assertCurrent(): Promise<void>;
    read(): Promise<readonly SavedSecretCatalogResourceInputV1[]>;
    findOwned(secretId: string, expected?: number): Promise<SavedSecretCatalogResourceInputV1>;
    materializer(): SavedSecretMaterializerV1;
}>;
function assertMutationSucceeded(result: unknown): unknown {
    const failed = ActionExecuteFailureSchema.safeParse(result);
    if (failed.success) refusal(failed.data.errorCode, failed.data.details);
    return result;
}
async function withOwnedSavedSecretOperation<T>(params: CliOwnedSavedSecretOperationParams, signal: AbortSignal | undefined,
    operation: (owner: OwnedSavedSecretOperation) => Promise<T>): Promise<T> {
    return runWithServerHttpBaseUrl(params.operationContext?.serverHttpBaseUrl ?? params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(), async () => {
        const accountId = readAccountIdFromToken(params.credentials.token);
        if (!accountId) refusal('not_authenticated');
        const scopeKey = resolveAccountSettingsScopeKeyForToken(params.credentials.token);
        if (!params.operationContext && getActiveAccountSettingsSnapshot()?.scopeKey !== scopeKey) {
            await bootstrapAccountSettingsContext({ credentials: params.credentials, mode: 'blocking' });
        }
        const lifetime = getActiveAccountSettingsSnapshotLifetimeToken();
        const assertCurrent = async () => {
            signal?.throwIfAborted();
            if (params.operationContext ? !await params.operationContext.isCurrent()
                : getActiveAccountSettingsSnapshotLifetimeToken() !== lifetime || getActiveAccountSettingsSnapshot()?.scopeKey !== scopeKey) refusal('account_changed');
            if (params.isCredentialCurrent && !await params.isCredentialCurrent()) refusal('account_changed');
        };
        const read = async () => {
            await assertCurrent();
            const snapshot = await readSavedSecretCatalogForOperation({ expectedScopeKey: scopeKey, refreshCatalog: true,
                operationContext: params.operationContext, signal });
            await assertCurrent();
            return snapshot.savedSecretResources ?? [];
        };
        const findOwned = async (secretId: string, expected?: number) => {
            const resource = (await read()).find(resource => resource.resourceId === secretId);
            if (!resource || resource.ownerAccountId !== accountId || resource.relationship === 'recipient') refusal('not_found');
            if (expected !== undefined && resource.revision !== expected) refusal('revision_conflict');
            return resource;
        };
        const materializer = () => {
            const snapshot = params.operationContext ? params.operationContext.readSnapshot() : getActiveAccountSettingsSnapshot();
            if (!snapshot) refusal('secret_unavailable');
            return createSavedSecretMaterializerFromSnapshotV1(snapshot);
        };
        return operation({ accountId, scopeKey, assertCurrent, read, findOwned, materializer });
    });
}
export type OwnedSavedSecretUpdateForOperationInput = CliOwnedSavedSecretOperationParams & Readonly<{
    resourceId: string; expectedRevision?: number; nextName?: string; nextValue?: string; nextSource?: SavedSecretExternalSourceV1; signal?: AbortSignal;
    executeMutation?(input: SharedSavedSecretUpdateInputV1): Promise<unknown>;
}>;
async function updateOwnedSavedSecretResource(owner: OwnedSavedSecretOperation, input: OwnedSavedSecretUpdateForOperationInput & Readonly<{
    executeMutation: NonNullable<OwnedSavedSecretUpdateForOperationInput['executeMutation']>;
}>) {
    const { accountId, scopeKey, assertCurrent, findOwned } = owner;
    const resource = await findOwned(input.resourceId, input.expectedRevision);
    const storage = await resolveCliAccountStorageContext({ credentials: input.credentials, signal: input.signal });
    const prepared = prepareSavedSecretResourceUpdateContentV1({ resourceId: resource.resourceId,
        resourceMode: resource.encryptionMode, accountMode: storage.mode, storedContent: resource.storedContent,
        resourceDataKey: resource.resourceDataKey, nextName: input.nextName, nextValue: input.nextValue, nextSource: input.nextSource });
    if (!prepared) refusal('secret_unavailable');
    const { content, mode: nextMode } = prepared;
    const audience = admitSavedSecretResourceAudienceV1(content, resource.audience && {
        ...resource.audience, accounts: resource.audience.accounts.map(account => account.accountId),
    }, accountId);
    if (audience === 'audience_unavailable') refusal('secret_unavailable');
    if (audience === 'recipient_mode_unsupported') refusal('recipient_mode_unsupported');
    const convertingToE2ee = nextMode === 'e2ee' && resource.encryptionMode === 'plain';
    const conversion = convertingToE2ee
        ? (await import('./hydrateSavedSecretCatalog')).prepareSavedSecretResourceCreateForOperation({
            credentials: input.credentials, accountId, accountMode: nextMode, resourceId: resource.resourceId,
            displayName: content.name, kind: content.kind, content,
        }) : null;
    const storedContent = conversion?.storedContent ?? (nextMode === 'plain'
        ? sealSavedSecretResourceStoredContentV1({ resourceId: resource.resourceId, mode: 'plain', content })
        : sealSavedSecretResourceStoredContentV1({ resourceId: resource.resourceId, mode: 'e2ee', content,
            resourceDataKey: resource.resourceDataKey!, randomBytes: getRandomBytes }));
    await assertCurrent();
    const receipt = SharedSavedSecretMutationOutputV1Schema.parse(assertMutationSucceeded(await input.executeMutation({
        resourceId: input.resourceId, expectedRevision: resource.revision, displayName: content.name, kind: content.kind, storedContent,
        ...(prepared.toMode === undefined ? {} : { toMode: prepared.toMode }),
        ...(conversion ? { keyEnvelopes: conversion.keyEnvelopes } : {}),
    })));
    if (convertingToE2ee) {
        const { repairSavedSecretResourceEnvelopesForOperation } = await import('./repairSavedSecretResourceEnvelopes');
        await repairSavedSecretResourceEnvelopesForOperation({ credentials: input.credentials, expectedScopeKey: scopeKey,
            resourceId: receipt.resourceId, expectedRevision: receipt.revision,
            signal: input.signal, assertCurrent,
            ...(input.operationContext ? { operationContext: input.operationContext } : {}),
        }).catch(() => undefined);
    }
    return receipt;
}
/** The admitted native credential settler and personal Action share this one resource update owner. */
export function updateOwnedSavedSecretResourceForOperation(input: OwnedSavedSecretUpdateForOperationInput): Promise<ReturnType<typeof SharedSavedSecretMutationOutputV1Schema.parse>> {
    return withOwnedSavedSecretOperation(input, input.signal, owner => updateOwnedSavedSecretResource(owner, {
        ...input,
        executeMutation: input.executeMutation ?? (async value => {
            // This is the incumbent Home HTTP dependency, below Action admission and approval.
            const { createAccountServerActionDeps } = await import('@/api/accountServerActionDeps');
            const home = createAccountServerActionDeps({ credentials: input.credentials, token: input.credentials.token,
                isCredentialCurrent: async () => { await owner.assertCurrent(); return true; },
            }).homeDomainAction!;
            return home({ actionId: 'secrets.shared.update', input: value,
                context: { surface: 'cli', signal: input.signal }, signal: input.signal });
        }),
    }));
}

/** Plaintext lives only in the caller process; resources use the incumbent mode/sealing/census owners. */
export function createCliPersonalSavedSecretActionExecute(params: CliOwnedSavedSecretOperationParams & Readonly<{
    home: NonNullable<ActionExecutorDeps['homeDomainAction']>;
    resolveNativeSecretSourceRuntime?(contribution: PluginContributionIdentityV1, signal?: AbortSignal): Promise<Readonly<{
        secretSources?: SavedSecretOperationContextV1['secretSources'];
        dispose(): Promise<void>;
    }>>;
}>): NonNullable<ActionExecutorDeps['personalSavedSecretActionExecute']> {
    return async ({ actionId, input, context }) => withOwnedSavedSecretOperation(params, context.signal, async owner => {
        const { accountId, scopeKey, assertCurrent, read, findOwned, materializer } = owner;
        const captureReferences = async (secretId: string) => {
            const { captureSavedSecretSourcePreparationForOperation } = await import('./hydrateSavedSecretCatalog');
            const captured = await captureSavedSecretSourcePreparationForOperation({ credentials: params.credentials,
                expectedScopeKey: scopeKey, operationContext: params.operationContext, signal: context.signal });
            const profile = await fetchAccountProfile({ token: params.credentials.token, signal: context.signal });
            if (profile.id !== accountId) refusal('saved_secret_account_lifetime_changed');
            const response = await axios.get<unknown>(`${resolveServerHttpBaseUrl()}${CONNECTED_PRESENTATION_ROWS_ROUTE_V1}`, {
                headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${params.credentials.token}` },
                signal: context.signal, validateStatus: () => true,
            });
            if (response.status !== 200) refusal('secret_unavailable');
            const row = ConnectedPresentationRowReadResponseV1Schema.parse(response.data);
            let labelsByKey: Readonly<Record<string, string>> = {};
            if (row.status === 'present') {
                const opened = openConnectedPresentationContentV1({ mode: captured.source.mode,
                    material: captured.source.material, content: row.content });
                if (opened.status === 'unavailable') refusal('secret_unavailable');
                labelsByKey = projectConnectedPresentationLabelsV1(opened.record);
            } else if (row.status !== 'absent' && row.status !== 'deleted') refusal('secret_unavailable');
            await assertCurrent();
            const references = listAccountSettingsSavedSecretReferences(captured.rawSettings, formatSharedSavedSecretRefV1(secretId), {
                ...captured.referenceCatalogs,
                connectedAccountCredentials: profile.connectedAccountsV4.map(account => ({
                    account: account.ref, displayName: resolveConnectedAccountPrimaryNameV1({
                        serviceTitle: humanizeConnectedServiceIdentity(account.ref.service.localId),
                        userLabel: resolveQualifiedConnectedAccountLabel({ labelsByKey, service: account.ref.service, accountId: account.ref.accountId }),
                        displayName: account.displayName, accountId: account.ref.accountId,
                        providerAccountId: account.providerIdentity?.accountId,
                    }).name ?? undefined,
                    savedSecretResourceIds: account.savedSecretResourceIds ?? [],
                })),
            });
            return { captured, references };
        };
        let nativeRuntime: Awaited<ReturnType<NonNullable<typeof params.resolveNativeSecretSourceRuntime>>> | undefined;
        const mutate = async (id: 'secrets.shared.create' | 'secrets.shared.update' | 'secrets.shared.delete' | 'secrets.shared.promote', value: unknown) => {
            await assertCurrent();
            const result = await params.home({ actionId: id, input: value, context, signal: context.signal });
            return assertMutationSucceeded(result);
        };
        const nativeSources = async (target: SavedSecretVaultQueryV1) => {
            await assertCurrent();
            if (target.machineId) refusal('target_unavailable');
            try { assertSavedSecretNativeSourceAccessForOperation(params.operationContext?.machineAdmission); }
            catch (error) {
                if (error instanceof SavedSecretOperationAdmissionError) refusal(error.reason);
                throw error;
            }
            if (params.operationContext?.secretSources) return params.operationContext.secretSources;
            if (!nativeRuntime && params.resolveNativeSecretSourceRuntime) {
                try { nativeRuntime = await params.resolveNativeSecretSourceRuntime(target.contribution, context.signal); }
                catch (error) {
                    context.signal?.throwIfAborted();
                    if (error instanceof Error && error.name === 'AbortError') throw error;
                    refusal('target_unavailable');
                }
            }
            const sources = nativeRuntime?.secretSources;
            if (!sources) refusal('target_unavailable');
            return sources;
        };
        const nativeFailure = (failure: Extract<PluginSecretSourceListResultV1 | PluginSecretSourceStoreResultV1, { ok: false }>): never => {
            if (failure.code === 'cancelled') throw new DOMException('Aborted', 'AbortError');
            const repair = 'repair' in failure ? failure.repair : undefined;
            refusal(failure.code, { sourceFailure: { code: failure.code, ...(repair ? { repair } : {}) } });
        };
        const browse = async (query: SavedSecretVaultQueryV1) => {
            const result = await (await nativeSources(query)).listFields(query.contribution, {
                account: query.account, ...(query.vaultId ? { vaultId: query.vaultId } : {}), ...(query.itemId ? { itemId: query.itemId } : {}),
            }, { signal: context.signal });
            if (!result.ok) return nativeFailure(result);
            await assertCurrent();
            return { fields: result.fields, ...(result.vaults ? { vaults: result.vaults } : {}) };
        };
        const store = async (target: SavedSecretVaultTargetV1, title: string, value: string): Promise<SavedSecretExternalSourceV1> => {
            const result = await (await nativeSources(target)).store(target.contribution, {
                account: target.account, vaultId: target.vaultId, title, value,
            }, { signal: context.signal });
            if (!result.ok) return nativeFailure(result);
            return { kind: 'external', contribution: target.contribution, account: result.account, reference: result.reference };
        };
        const execute = createPersonalSavedSecretActionExecuteV1({
            usedBy: async secretId => (await captureReferences(secretId)).references,
            sources: () => params.operationContext?.secretSources?.list() ?? [],
            list: async () => {
                const resources = await read();
                const reader = materializer();
                return resources.flatMap(resource => {
                    if (resource.ownerAccountId !== accountId || resource.relationship === 'recipient' || !resource.displayName) return [];
                    const opened = resource.storedContent?.storage?.kind === 'external'
                        ? reader.resolveContent(formatSharedSavedSecretRefV1(resource.resourceId)) : null;
                    const source = opened?.status === 'ready' && opened.content.v === 2 && opened.content.source.kind === 'external'
                        ? opened.content.source : undefined;
                    return [{ secretId: resource.resourceId, name: resource.displayName, kind: resource.kind, revision: resource.revision,
                        ...(source ? { source } : {}) }];
                });
            },
            browse,
            link: async args => {
                const { fields } = await browse(args.source);
                const selected = args.itemIds ? new Set(args.itemIds) : null;
                const drafts = fields.filter(field => !selected || selected.has(field.item.id))
                    .map(field => createSavedSecretVaultLinkDraftV1(args.source.contribution, field));
                if (!drafts.length) return { secrets: [] };
                const storage = await resolveCliAccountStorageContext({ credentials: params.credentials, signal: context.signal });
                const { prepareSavedSecretResourceCreateForOperation } = await import('./hydrateSavedSecretCatalog');
                const resources = drafts.map(draft => prepareSavedSecretResourceCreateForOperation({ credentials: params.credentials, accountId,
                    accountMode: storage.mode, resourceId: randomUUID(), displayName: draft.name, kind: draft.kind, source: draft.source }));
                const [first, ...additionalSavedSecretResources] = resources;
                SharedSavedSecretPromoteOutputV1Schema.parse(await mutate('secrets.shared.promote', { ...first,
                    additionalSavedSecretResources, nextSettings: null, profileMutations: [],
                    referenceCensus: { scope: 'catalogs', accountMode: storage.mode, catalogs: {} } }));
                return { secrets: resources.map(resource => ({ secretId: resource.resourceId, secretRef: formatSharedSavedSecretRefV1(resource.resourceId) })) };
            },
            export: async args => {
                const results: Awaited<ReturnType<NonNullable<PersonalSavedSecretActionPortV1['export']>>>['results'] = [];
                for (const selected of args.secrets) {
                    const identity = { secretId: selected.secretId, secretRef: formatSharedSavedSecretRefV1(selected.secretId) };
                    try {
                        const resource = await findOwned(selected.secretId, selected.expectedUpdatedAt);
                        const opened = materializer().resolveContent(identity.secretRef);
                        if (opened.status !== 'ready') refusal('secret_unavailable');
                        if (opened.content.v !== 1) refusal('unsupported_source');
                        const audience = admitSavedSecretExternalSourceAudienceV1(resource.audience && {
                            ...resource.audience, accounts: resource.audience.accounts.map(account => account.accountId),
                        }, accountId);
                        if (audience === 'audience_unavailable') refusal('secret_unavailable');
                        if (audience === 'recipient_mode_unsupported') refusal('recipient_mode_unsupported');
                        const nextSource = await store(args.target, opened.content.name, opened.content.value);
                        const receipt = await updateOwnedSavedSecretResource(owner, { ...params, resourceId: resource.resourceId,
                            expectedRevision: resource.revision, nextSource, signal: context.signal,
                            executeMutation: value => mutate('secrets.shared.update', value) });
                        results.push({ ...identity, status: 'exported', updatedAt: receipt.revision });
                    } catch (error) {
                        if (error instanceof Error && error.name === 'AbortError') throw error;
                        const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'secret_unavailable';
                        const failure = error instanceof Error && 'details' in error && error.details && typeof error.details === 'object'
                            && 'sourceFailure' in error.details ? error.details.sourceFailure : null;
                        const parsedFailure = failure && typeof failure === 'object'
                            ? PluginSecretSourceStoreResultV1Schema.safeParse({ ...failure, ok: false }) : null;
                        const repair = parsedFailure?.success && !parsedFailure.data.ok && 'repair' in parsedFailure.data ? parsedFailure.data.repair : undefined;
                        results.push({ ...identity, status: 'failed', code,
                            ...(repair ? { repair } : {}) });
                    }
                }
                return { results };
            },
            create: async args => {
                const { prepareSavedSecretResourceCreateForOperation } = await import('./hydrateSavedSecretCatalog');
                const storage = await resolveCliAccountStorageContext({ credentials: params.credentials, signal: context.signal });
                await assertCurrent();
                const secretId = randomUUID();
                const source = args.storeIn ? await store(args.storeIn, args.name, args.value!) : args.source;
                const request = prepareSavedSecretResourceCreateForOperation({ credentials: params.credentials, accountId,
                    accountMode: storage.mode, resourceId: secretId, displayName: args.name,
                    kind: source?.kind === 'passkey' ? 'other' : args.kind ?? 'apiKey', value: source ? undefined : args.value, source });
                SharedSavedSecretMutationOutputV1Schema.parse(await mutate('secrets.shared.create', request));
                return { secretId, secretRef: formatSharedSavedSecretRefV1(secretId) };
            },
            update: async args => updateOwnedSavedSecretResource(owner, { ...params, resourceId: args.secretId,
                expectedRevision: args.expectedUpdatedAt, nextName: args.name, nextValue: args.value, nextSource: args.source, signal: context.signal,
                executeMutation: value => params.home({ actionId: 'secrets.shared.update', input: value, context, signal: context.signal }),
            }),
            delete: async args => {
                await findOwned(args.secretId, args.expectedUpdatedAt);
                const { captured, references } = await captureReferences(args.secretId);
                if (references.length) refusal('in_use', { references });
                SharedSavedSecretDeleteOutputV1Schema.parse(await mutate('secrets.shared.delete', { resourceId: args.secretId,
                    expectedRevision: args.expectedUpdatedAt, expectedSettingsVersion: captured.expectedSettingsVersion, referenceCensus: captured.referenceCensus }));
            },
        });
        try { return await execute(actionId, input); }
        finally { await nativeRuntime?.dispose(); }
    });
}
