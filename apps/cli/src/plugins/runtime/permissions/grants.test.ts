import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
    PluginPermissionGrantAuthoritySourceV1,
    PluginPermissionCapabilityV1,
    PluginPermissionDeclarationV1,
    PluginPermissionGrantV1,
} from '@happier-dev/protocol';

import type {
    ResolvedBackendContribution,
    ResolvedContributionProvenance,
    ResolvedContributionRegistry,
    ResolvedContributionSourceKind,
    ResolvedProviderContribution,
} from '@/plugins/projection/registry/types';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';

import { activatePluginRuntimeRegistry } from '../lifecycle/manager';
import {
    resolveTrustedOptionalPermissionGrantsFromServer,
    type TrustedOptionalPluginPermissionGrant,
} from './grants';

const { axiosPostMock, readCredentialsMock, readSettingsMock, readInstallationIdentityIfExistsSyncMock } = vi.hoisted(() => ({
    axiosPostMock: vi.fn<(...args: unknown[]) => unknown>(),
    readCredentialsMock: vi.fn<(...args: unknown[]) => unknown>(),
    readSettingsMock: vi.fn<(...args: unknown[]) => unknown>(),
    readInstallationIdentityIfExistsSyncMock: vi.fn<(...args: unknown[]) => unknown>(),
}));

vi.mock('axios', () => ({
    default: {
        post: axiosPostMock,
    },
}));

vi.mock('@/persistence', () => ({
    readCredentials: readCredentialsMock,
    readSettings: readSettingsMock,
}));

vi.mock('@/daemon/identity/store', () => ({
    readInstallationIdentityIfExistsSync: readInstallationIdentityIfExistsSyncMock,
}));

type RuntimeRegistryWithGrantMaps = Awaited<ReturnType<typeof activatePluginRuntimeRegistry>> & Readonly<{
    requiredPermissionsByPluginId: ReadonlyMap<string, ReadonlySet<PluginPermissionCapabilityV1>>;
    optionalPermissionDeclarationsByPluginId: ReadonlyMap<string, readonly PluginPermissionDeclarationV1[]>;
    trustedOptionalPermissionsByPluginId: ReadonlyMap<string, ReadonlySet<PluginPermissionCapabilityV1>>;
}>;

async function writePlugin(params: Readonly<{
    pluginId: string;
    runtimeCapabilities?: readonly string[];
    requiredPermissions?: readonly PluginPermissionDeclarationV1[];
    optionalPermissions?: readonly PluginPermissionDeclarationV1[];
    actionIds?: readonly string[];
    daemonSource?: string;
}>): Promise<Readonly<{
    manifestPath: string;
    daemonEntryPath: string;
}>> {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-optional-grants-'));
    const manifestPath = join(root, '.happier-plugin', 'plugin.json');
    const daemonEntryPath = join(root, 'daemon.mjs');
    await mkdir(join(root, '.happier-plugin'), { recursive: true });
    await writeFile(
        manifestPath,
        JSON.stringify(createPluginManifestV2Fixture({
            schemaVersion: 2,
            id: params.pluginId,
            version: '1.0.0',
            displayName: params.pluginId,
            description: `${params.pluginId} optional grants test manifest`,
            runtime: {
                apiVersion: 1,
                capabilities: params.runtimeCapabilities ?? [],
            },
            capabilities: {
                permissions: params.requiredPermissions ?? [],
                optionalPermissions: params.optionalPermissions ?? [],
            },
            targets: {
                daemon: {
                    entry: './daemon.mjs',
                },
            },
            contributes: {
                actions: (params.actionIds ?? []).map((actionId) => ({
                    id: actionId,
                    title: `${actionId} test action`,
                    scopes: ['global'],
                    surfaces: ['cli'],
                    placement: 'commandPalette',
                    dangerLevel: 'safe',
                    handler: { target: 'daemon', registrationId: actionId },
                })),
            },
        })),
        'utf8',
    );
    await writeFile(
        daemonEntryPath,
        params.daemonSource ?? 'export async function activate() {}\n',
        'utf8',
    );
    return { manifestPath, daemonEntryPath };
}

