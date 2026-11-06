import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { expect } from 'vitest';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';
import {
    SHARED_SAVED_SECRET_ACTION_PATHS_V1,
    SharedSavedSecretCreateInputV1Schema,
    SharedSavedSecretGrantsSetInputV1Schema,
    SharedSavedSecretPromoteInputV1Schema,
} from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { SavedSecretResourceMaterialsResponseV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { PROFILE_ROWS_ROUTE_V1, PROFILE_REFERENCE_GUARD_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { REMOTE_HOST_ROWS_ROUTE_V1 } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import { NOTIFICATION_CHANNELS_ROUTE_V1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';

import { createRootLayoutFeaturesResponse } from '../fixtures/featureFixtures';
import { createArtifactStoreBoundary } from './artifactStoreBoundary';
import { installRealActionExecutorModuleLoader, serveAccountHomes, type ServedHomeRequest } from './actionHomesHttpHarness';
import { waitForHomeGovernance } from './homeGovernanceHarness';

export const savedSecretCreatePath = SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.create'];
export const savedSecretGrantsPath = SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.grants.set'];
export const savedSecretPromotePath = SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.promote'];

/** External Home state only; editor, Action policy, custody, codecs and mutation owners stay real. */
export async function serveSavedSecretEditorHomes(params: Readonly<{
    homes: Parameters<typeof serveAccountHomes>[0]['homes'];
    route: (request: ServedHomeRequest) => Response | Promise<Response | undefined> | undefined;
}>) {
    const restoreExecutor = await installRealActionExecutorModuleLoader();
    const { resetTeamActionClientForTests } = await import('@/sync/ops/teams/teamActionClient');
    const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
    resetTeamActionClientForTests();
    resetServerFeaturesClientForTests();
    const features = createRootLayoutFeaturesResponse();
    for (const feature of ['teams', 'teams.credentialResources'] as const) {
        if (!tryWriteServerEnabledBitInPlace(features, feature, true)) throw new Error(`Missing fixture feature: ${feature}`);
    }
    const actionsSettingsV1 = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: {
        'secrets.shared.create': ['ui'], 'secrets.shared.promote': ['ui'], 'secrets.shared.grants.set': ['ui'],
    } });
    const artifacts = new Map(params.homes.map(home => [home.key,
        createArtifactStoreBoundary({ ownerAccountId: () => home.accountId, encryptionMode: 'plain' })]));
    const resources = new Map(params.homes.map(home => [home.key,
        new Map<string, ReturnType<typeof SavedSecretResourceMaterialsResponseV1Schema.parse>['resources'][number]>()]));
    const settings = new Map<string, Readonly<Record<string, unknown>>>(params.homes.map(home => [home.key, { actionsSettingsV1, ...home.settings }]));
    const versions = new Map(params.homes.map(home => [home.key, 1]));
    let mutationResponse: ((request: ServedHomeRequest) => Response | Promise<Response>) | null = null;
    const mutations: ServedHomeRequest[] = [];
    let home: Awaited<ReturnType<typeof serveAccountHomes>>;
    try {
        home = await serveAccountHomes({ homes: params.homes.map(spec => ({ ...spec, currentAccount: true,
            settings: settings.get(spec.key) })), route: async request => {
            if (request.path === '/v1/features' || request.path === '/v1/features/authenticated') return Response.json(features);
            const custom = await params.route(request);
            if (custom) return custom;
            const artifactResponse = artifacts.get(request.home)!.handle(request.path + request.url.search, {
                method: request.method, headers: request.headers,
                ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
            });
            if (artifactResponse) return artifactResponse;
            if (request.path === PROFILE_ROWS_ROUTE_V1) return Response.json({ status: 'listed', rows: [], nextCursor: null,
                complete: true, referenceGuardRevision: 0, transferControl: { status: 'absent' }, diagnostics: [] });
            if (request.path === PROFILE_REFERENCE_GUARD_ROUTE_V1) return Response.json({ status: 'ready', revision: 0 });
            if (request.path === PROFILE_TRANSFER_ROUTE_V1) return Response.json({ status: 'absent' });
            if ([REMOTE_HOST_ROWS_ROUTE_V1, NOTIFICATION_CHANNELS_ROUTE_V1,
                '/v1/account/entity-rows/mcp', '/v1/account/entity-rows/acp',
                '/v1/account/entity-rows/provider-connections', '/v1/account/entity-rows/connected-accounts/configurations',
                '/v1/account/entity-rows/connected-accounts/purposes',
                '/v1/account/entity-rows/prompt-library/registry-sources'].includes(request.path)) return Response.json({ status: 'absent' });
            if (request.path === '/v1/account/saved-secrets/resources/materials') {
                return Response.json(SavedSecretResourceMaterialsResponseV1Schema.parse({ resources: [...resources.get(request.home)!.values()] }));
            }
            if (request.path === '/v2/account/settings/history') return Response.json({ snapshots: [] });
            if (request.method !== 'POST' || ![savedSecretCreatePath, savedSecretGrantsPath, savedSecretPromotePath].some(path => path === request.path)) return undefined;
            mutations.push(request);
            if (mutationResponse) return mutationResponse(request);
            if (request.path === savedSecretGrantsPath) {
                const input = SharedSavedSecretGrantsSetInputV1Schema.parse(request.body);
                return Response.json({ resourceId: input.resourceId, revision: input.expectedRevision + 1 });
            }
            const input = request.path === savedSecretCreatePath ? SharedSavedSecretCreateInputV1Schema.parse(request.body)
                : SharedSavedSecretPromoteInputV1Schema.parse(request.body);
            const resource = SavedSecretResourceMaterialsResponseV1Schema.parse({ resources: [{
                resourceId: input.resourceId, encryptionMode: input.encryptionMode, storedContent: input.storedContent,
                recipientEnvelope: null, entry: {
                    ref: `happier:shared-secret:v1:${input.resourceId}`, source: 'shared_resource', relationship: 'owner',
                    ownerAccountId: request.accountId, name: input.displayName, kind: input.kind, revision: 1,
                    materialStatus: 'ready', capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true },
                },
            }] }).resources[0]!;
            if (request.path === savedSecretPromotePath) {
                const promotion = SharedSavedSecretPromoteInputV1Schema.parse(request.body);
                if (promotion.expectedSettingsVersion !== versions.get(request.home)) return Response.json({ error: 'revision_conflict' }, { status: 409 });
                if (promotion.nextSettings?.t !== 'plain') throw new Error('Plain editor fixture requires plain Settings');
                const version = versions.get(request.home)! + 1;
                settings.set(request.home, promotion.nextSettings.v);
                versions.set(request.home, version);
                resources.get(request.home)!.set(input.resourceId, resource);
                home.replaceAccountSettings(request.home, { settings: promotion.nextSettings.v, version });
                return Response.json({ resourceId: input.resourceId, settingsVersion: version });
            }
            resources.get(request.home)!.set(input.resourceId, resource);
            return Response.json({ resourceId: input.resourceId, revision: 1 });
        } });
    } catch (error) {
        restoreExecutor();
        throw error;
    }
    try {
        const { storage } = await import('@/sync/domains/state/storage');
        const focused = params.homes.at(-1)!;
        await waitForHomeGovernance(() => {
            expect(storage.getState().settingsScope).toEqual({ serverId: home.homes[focused.key]!.id, accountId: focused.accountId });
            expect(storage.getState().settings.actionsSettingsV1).toEqual(settings.get(focused.key)!.actionsSettingsV1);
        });
    } catch (error) {
        try { await home.dispose(); }
        finally { restoreExecutor(); }
        throw error;
    }
    return { ...home, mutations, artifacts, resources,
        settings: (key: string) => settings.get(key),
        replaceSettings(key: string, value: Readonly<Record<string, unknown>>, version: number) {
            const next = { actionsSettingsV1, ...value };
            settings.set(key, next);
            versions.set(key, version);
            home.replaceAccountSettings(key, { settings: next, version });
        },
        respondToMutations(response: typeof mutationResponse) { mutationResponse = response; },
        async dispose() {
            try { await home.dispose(); }
            finally { resetTeamActionClientForTests(); restoreExecutor(); }
        },
    };
}

/**
 * Seeds the Account's Saved Secret catalog through its one snapshot owner, as a finished catalog read would, so a
 * screen that names secrets by reference can be tested without serving the catalog route.
 */
export async function seedSavedSecretCatalogForTest(
    scope: Readonly<{ serverId: string; accountId: string }>,
    secrets: ReadonlyArray<Readonly<{ ref: string; name: string; revision?: number }>>,
): Promise<void> {
    const { applySavedSecretCatalogPage } = await import('@/sync/store/settings/savedSecretCatalogSnapshot');
    applySavedSecretCatalogPage({ scope, observedAt: 1, entries: secrets.map((secret) => ({
        ref: secret.ref, source: 'shared_resource' as const, relationship: 'owner' as const, name: secret.name,
        kind: 'apiKey' as const, encryptionMode: null, owner: null, accessSources: [], audience: null, ownerAccountId: null,
        revision: secret.revision ?? 1, materialStatus: 'ready' as const,
        capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true },
    })) });
}
