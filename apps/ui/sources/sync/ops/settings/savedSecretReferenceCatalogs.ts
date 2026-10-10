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
import { resolveAccountStorageContext } from '@/sync/encryption/accountStorageContext';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import type { ProfileAccountContext } from '@/sync/api/account/apiProfileCatalog';
import { readMcpServerCatalogRowInContext, prepareMcpServerCatalogMutationInContext } from '@/sync/api/account/apiMcpServerCatalog';
import { readAcpCatalogRowInContext, prepareAcpCatalogMutationInContext } from '@/sync/api/account/apiAcpCatalog';
import { readProviderCatalogRowInContext, prepareProviderCatalogMutationInContext } from '@/sync/api/account/apiProviderCatalog';
import { readConnectedAccountCatalogRowInContext, prepareConnectedAccountCatalogMutationInContext } from '@/sync/api/account/apiConnectedAccountCatalog';
import { captureSavedSecretReferenceRevisionsInContext, type SavedSecretReferenceRevisionProof } from '@/sync/api/account/apiSavedSecretCatalog';
import { readNotificationChannelCatalogRowInContext } from '@/sync/api/account/apiNotificationChannelCatalog';

export type SavedSecretReferenceCatalogKey = keyof SavedSecretCatalogRevisionsV1;
export type SavedSecretReferenceCatalogFacets = Pick<SavedSecretReferenceCatalogsV1, SavedSecretReferenceCatalogKey>;
type PresentStoredContent<T> = T extends { status: 'present'; content: infer Content } ? Content : never;
type CapturedCatalogStoredContents = {
    mcp?: PresentStoredContent<Awaited<ReturnType<typeof readMcpServerCatalogRowInContext>>>;
    acp?: PresentStoredContent<Awaited<ReturnType<typeof readAcpCatalogRowInContext>>>;
    providerConnections?: PresentStoredContent<Awaited<ReturnType<typeof readProviderCatalogRowInContext>>>;
    connectedConfigurations?: PresentStoredContent<Awaited<ReturnType<typeof readConnectedAccountCatalogRowInContext>>>;
    connectedPurposes?: PresentStoredContent<Awaited<ReturnType<typeof readConnectedAccountCatalogRowInContext>>>;
};
type CapturedCatalogs = Readonly<{ catalogs: SavedSecretReferenceCatalogFacets; revisions: Partial<SavedSecretCatalogRevisionsV1>;
    storedContents: CapturedCatalogStoredContents }>;
type CompleteCapturedCatalogs = Readonly<{ catalogs: SavedSecretReferenceCatalogFacets; revisions: SavedSecretCatalogRevisionsV1;
    storedContents: CapturedCatalogStoredContents }>;
const catalogKeys = ['mcp', 'acp', 'providerConnections', 'connectedConfigurations', 'connectedPurposes'] as const;

async function assertAccountMode(context: ProfileAccountContext, mode: 'plain' | 'e2ee') {
    context.assertCurrent();
    const { encryption } = await context.resolveAccountEncryption();
    const storage = await resolveAccountStorageContext(context.credentials, { encryption, request: context.request });
    context.assertCurrent();
    if (storage.mode !== mode) throw new Error('saved_secret_account_mode_changed');
}

/** Notification authority belongs to the full census, not the five-domain numeric batch. */
export async function captureSavedSecretNotificationChannelsInContext(context: ProfileAccountContext,
    mode: 'plain' | 'e2ee'): Promise<Readonly<{
        catalog: SavedSecretReferenceCatalogsV1['notificationChannels'];
        census: NonNullable<SavedSecretReferenceCensusV1['notificationChannels']>;
    }> | null> {
    try {
        await assertAccountMode(context, mode);
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
        await assertAccountMode(context, mode);
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
        await assertAccountMode(context, mode);
        const material = mode === 'plain' ? null : resolveAccountScopedCryptoMaterialFromCredentials(context.credentials);
        const catalogs: { -readonly [K in keyof SavedSecretReferenceCatalogFacets]: SavedSecretReferenceCatalogFacets[K] } = {};
        const revisions: Partial<SavedSecretCatalogRevisionsV1> = {};
        const storedContents: CapturedCatalogStoredContents = {};
        await Promise.all([...new Set(keys ?? catalogKeys)].map(async key => {
            switch (key) {
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
        await assertAccountMode(context, mode);
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
    pendingResourceIds?: readonly string[];
}>): Promise<SavedSecretCatalogMutationsV1> {
    await assertAccountMode(context, input.accountMode);
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
    const references = [
        ...(mcp ? listMcpServerCatalogSavedSecretRefsV1(mcp) : []),
        ...(acp ? listAcpCatalogSavedSecretRefsV1(acp) : []),
        ...(providerConnections ? listProviderConnectionsCatalogSavedSecretRefsV1(providerConnections) : []),
        ...(connectedConfigurations ? listConnectedConfigurationCatalogSavedSecretRefsV1(connectedConfigurations) : []),
    ].map(reference => reference.secretId);
    const pendingResourceIds = input.pendingResourceIds?.filter(id => references.includes(
        formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id })));
    const proofs = await captureSavedSecretReferenceRevisionsInContext(context, { references,
        savedSecretRevisions: input.savedSecretRevisions, pendingResourceIds });
    const common = (key: SavedSecretReferenceCatalogKey) => {
        const expectedRevision = input.revisions[key];
        if (expectedRevision === undefined) throw new Error('saved_secret_reference_catalog_currentness_unavailable');
        return { expectedRevision, savedSecretRevisions: proofs.savedSecretRevisions,
            ...(expectedRevision === 'absent' ? { sourceSettingsVersion: input.sourceSettingsVersion } : {}) };
    };
    const mutations: SavedSecretCatalogMutationsV1 = {
        ...(mcp ? { mcp: await prepareMcpServerCatalogMutationInContext(context, { catalog: mcp, ...common('mcp') }) } : {}),
        ...(acp ? { acp: await prepareAcpCatalogMutationInContext(context, { record: acp, ...common('acp') }) } : {}),
        ...(providerConnections ? { providerConnections: await prepareProviderCatalogMutationInContext(context,
            { catalog: providerConnections, ...common('providerConnections') }) } : {}),
        ...(connectedConfigurations ? { connectedConfigurations: await prepareConnectedAccountCatalogMutationInContext(context,
            { record: { key: 'configurations', value: connectedConfigurations }, ...common('connectedConfigurations') }) } : {}),
        ...(connectedPurposes ? { connectedPurposes: await prepareConnectedAccountCatalogMutationInContext(context,
            { record: { key: 'purposes', value: connectedPurposes }, ...common('connectedPurposes') }) } : {}),
    };
    await assertAccountMode(context, input.accountMode);
    return SavedSecretCatalogMutationsV1Schema.parse(mutations);
}