function createContributes(params: Readonly<{
    pluginId: string;
    manifestPath: string;
    daemonEntryPath: string;
    provenance?: ResolvedContributionProvenance;
    sourceKind?: ResolvedContributionSourceKind;
}>): ResolvedContributionRegistry {
    const provenance = params.provenance ?? 'external';
    const sourceKind = params.sourceKind ?? 'path';
    const provider: ResolvedProviderContribution = {
        id: params.pluginId,
        provenance,
        source: { kind: sourceKind },
        pluginId: params.pluginId,
        manifestPath: params.manifestPath,
        manifestDigest: `digest-${params.pluginId}`,
        daemonEntryPath: params.daemonEntryPath,
        sourceSpec: {
            kind: 'path',
            locator: join(params.manifestPath, '..', '..'),
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
        },
        definition: {
            kindVersion: 1,
            id: params.pluginId,
            ownedBackendIds: [`${params.pluginId}.backend`],
        },
    };
    const backend: ResolvedBackendContribution = {
        id: `${params.pluginId}.backend`,
        providerId: params.pluginId,
        provenance,
        source: { kind: sourceKind },
        pluginId: params.pluginId,
        manifestPath: params.manifestPath,
        manifestDigest: `digest-${params.pluginId}`,
        daemonEntryPath: params.daemonEntryPath,
        sourceSpec: provider.sourceSpec,
        definition: {
            kindVersion: 1,
            id: `${params.pluginId}.backend`,
            providerId: params.pluginId,
        },
    };

    return {
        providers: [provider],
        backends: [backend],
        actions: [],
        resources: [],
        uiDescriptors: [],
        activationTargets: [],
        hookRegistrations: [],
        surfaceHandlersByBackendId: new Map(),
        catalogEntriesById: Object.freeze({}),
        providerDefinitionsById: new Map([[provider.id, provider]]),
        backendDefinitionsById: new Map([[backend.id, backend]]),
        pluginDiagnosticsByPluginId: Object.freeze({}),
    };
}

