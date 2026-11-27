import type { SavedSecretReferenceCatalogsV1 } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { formatSavedSecretCatalogReferenceV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { SavedSecretCatalogRevisionsV1Schema, SavedSecretCatalogMutationsV1Schema,
    type SavedSecretCatalogRevisionsV1, type SavedSecretCatalogMutationsV1, type SavedSecretReferenceCensusV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { openMcpServerCatalogContentV1, listMcpServerCatalogSavedSecretRefsV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { openAcpCatalogContentV1, listAcpCatalogSavedSecretRefsV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { openProviderConnectionsContentV1, listProviderConnectionsCatalogSavedSecretRefsV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { openConnectedAccountCatalogContentV1, listConnectedConfigurationCatalogSavedSecretRefsV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { openNotificationChannelCatalogContentV1, listNotificationChannelSavedSecretRefsV1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import type { ProfileAccountContext } from '@/sync/api/account/apiProfileCatalog';
import { readMcpServerCatalogRowInContext, prepareMcpServerCatalogMutationInContext } from '@/sync/api/account/apiMcpServerCatalog';
import { readAcpCatalogRowInContext, prepareAcpCatalogMutationInContext } from '@/sync/api/account/apiAcpCatalog';
import { readProviderCatalogRowInContext, prepareProviderCatalogMutationInContext } from '@/sync/api/account/apiProviderCatalog';
import { readConnectedAccountCatalogRowInContext, prepareConnectedAccountCatalogMutationInContext } from '@/sync/api/account/apiConnectedAccountCatalog';
import { captureSavedSecretReferenceRevisionsInContext, type SavedSecretReferenceRevisionProof } from '@/sync/api/account/apiSavedSecretCatalog';
import { readNotificationChannelCatalogRowInContext } from '@/sync/api/account/apiNotificationChannelCatalog';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import type { SharedSavedSecretPromoteInputV1Schema, SharedSavedSecretPromoteOutputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { applyAcknowledgedMcpServerCatalog } from '@/sync/store/settings/mcpServerCatalogSnapshot';
import { applyAcknowledgedAcpCatalog } from '@/sync/store/settings/acpCatalogSnapshot';
import { applyAcknowledgedProviderCatalog } from '@/sync/store/settings/providerCatalogSnapshot';
import { applyAcknowledgedConnectedAccountCatalog } from '@/sync/store/settings/connectedAccountCatalogSnapshot';
import { applyAcknowledgedNotificationChannelCatalog } from '@/sync/store/settings/notificationChannelCatalogSnapshot';
import { applyAcknowledgedRemoteHostCatalog } from '@/sync/store/settings/remoteHostCatalogSnapshot';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { openPromptLibraryContentV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { readPromptLibraryRowInContext, preparePromptLibraryRecordMutationInContext } from '@/sync/api/account/apiPromptLibraryCatalog';
import { applyPromptLibraryCatalogAcknowledgedRecord } from '@/sync/store/settings/promptLibraryCatalogSnapshot';
import { listSavedSecretReferenceCatalogRefsV1 } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import type { SharedSavedSecretReferenceSelectionV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';

export type SavedSecretReferenceCatalogKey = keyof SavedSecretCatalogRevisionsV1;
export type SavedSecretReferenceCatalogFacets = Pick<SavedSecretReferenceCatalogsV1, SavedSecretReferenceCatalogKey>;
type PresentStoredContent<T> = T extends { status: 'present'; content: infer Content } ? Content : never;
type CapturedCatalogStoredContents = {
    mcp?: PresentStoredContent<Awaited<ReturnType<typeof readMcpServerCatalogRowInContext>>>;
    acp?: PresentStoredContent<Awaited<ReturnType<typeof readAcpCatalogRowInContext>>>;
    providerConnections?: PresentStoredContent<Awaited<ReturnType<typeof readProviderCatalogRowInContext>>>;
    connectedConfigurations?: PresentStoredContent<Awaited<ReturnType<typeof readConnectedAccountCatalogRowInContext>>>;
    connectedPurposes?: PresentStoredContent<Awaited<ReturnType<typeof readConnectedAccountCatalogRowInContext>>>;
    registrySources?: PresentStoredContent<Awaited<ReturnType<typeof readPromptLibraryRowInContext>>>;
};
type CapturedCatalogs = Readonly<{ catalogs: SavedSecretReferenceCatalogFacets; revisions: Partial<SavedSecretCatalogRevisionsV1>;
    storedContents: CapturedCatalogStoredContents }>;
type CompleteCapturedCatalogs = Readonly<{ catalogs: SavedSecretReferenceCatalogFacets; revisions: SavedSecretCatalogRevisionsV1;
    storedContents: CapturedCatalogStoredContents }>;
const catalogKeys = ['mcp', 'acp', 'providerConnections', 'connectedConfigurations', 'connectedPurposes', 'registrySources'] as const;

/** Publish only explicit receipt revisions; revalidate the exact submitted mutation intent. */
export function publishAcknowledgedSavedSecretReferenceCatalogsInContext(context: ProfileAccountContext, input: Readonly<{
    catalogs: SavedSecretReferenceCatalogFacets & Pick<SavedSecretReferenceCatalogsV1, 'notificationChannels' | 'remoteHostRecords'>;
    accountMode: 'plain' | 'e2ee';
    mutation: Pick<ReturnType<typeof SharedSavedSecretPromoteInputV1Schema.parse>,
        'catalogMutations' | 'notificationChannelMutation' | 'remoteHostMutation'>;
    receipt: ReturnType<typeof SharedSavedSecretPromoteOutputV1Schema.parse>;
}>): void {
    if (!context.accountLifetime.isCurrent()) return;
    const scope = context.accountLifetime.scope;
    const revisions = input.receipt.catalogRevisions;
    const refresh = (promise: Promise<unknown>) => fireAndForget(promise, { tag: 'savedSecretCatalog.afterAcknowledgedReferenceMutation' });
    try {
        if (input.mutation.catalogMutations?.registrySources) {
            if (typeof revisions?.registrySources === 'number' && input.catalogs.registrySources)
                applyPromptLibraryCatalogAcknowledgedRecord(scope, { key: 'registry-sources', value: input.catalogs.registrySources }, revisions.registrySources, true);
            refresh(import('@/sync/engine/settings/promptLibraryCatalogEngine').then(engine =>
                engine.invalidatePromptLibraryCatalogAfterAcknowledgedMutation(scope, context.assertAccountCurrent)));
        }
        if (input.mutation.catalogMutations?.mcp) {
            if (typeof revisions?.mcp === 'number' && input.catalogs.mcp)
                applyAcknowledgedMcpServerCatalog(scope, input.catalogs.mcp, revisions.mcp, true);
            refresh(import('@/sync/engine/settings/mcpServerCatalogEngine').then(engine =>
                engine.invalidateMcpServerCatalogAfterAcknowledgedMutation(scope, context.assertAccountCurrent)));
        }
        if (input.mutation.catalogMutations?.acp) {
            if (typeof revisions?.acp === 'number' && input.catalogs.acp)
                applyAcknowledgedAcpCatalog(scope, input.catalogs.acp, revisions.acp, true);
            refresh(import('@/sync/engine/settings/acpCatalogEngine').then(engine =>
                engine.invalidateAcpCatalogAfterAcknowledgedMutation(scope, context.assertAccountCurrent)));
        }
        if (input.mutation.catalogMutations?.providerConnections) {
            if (typeof revisions?.providerConnections === 'number' && input.catalogs.providerConnections) {
                const admission = input.accountMode === 'e2ee' ? createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
                    material: resolveAccountScopedCryptoMaterialFromCredentials(context.credentials) }) : null;
                applyAcknowledgedProviderCatalog(scope, input.catalogs.providerConnections, revisions.providerConnections, true,
                    admission?.contentPublicKeyFingerprint ? { contentPublicKeyFingerprint: admission.contentPublicKeyFingerprint } : null);
            }
            refresh(import('@/sync/engine/settings/providerCatalogEngine').then(engine =>
                engine.invalidateProviderCatalogAfterAcknowledgedMutation(scope, context.assertAccountCurrent)));
        }
        if (input.mutation.catalogMutations?.connectedConfigurations) {
            if (typeof revisions?.connectedConfigurations === 'number' && input.catalogs.connectedConfigurations)
                applyAcknowledgedConnectedAccountCatalog(scope, { key: 'configurations', value: input.catalogs.connectedConfigurations },
                    revisions.connectedConfigurations, true);
            refresh(import('@/sync/engine/settings/connectedAccountCatalogEngine').then(engine =>
                engine.invalidateConnectedAccountCatalogAfterAcknowledgedMutation(scope, 'configurations', context.assertAccountCurrent)));
        }
        if (input.mutation.catalogMutations?.connectedPurposes) {
            if (typeof revisions?.connectedPurposes === 'number' && input.catalogs.connectedPurposes)
                applyAcknowledgedConnectedAccountCatalog(scope, { key: 'purposes', value: input.catalogs.connectedPurposes }, revisions.connectedPurposes, true);
            refresh(import('@/sync/engine/settings/connectedAccountCatalogEngine').then(engine =>
                engine.invalidateConnectedAccountCatalogAfterAcknowledgedMutation(scope, 'purposes', context.assertAccountCurrent)));
        }
        if (input.mutation.notificationChannelMutation) {
            if (input.receipt.notificationChannelRevision !== undefined && input.catalogs.notificationChannels)
                applyAcknowledgedNotificationChannelCatalog(scope, input.catalogs.notificationChannels.channels, input.receipt.notificationChannelRevision, true);
            refresh(import('@/sync/engine/settings/notificationChannelCatalogEngine').then(engine =>
                engine.invalidateNotificationChannelCatalogAfterAcknowledgedMutation(scope, context.assertAccountCurrent)));
        }
        if (input.mutation.remoteHostMutation) {
            if (input.receipt.remoteHostRevision !== undefined && input.catalogs.remoteHostRecords)
                applyAcknowledgedRemoteHostCatalog(scope, input.catalogs.remoteHostRecords, input.receipt.remoteHostRevision, true);
            refresh(import('@/sync/engine/settings/remoteHostCatalogEngine').then(engine => context.accountLifetime.isCurrent()
                ? engine.invalidateRemoteHostCatalogProjection(scope) : undefined));
        }
    } catch { /* Display publication cannot retract an acknowledged atomic transaction. */ }
}

// The caller's admission proved `mode` once (fresh authority). Reads and preparation here consume it;
// Home's Account encryption-transition fence decides it again for every census and catalog write.
/** Notification authority belongs to the full census, not the numeric catalog batch. */
export async function captureSavedSecretNotificationChannelsInContext(context: ProfileAccountContext,
    mode: 'plain' | 'e2ee'): Promise<Readonly<{
        catalog: SavedSecretReferenceCatalogsV1['notificationChannels'];
        census: NonNullable<SavedSecretReferenceCensusV1['notificationChannels']>;
    }> | null> {
    try {
        context.assertCurrent();
        const row = await readNotificationChannelCatalogRowInContext({
            request: (path, init) => context.request(path, init, { retry: 'none' }),
            isCurrent: context.accountLifetime.isCurrent,
        });
        if (row.status === 'absent') return { catalog: undefined, census: { revision: 'absent', resourceRefs: [] } };
        if (row.status === 'deleted') return { catalog: null, census: { revision: row.revision, resourceRefs: [] } };
        if (row.status !== 'present') return null;
        const material = mode === 'plain' ? null : resolveAccountScopedCryptoMaterialFromCredentials(context.credentials);
        const opened = openNotificationChannelCatalogContentV1({ content: row.content, mode, material });
        if (opened.status !== 'opened') return null;
        context.assertCurrent();
        return { catalog: opened.record, census: { revision: row.revision,
            resourceRefs: listNotificationChannelSavedSecretRefsV1(opened.record) } };
    } catch { return null; }
}

export function captureSavedSecretReferenceCatalogsInContext(context: ProfileAccountContext,
    mode: 'plain' | 'e2ee'): Promise<CompleteCapturedCatalogs | null>;
export function captureSavedSecretReferenceCatalogsInContext(context: ProfileAccountContext,
    mode: 'plain' | 'e2ee', keys: readonly SavedSecretReferenceCatalogKey[]): Promise<CapturedCatalogs | null>;
/** Raw reads only: census cannot activate a retained source or run import maintenance. */
export async function captureSavedSecretReferenceCatalogsInContext(context: ProfileAccountContext,
    mode: 'plain' | 'e2ee', keys?: readonly SavedSecretReferenceCatalogKey[]): Promise<CapturedCatalogs | null> {
    try {
        context.assertCurrent();
        const material = mode === 'plain' ? null : resolveAccountScopedCryptoMaterialFromCredentials(context.credentials);
        const catalogs: { -readonly [K in keyof SavedSecretReferenceCatalogFacets]: SavedSecretReferenceCatalogFacets[K] } = {};
        const revisions: Partial<SavedSecretCatalogRevisionsV1> = {};
        const storedContents: CapturedCatalogStoredContents = {};
        await Promise.all([...new Set(keys ?? catalogKeys)].map(async key => {
            switch (key) {
                case 'registrySources': {
                    const row = await readPromptLibraryRowInContext(context, 'registry-sources');
                    if (row.status === 'absent') { revisions.registrySources = 'absent'; return; }
                    if (row.status === 'deleted') { catalogs.registrySources = null; revisions.registrySources = row.revision; return; }
                    if (row.status !== 'present') throw new Error('saved_secret_reference_catalog_unavailable');
                    const opened = openPromptLibraryContentV1({ key: 'registry-sources', content: row.content, mode, material });
                    if (opened.status !== 'opened' || opened.record.key !== 'registry-sources') throw new Error('saved_secret_reference_catalog_incomplete');
                    storedContents.registrySources = row.content;
                    catalogs.registrySources = opened.record.value; revisions.registrySources = row.revision; return;
                }
                case 'mcp': {
                    const row = await readMcpServerCatalogRowInContext(context);
                    if (row.status === 'absent') { revisions.mcp = 'absent'; return; }
                    if (row.status === 'deleted') { catalogs.mcp = null; revisions.mcp = row.revision; return; }
                    if (row.status !== 'present') throw new Error('saved_secret_reference_catalog_unavailable');
                    storedContents.mcp = row.content;
                    const opened = openMcpServerCatalogContentV1({ content: row.content, mode, material });
                    if (opened.status !== 'opened') throw new Error('saved_secret_reference_catalog_incomplete');
                    catalogs.mcp = opened.catalog; revisions.mcp = row.revision; return;
                }
                case 'acp': {
                    const row = await readAcpCatalogRowInContext(context);
                    if (row.status === 'absent') { revisions.acp = 'absent'; return; }
                    if (row.status === 'deleted') { catalogs.acp = null; revisions.acp = row.revision; return; }
                    if (row.status !== 'present') throw new Error('saved_secret_reference_catalog_unavailable');
                    const opened = openAcpCatalogContentV1({ content: row.content, mode, material });
                    storedContents.acp = row.content;
                    if (opened.status !== 'opened') throw new Error('saved_secret_reference_catalog_incomplete');
                    catalogs.acp = opened.record; revisions.acp = row.revision; return;
                }
                case 'providerConnections': {
                    const row = await readProviderCatalogRowInContext(context);
                    if (row.status === 'absent') { revisions.providerConnections = 'absent'; return; }
                    if (row.status === 'deleted') { catalogs.providerConnections = null; revisions.providerConnections = row.revision; return; }
                    if (row.status !== 'present') throw new Error('saved_secret_reference_catalog_unavailable');
                    const opened = openProviderConnectionsContentV1({ content: row.content, mode, material });
                    storedContents.providerConnections = row.content;
                    if (opened.status !== 'opened') throw new Error('saved_secret_reference_catalog_incomplete');
                    catalogs.providerConnections = opened.catalog; revisions.providerConnections = row.revision; return;
                }
                case 'connectedConfigurations':
                case 'connectedPurposes': {
                    const domainKey = key === 'connectedConfigurations' ? 'configurations' : 'purposes';
                    const row = await readConnectedAccountCatalogRowInContext(context, domainKey);
                    if (row.status === 'absent') { revisions[key] = 'absent'; return; }
                    if (row.status === 'deleted') { catalogs[key] = null; revisions[key] = row.revision; return; }
                    if (row.status !== 'present') throw new Error('saved_secret_reference_catalog_unavailable');
                    const opened = openConnectedAccountCatalogContentV1({ key: domainKey, content: row.content, mode, material });
                    storedContents[key] = row.content;
                    if (opened.status !== 'opened') throw new Error('saved_secret_reference_catalog_incomplete');
                    if (key === 'connectedConfigurations' && opened.record.key === 'configurations') catalogs.connectedConfigurations = opened.record.value;
                    else if (key === 'connectedPurposes' && opened.record.key === 'purposes') catalogs.connectedPurposes = opened.record.value;
                    else throw new Error('saved_secret_reference_catalog_identity_invalid');
                    revisions[key] = row.revision; return;
                }
            }
        }));
        context.assertCurrent();
        return { catalogs, storedContents, revisions: keys === undefined ? SavedSecretCatalogRevisionsV1Schema.parse(revisions) : revisions };
    } catch { return null; }
}

/** Reuse each domain's preparation owner; no catalog write occurs here. */
export async function prepareSavedSecretReferenceCatalogMutationsInContext(context: ProfileAccountContext, input: Readonly<{
    catalogs: SavedSecretReferenceCatalogFacets;
    previousCatalogs: SavedSecretReferenceCatalogFacets;
    revisions: Partial<SavedSecretCatalogRevisionsV1>;
    accountMode: 'plain' | 'e2ee';
    sourceSettingsVersion?: number;
    savedSecretRevisions?: readonly SavedSecretReferenceRevisionProof[];
    selectedSecrets?: readonly SharedSavedSecretReferenceSelectionV1[];
    pendingResourceIds?: readonly string[];
}>): Promise<SavedSecretCatalogMutationsV1> {
    context.assertCurrent();
    const changed = (key: SavedSecretReferenceCatalogKey) => input.catalogs[key] !== undefined
        && !sameStrictJsonValue(input.catalogs[key], input.previousCatalogs[key]);
    for (const key of catalogKeys) if (changed(key) && input.catalogs[key] === null) {
        throw new Error('saved_secret_reference_catalog_mutation_invalid');
    }
    const mcp = changed('mcp') ? input.catalogs.mcp : undefined;
    const acp = changed('acp') ? input.catalogs.acp : undefined;
    const providerConnections = changed('providerConnections') ? input.catalogs.providerConnections : undefined;
    const connectedConfigurations = changed('connectedConfigurations') ? input.catalogs.connectedConfigurations : undefined;
    const connectedPurposes = changed('connectedPurposes') ? input.catalogs.connectedPurposes : undefined;
    const registrySources = changed('registrySources') ? input.catalogs.registrySources : undefined;
    const references = [
        ...(mcp ? listMcpServerCatalogSavedSecretRefsV1(mcp) : []),
        ...(acp ? listAcpCatalogSavedSecretRefsV1(acp) : []),
        ...(providerConnections ? listProviderConnectionsCatalogSavedSecretRefsV1(providerConnections) : []),
        ...(connectedConfigurations ? listConnectedConfigurationCatalogSavedSecretRefsV1(connectedConfigurations) : []),
        ...(registrySources ? listSavedSecretReferenceCatalogRefsV1({ profileRecords: [], registrySources }) : []),
    ].map(reference => reference.secretId);
    const pendingResourceIds = input.pendingResourceIds?.filter(id => references.includes(
        formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id })));
    const proofs = await captureSavedSecretReferenceRevisionsInContext(context, { references,
        savedSecretRevisions: input.savedSecretRevisions, selectedSecrets: input.selectedSecrets, pendingResourceIds });
    const common = (key: SavedSecretReferenceCatalogKey) => {
        const expectedRevision = input.revisions[key];
        if (expectedRevision === undefined) throw new Error('saved_secret_reference_catalog_currentness_unavailable');
        return { expectedRevision, savedSecretRevisions: proofs.savedSecretRevisions,
            ...(expectedRevision === 'absent' ? { sourceSettingsVersion: input.sourceSettingsVersion } : {}) };
    };
    const mutations = {
        ...(mcp ? { mcp: await prepareMcpServerCatalogMutationInContext(context, { catalog: mcp, ...common('mcp') }) } : {}),
        ...(acp ? { acp: await prepareAcpCatalogMutationInContext(context, { record: acp, ...common('acp') }) } : {}),
        ...(providerConnections ? { providerConnections: await prepareProviderCatalogMutationInContext(context,
            { catalog: providerConnections, ...common('providerConnections') }) } : {}),
        ...(connectedConfigurations ? { connectedConfigurations: await prepareConnectedAccountCatalogMutationInContext(context,
            { record: { key: 'configurations', value: connectedConfigurations }, ...common('connectedConfigurations') }) } : {}),
        ...(connectedPurposes ? { connectedPurposes: await prepareConnectedAccountCatalogMutationInContext(context,
            { record: { key: 'purposes', value: connectedPurposes }, ...common('connectedPurposes') }) } : {}),
        ...(registrySources ? { registrySources: await preparePromptLibraryRecordMutationInContext(context,
            { record: { key: 'registry-sources', value: registrySources }, ...common('registrySources'), pendingResourceIds }) } : {}),
    };
    context.assertCurrent();
    return SavedSecretCatalogMutationsV1Schema.parse(mutations);
}