describe('trusted optional plugin permission grants', () => {
    beforeEach(() => {
        axiosPostMock.mockReset();
        readCredentialsMock.mockReset();
        readSettingsMock.mockReset();
        readInstallationIdentityIfExistsSyncMock.mockReset();
        readCredentialsMock.mockResolvedValue(null);
        readSettingsMock.mockResolvedValue({ machineId: 'machine-1' });
        readInstallationIdentityIfExistsSyncMock.mockReturnValue({
            version: 1,
            installationId: 'installation-1',
            createdAt: 1,
            publicKey: 'public-key',
            privateKey: 'private-key',
        });
    });

    function createGrant(params: Readonly<{
        pluginId: string;
        capability: PluginPermissionCapabilityV1;
        status?: PluginPermissionGrantV1['status'];
        authoritySource?: PluginPermissionGrantAuthoritySourceV1;
    }>): PluginPermissionGrantV1 {
        return {
            v: 1,
            id: `grant-${params.pluginId}-${params.capability}`,
            accountId: 'account-1',
            pluginId: params.pluginId,
            capability: params.capability,
            targetScope: { kind: 'project', projectId: 'project-1' },
            authoritySource: params.authoritySource ?? {
                kind: 'machine_installation',
                machineId: 'machine-1',
                installationId: 'installation-1',
            },
            status: params.status ?? 'active',
            grantedByUserId: 'user-1',
            grantedAt: 1,
            createdAt: 1,
            updatedAt: 1,
        };
    }

    it('loads only trusted active optional grants from the server grant list endpoint', async () => {
        const pluginId = 'acme.optional.server';
        const activeGrant = {
            ...createGrant({ pluginId, capability: 'env' }),
            targetScope: { kind: 'account' as const },
        };
        readCredentialsMock.mockResolvedValue({
            token: 'token-1',
            encryption: { type: 'legacy', secret: new Uint8Array() },
        });
        axiosPostMock.mockResolvedValue({
            status: 200,
            data: {
                grants: [
                    activeGrant,
                    {
                        ...activeGrant,
                        id: 'grant-wrong-machine',
                        authoritySource: {
                            kind: 'machine_installation',
                            machineId: 'machine-2',
                            installationId: 'installation-2',
                        },
                    },
                    createGrant({ pluginId, capability: 'env', status: 'revoked' }),
                    createGrant({ pluginId: 'acme.other', capability: 'env' }),
                    createGrant({ pluginId, capability: 'process.spawn' }),
                ],
                pendingRequests: [],
            },
        });

        const grants = await resolveTrustedOptionalPermissionGrantsFromServer({
            pluginId,
            manifestPath: '/tmp/acme/.happier-plugin/plugin.json',
            manifestDigest: 'sha256:acme',
            requiredPermissions: [],
            optionalPermissions: [{ capability: 'env', scope: 'HAPPIER_OPTIONAL_TOKEN' }],
        });

        expect(grants).toEqual([activeGrant]);
        expect(axiosPostMock).toHaveBeenCalledWith(
            expect.stringContaining('/v1/plugins/permissions/grants/list'),
            {
                pluginId,
                targetScope: { kind: 'account' },
                includeRevoked: false,
                includeResolvedRequests: false,
                limit: 200,
            },
            expect.objectContaining({
                headers: { Authorization: 'Bearer token-1' },
                validateStatus: expect.any(Function),
            }),
        );
    });

    it('does not activate external account grants from a different machine authority', async () => {
        const pluginId = 'acme.optional.machine-bound';
        const { manifestPath, daemonEntryPath } = await writePlugin({
            pluginId,
            optionalPermissions: [
                { capability: 'env', scope: 'HAPPIER_MACHINE_BOUND_TOKEN' },
            ],
        });

        const activated = await activatePluginRuntimeRegistry({
            contributes: createContributes({ pluginId, manifestPath, daemonEntryPath }),
            generation: 6,
            resolveTrustedOptionalPermissionGrants: async () => [
                {
                    ...createGrant({
                        pluginId,
                        capability: 'env',
                        authoritySource: {
                            kind: 'machine_installation',
                            machineId: 'machine-2',
                            installationId: 'installation-2',
                        },
                    }),
                    targetScope: { kind: 'account' },
                },
            ],
        }) as RuntimeRegistryWithGrantMaps;

        expect(activated.trustedOptionalPermissionsByPluginId.get(pluginId)).toEqual(new Set());
        expect(activated.permissionsByPluginId.get(pluginId)).toEqual(new Set());
        expect(activated.envAllowedNamesByPluginId.get(pluginId)).toBeUndefined();
    });

    it('does not load project-scoped grants into the global runtime permission inventory', async () => {
        const pluginId = 'acme.optional.project.scoped';
        readCredentialsMock.mockResolvedValue({
            token: 'token-1',
            encryption: { type: 'legacy', secret: new Uint8Array() },
        });
        axiosPostMock.mockResolvedValue({
            status: 200,
            data: {
                grants: [
                    createGrant({ pluginId, capability: 'env' }),
                ],
                pendingRequests: [],
            },
        });

        const grants = await resolveTrustedOptionalPermissionGrantsFromServer({
            pluginId,
            manifestPath: '/tmp/acme/.happier-plugin/plugin.json',
            manifestDigest: 'sha256:acme',
            requiredPermissions: [],
            optionalPermissions: [{ capability: 'env', scope: 'HAPPIER_PROJECT_TOKEN' }],
        });

        expect(grants).toEqual([]);
    });

    it('keeps optional manifest declarations inactive until a trusted grant is resolved', async () => {
        const pluginId = 'acme.optional.inactive';
        const { manifestPath, daemonEntryPath } = await writePlugin({
            pluginId,
            requiredPermissions: [{ capability: 'network', scope: 'https://required.example.test' }],
            optionalPermissions: [
                { capability: 'env', scope: 'HAPPIER_OPTIONAL_TOKEN' },
                { capability: 'reviews.comments.write.direct' },
            ],
        });

        const activated = await activatePluginRuntimeRegistry({
            contributes: createContributes({ pluginId, manifestPath, daemonEntryPath }),
            generation: 1,
        }) as RuntimeRegistryWithGrantMaps;

        expect(activated.permissionsByPluginId.get(pluginId)).toEqual(new Set(['network']));
        expect(activated.requiredPermissionsByPluginId?.get(pluginId)).toEqual(new Set(['network']));
        expect(activated.trustedOptionalPermissionsByPluginId?.get(pluginId)).toEqual(new Set());
        expect(activated.optionalPermissionDeclarationsByPluginId?.get(pluginId)).toEqual([
            { capability: 'env', scope: 'HAPPIER_OPTIONAL_TOKEN' },
            { capability: 'reviews.comments.write.direct' },
        ]);
        expect(activated.envAllowedNamesByPluginId.get(pluginId)).toBeUndefined();
    });

    it('merges only active trusted grants that match declared optional permissions into runtime policy', async () => {
        const pluginId = 'acme.optional.active';
        const { manifestPath, daemonEntryPath } = await writePlugin({
            pluginId,
            requiredPermissions: [{ capability: 'network', scope: 'https://required.example.test/v1' }],
            optionalPermissions: [
                { capability: 'network', scope: 'https://optional.example.test/v1' },
                { capability: 'env', scope: 'HAPPIER_OPTIONAL_TOKEN' },
                { capability: 'reviews.comments.write.direct' },
            ],
        });
        const grants = [
            { ...createGrant({ pluginId, capability: 'network' }), targetScope: { kind: 'account' as const } },
            { ...createGrant({ pluginId, capability: 'env' }), targetScope: { kind: 'account' as const } },
            {
                ...createGrant({ pluginId, capability: 'reviews.comments.write.direct' }),
                targetScope: { kind: 'account' as const },
            },
            { ...createGrant({ pluginId, capability: 'process.spawn' }), targetScope: { kind: 'account' as const } },
            { ...createGrant({ pluginId, capability: 'network', status: 'revoked' }), targetScope: { kind: 'account' as const } },
            { ...createGrant({ pluginId: 'acme.other', capability: 'env' }), targetScope: { kind: 'account' as const } },
        ] satisfies readonly TrustedOptionalPluginPermissionGrant[];
        const resolveTrustedOptionalPermissionGrants = vi.fn(async () => grants);

        const activated = await activatePluginRuntimeRegistry({
            contributes: createContributes({ pluginId, manifestPath, daemonEntryPath }),
            generation: 2,
            resolveTrustedOptionalPermissionGrants,
        }) as RuntimeRegistryWithGrantMaps;

        expect(resolveTrustedOptionalPermissionGrants).toHaveBeenCalledWith(expect.objectContaining({
            pluginId,
            optionalPermissions: [
                { capability: 'network', scope: 'https://optional.example.test/v1' },
                { capability: 'env', scope: 'HAPPIER_OPTIONAL_TOKEN' },
                { capability: 'reviews.comments.write.direct' },
            ],
        }));
        expect(activated.requiredPermissionsByPluginId.get(pluginId)).toEqual(new Set(['network']));
        expect(activated.trustedOptionalPermissionsByPluginId.get(pluginId)).toEqual(
            new Set(['env', 'network', 'reviews.comments.write.direct']),
        );
        expect(activated.permissionsByPluginId.get(pluginId)).toEqual(
            new Set(['env', 'network', 'reviews.comments.write.direct']),
        );
        expect(activated.networkAllowedUrlOriginsByPluginId.get(pluginId)).toEqual(
            new Set(['https://required.example.test', 'https://optional.example.test']),
        );
        expect(activated.envAllowedNamesByPluginId.get(pluginId)).toEqual(new Set(['HAPPIER_OPTIONAL_TOKEN']));
        expect(activated.processSpawnAllowedPathsByPluginId.get(pluginId)).toBeUndefined();
    });

    it('keeps project-scoped trusted grants out of global activation permissions', async () => {
        const pluginId = 'acme.optional.project.global-deny';
        const { manifestPath, daemonEntryPath } = await writePlugin({
            pluginId,
            optionalPermissions: [
                { capability: 'env', scope: 'HAPPIER_PROJECT_TOKEN' },
            ],
        });

        const activated = await activatePluginRuntimeRegistry({
            contributes: createContributes({ pluginId, manifestPath, daemonEntryPath }),
            generation: 5,
            resolveTrustedOptionalPermissionGrants: async () => [
                createGrant({ pluginId, capability: 'env' }),
            ],
        }) as RuntimeRegistryWithGrantMaps;

        expect(activated.trustedOptionalPermissionsByPluginId.get(pluginId)).toEqual(new Set());
        expect(activated.permissionsByPluginId.get(pluginId)).toEqual(new Set());
        expect(activated.envAllowedNamesByPluginId.get(pluginId)).toBeUndefined();
    });

    it('fails closed when the only matching optional grant is revoked', async () => {
        const pluginId = 'acme.optional.revoked';
        const { manifestPath, daemonEntryPath } = await writePlugin({
            pluginId,
            optionalPermissions: [
                { capability: 'env', scope: 'HAPPIER_REVOKED_TOKEN' },
            ],
        });

        const activated = await activatePluginRuntimeRegistry({
            contributes: createContributes({ pluginId, manifestPath, daemonEntryPath }),
            generation: 3,
            resolveTrustedOptionalPermissionGrants: async () => [
                createGrant({ pluginId, capability: 'env', status: 'revoked' }),
            ],
        }) as RuntimeRegistryWithGrantMaps;

        expect(activated.trustedOptionalPermissionsByPluginId.get(pluginId)).toEqual(new Set());
        expect(activated.permissionsByPluginId.get(pluginId)).toEqual(new Set());
        expect(activated.envAllowedNamesByPluginId.get(pluginId)).toBeUndefined();
    });

    it('uses trusted optional grants for activation-time API permission checks', async () => {
        const pluginId = 'acme.optional.activation';
        const actionId = 'acme.optional.activation.action';
        const { manifestPath, daemonEntryPath } = await writePlugin({
            pluginId,
            runtimeCapabilities: ['actions'],
            optionalPermissions: [{ capability: 'actions.register' }],
            actionIds: [actionId],
            daemonSource: [
                'export async function activate(api) {',
                '  api.registerAction({',
                `    id: ${JSON.stringify(actionId)},`,
                '    title: "Optional activation action",',
                '    surface: "cli",',
                '    handler: async () => "ok",',
                '  });',
                '}',
                '',
            ].join('\n'),
        });

        const activated = await activatePluginRuntimeRegistry({
            contributes: createContributes({ pluginId, manifestPath, daemonEntryPath }),
            generation: 4,
            resolveTrustedOptionalPermissionGrants: async () => [
                {
                    ...createGrant({ pluginId, capability: 'actions.register' }),
                    targetScope: { kind: 'account' },
                },
            ],
        });

        expect(activated.pluginDiagnosticsByPluginId[pluginId]).toEqual([]);
        expect(activated.actions).toEqual([
            expect.objectContaining({
                pluginId,
                definition: expect.objectContaining({ id: actionId }),
            }),
        ]);
        expect(activated.trustedOptionalPermissionsByPluginId.get(pluginId)).toEqual(
            new Set(['actions.register']),
        );
    });
});
