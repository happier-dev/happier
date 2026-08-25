import {
    PluginProjectionInstalledPackageV2Schema,
} from '@happier-dev/protocol';
import {
    PluginUiArtifactDigestV1Schema,
    type PluginUiArtifactDigestV1,
} from '@happier-dev/protocol/plugins/ui';
import {
    createPackageAssetArchiveV1,
    openPackageAssetArchiveV1,
    type PackageAssetArchiveOpenedV1,
} from '@happier-dev/protocol/plugins/availability';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createValidPluginBrandPngFixture, renderHook } from '@/dev/testkit';
import { HAPPIER_MAX_RENDERABLE_IMAGE_PIXELS } from '@happier-dev/plugin-ui/advanced';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { MachinePluginUiResourceReadResult } from '@/sync/ops/machineContributionRegistryProjection';
import type {
    PluginAccountAvailabilityPackageAssetAdmission,
    PluginAccountAvailabilityReader,
} from '@/sync/domains/plugins/availability/reader';
import type {
    PluginProtectedAccountPackageAssetSource,
} from '@/sync/domains/plugins/availability/packageAssetLease';

const rpc = vi.hoisted(() => ({
    read: vi.fn(),
}));

// The daemon RPC is the only substituted boundary. The adapter and contextual
// Resource client remain real so this proves the exact host-stamped request.
vi.mock('@/sync/ops/machineContributionRegistryProjection', () => ({
    machinePluginUiResourceRead: rpc.read,
    machinePluginSecretStatus: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSecretSet: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSecretDelete: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
}));

import {
    readInstalledPluginBrandPresentation,
    useInstalledPluginBrandPresentation,
} from './installedPluginBrandPresentation';

const PLUGIN_ID = 'acme.brand';
const BRAND_RESOURCE = Object.freeze({ pluginId: PLUGIN_ID, localId: 'assets/brand' });
const BRAND_DIGEST = PluginUiArtifactDigestV1Schema.parse(`sha256:${'b'.repeat(64)}`);

function portablePackageAssets(input: Readonly<{
    bytes?: Uint8Array;
    resourceId?: string;
}> = {}) {
    const bytes = input.bytes ?? createValidPluginBrandPngFixture();
    const archive = createPackageAssetArchiveV1({
        manifest: {
            schemaVersion: 2,
            id: PLUGIN_ID,
            version: '1.0.0',
            displayName: 'Acme Brand',
            engines: { happier: '^1.0.0' },
            runtime: { apiVersion: 1 },
            contributes: {
                resources: [{
                    id: input.resourceId ?? BRAND_RESOURCE.localId,
                    kind: 'asset',
                    path: 'assets/brand.png',
                    contentType: 'image/png',
                }],
            },
        },
        files: [{ path: 'assets/brand.png', bytes }],
    });
    if (!archive) throw new Error('Expected portable Package Asset archive.');
    const opened = openPackageAssetArchiveV1({
        expectedDescriptor: archive.descriptor,
        header: archive.header,
        body: archive.body,
    });
    if (!opened) throw new Error('Expected opened portable Package Asset archive.');
    let admission: PluginAccountAvailabilityPackageAssetAdmission = Object.freeze({
        kind: 'available',
        availabilityCursor: 42,
        packageAsset: Object.freeze({
            pluginId: PLUGIN_ID,
            releaseVersion: '1.0.0',
            descriptor: archive.descriptor,
        }),
    });
    const reader: Pick<PluginAccountAvailabilityReader, 'readCurrentPackageAsset' | 'subscribe'> = Object.freeze({
        readCurrentPackageAsset: () => admission,
        subscribe: () => () => undefined,
    });
    const source: PluginProtectedAccountPackageAssetSource = Object.freeze({
        readArchive: vi.fn(async (): Promise<PackageAssetArchiveOpenedV1> => opened),
    });
    return Object.freeze({
        packageAssets: Object.freeze({ reader, source }),
        source,
        digest: archive.descriptor.resources[0]!.digestSha256,
        withdraw() {
            admission = Object.freeze({ kind: 'unavailable', code: 'artifact_not_current' });
        },
    });
}

function installedPackage(input: Readonly<{
    enabled?: boolean;
    brand?: unknown;
}> = {}) {
    return PluginProjectionInstalledPackageV2Schema.parse({
        id: PLUGIN_ID,
        displayName: 'Acme Brand',
        version: '1.0.0',
        enabled: input.enabled ?? true,
        source: { kind: 'localPath', locator: PLUGIN_ID },
        ...(input.brand === undefined
            ? {}
            : { brand: input.brand }),
    });
}

function availableBrand(input: Readonly<{
    digest?: PluginUiArtifactDigestV1;
    pluginId?: string;
}> = {}) {
    return {
        state: 'available' as const,
        resource: {
            pluginId: input.pluginId ?? PLUGIN_ID,
            localId: BRAND_RESOURCE.localId,
        },
        width: 128,
        height: 128,
        digest: input.digest ?? BRAND_DIGEST,
    };
}

function createLifetime() {
    let current = true;
    const listeners = new Set<() => void>();
    const lifetime: ActiveServerAccountScopeLifetime = Object.freeze({
        scope: { serverId: 'server-a', accountId: 'account-a' },
        isCurrent: () => current,
        onRetire: (listener) => {
            listeners.add(listener);
            return Object.freeze({ dispose: () => listeners.delete(listener) });
        },
    });
    return Object.freeze({
        lifetime,
        retire() {
            current = false;
            for (const listener of [...listeners]) listener();
        },
    });
}

function brandReadResult(input: Readonly<{
    contentType?: string;
    digest?: PluginUiArtifactDigestV1;
    bytes?: Uint8Array;
    resource?: Readonly<{ pluginId: string; localId: string }>;
}> = {}): MachinePluginUiResourceReadResult {
    return {
        supported: true,
        result: {
            ok: true,
            resource: input.resource ?? BRAND_RESOURCE,
            kind: 'asset',
            contentType: input.contentType ?? 'image/png',
            digest: input.digest ?? BRAND_DIGEST,
            bytesBase64: Buffer.from(input.bytes ?? createValidPluginBrandPngFixture()).toString('base64'),
        },
    };
}

function readInput(input: Readonly<{
    accountLifetime?: ActiveServerAccountScopeLifetime | null;
    expectedGeneration?: string | number | null;
    machineId?: string | null;
    installedPackage?: ReturnType<typeof installedPackage> | null;
    isCurrent?: () => boolean;
    packageAssets?: ReturnType<typeof portablePackageAssets>['packageAssets'] | null;
    signal?: AbortSignal;
}> = {}) {
    return {
        installedPackage: input.installedPackage === undefined
            ? installedPackage({ brand: availableBrand() })
            : input.installedPackage,
        machineId: input.machineId === undefined ? 'machine-a' : input.machineId,
        serverId: 'server-a',
        expectedGeneration: input.expectedGeneration ?? 7,
        signal: input.signal ?? new AbortController().signal,
        accountLifetime: input.accountLifetime ?? createLifetime().lifetime,
        isCurrent: input.isCurrent ?? (() => true),
        ...(input.packageAssets !== undefined ? { packageAssets: input.packageAssets } : {}),
    };
}

describe('installed package brand presentation', () => {
    beforeEach(() => {
        rpc.read.mockReset();
    });

    it('reads the admitted same-plugin PNG through the canonical contextual Resource authority', async () => {
        rpc.read.mockResolvedValue(brandReadResult());

        await expect(readInstalledPluginBrandPresentation(readInput())).resolves.toEqual({
            displayName: 'Acme Brand',
            bytes: createValidPluginBrandPngFixture(),
        });
        expect(rpc.read).toHaveBeenCalledWith('machine-a', expect.objectContaining({
            serverId: 'server-a',
            expectedGeneration: '7',
            callerPluginId: PLUGIN_ID,
            resource: BRAND_RESOURCE,
        }));
    });

    it('reads a portable brand only through its Availability-selected Package Asset lease', async () => {
        const portable = portablePackageAssets();

        await expect(readInstalledPluginBrandPresentation(readInput({
            machineId: null,
            expectedGeneration: null,
            packageAssets: portable.packageAssets,
            installedPackage: installedPackage({ brand: availableBrand({ digest: portable.digest }) }),
        }))).resolves.toEqual({
            displayName: 'Acme Brand',
            bytes: createValidPluginBrandPngFixture(),
        });
        expect(portable.source.readArchive).toHaveBeenCalledTimes(1);
        expect(rpc.read).not.toHaveBeenCalled();
    });

    it('retains the canonical text fallback when the portable descriptor cannot resolve its brand Resource id', async () => {
        const portable = portablePackageAssets({ resourceId: 'different-resource' });

        await expect(readInstalledPluginBrandPresentation(readInput({
            packageAssets: portable.packageAssets,
            installedPackage: installedPackage({ brand: availableBrand({ digest: portable.digest }) }),
        }))).resolves.toEqual({ displayName: 'Acme Brand' });
        expect(portable.source.readArchive).not.toHaveBeenCalled();
        expect(rpc.read).not.toHaveBeenCalled();
    });

    it('does not fall through to a daemon Resource read when the portable Account source is unavailable', async () => {
        await expect(readInstalledPluginBrandPresentation(readInput({
            packageAssets: null,
        }))).resolves.toEqual({ displayName: 'Acme Brand' });
        expect(rpc.read).not.toHaveBeenCalled();
    });

    it('uses daemon Resource reads only for local-path packages', async () => {
        await expect(readInstalledPluginBrandPresentation(readInput({
            installedPackage: PluginProjectionInstalledPackageV2Schema.parse({
                id: PLUGIN_ID,
                displayName: 'Acme Brand',
                version: '1.0.0',
                enabled: true,
                source: { kind: 'bundled', locator: PLUGIN_ID },
                brand: availableBrand(),
            }),
        }))).resolves.toEqual({ displayName: 'Acme Brand' });
        expect(rpc.read).not.toHaveBeenCalled();
    });

    it('keeps a current package name but never exposes mismatched, non-PNG, or unreadable brand bytes', async () => {
        await expect(readInstalledPluginBrandPresentation(readInput({
            installedPackage: installedPackage({
                brand: availableBrand({ pluginId: 'other.plugin' }),
            }),
        }))).resolves.toEqual({ displayName: 'Acme Brand' });
        expect(rpc.read).not.toHaveBeenCalled();

        rpc.read.mockResolvedValue(brandReadResult({
            digest: PluginUiArtifactDigestV1Schema.parse(`sha256:${'c'.repeat(64)}`),
        }));
        await expect(readInstalledPluginBrandPresentation(readInput())).resolves.toEqual({ displayName: 'Acme Brand' });

        rpc.read.mockResolvedValue(brandReadResult({ contentType: 'image/svg+xml' }));
        await expect(readInstalledPluginBrandPresentation(readInput())).resolves.toEqual({ displayName: 'Acme Brand' });
    });

    it('keeps the neutral text identity when the shared image owner refuses the mark', async () => {
        // A canvas past the decode ceiling in a payload the byte ceiling admits.
        // The canonical brand Resource owner already enforces stricter bounds,
        // so this states the host's own outcome: never a broken or converted
        // render, always the package's projection-owned name.
        const side = Math.ceil(Math.sqrt(HAPPIER_MAX_RENDERABLE_IMAGE_PIXELS)) + 1;
        const oversized = createValidPluginBrandPngFixture();
        new DataView(oversized.buffer).setUint32(16, side);
        new DataView(oversized.buffer).setUint32(20, side);
        rpc.read.mockResolvedValue(brandReadResult({ bytes: oversized }));

        await expect(readInstalledPluginBrandPresentation(readInput()))
            .resolves.toEqual({ displayName: 'Acme Brand' });
    });

    it('uses the neutral fallback for an absent brand or a daemon-stale generation', async () => {
        await expect(readInstalledPluginBrandPresentation(readInput({
            installedPackage: installedPackage({ brand: { state: 'missing' } }),
        }))).resolves.toEqual({ displayName: 'Acme Brand' });
        expect(rpc.read).not.toHaveBeenCalled();

        rpc.read.mockResolvedValue({
            supported: true,
            result: {
                ok: false,
                code: 'plugin_generation_stale',
                reason: 'stale_generation',
            },
        } satisfies MachinePluginUiResourceReadResult);
        await expect(readInstalledPluginBrandPresentation(readInput())).resolves.toEqual({ displayName: 'Acme Brand' });
    });

    it('withholds presentation without starting a byte read once admission or Account currentness is absent', async () => {
        const retired = createLifetime();
        retired.retire();

        await expect(readInstalledPluginBrandPresentation(readInput({
            installedPackage: installedPackage({ enabled: false, brand: availableBrand() }),
        }))).resolves.toBeNull();
        await expect(readInstalledPluginBrandPresentation(readInput({ installedPackage: null }))).resolves.toBeNull();
        await expect(readInstalledPluginBrandPresentation(readInput({ accountLifetime: retired.lifetime }))).resolves.toBeNull();
        await expect(readInstalledPluginBrandPresentation(readInput({ isCurrent: () => false }))).resolves.toBeNull();
        expect(rpc.read).not.toHaveBeenCalled();
    });

    it('discards bytes returned after its Account lifetime retires', async () => {
        const lifetime = createLifetime();
        rpc.read.mockImplementation(async () => {
            lifetime.retire();
            return brandReadResult();
        });

        await expect(readInstalledPluginBrandPresentation(readInput({
            accountLifetime: lifetime.lifetime,
        }))).resolves.toBeNull();
    });

    it('discards bytes returned after its captured request signal aborts', async () => {
        const abortController = new AbortController();
        rpc.read.mockImplementation(async () => {
            abortController.abort();
            return brandReadResult();
        });

        await expect(readInstalledPluginBrandPresentation(readInput({
            signal: abortController.signal,
        }))).resolves.toBeNull();
    });

    it('discards bytes returned after its caller scope is no longer current', async () => {
        let current = true;
        rpc.read.mockImplementation(async () => {
            current = false;
            return brandReadResult();
        });

        await expect(readInstalledPluginBrandPresentation(readInput({
            isCurrent: () => current,
        }))).resolves.toBeNull();
    });

    it('clears an already-mounted mark when the captured Account retires', async () => {
        const lifetime = createLifetime();
        rpc.read.mockResolvedValue(brandReadResult());
        const input = readInput({ accountLifetime: lifetime.lifetime });

        const hook = await renderHook(() => useInstalledPluginBrandPresentation(input));
        expect(hook.getCurrent()).toEqual({
            displayName: 'Acme Brand',
            bytes: createValidPluginBrandPngFixture(),
        });
        expect(rpc.read).toHaveBeenCalledTimes(1);

        await act(async () => {
            lifetime.retire();
        });
        expect(hook.getCurrent()).toBeNull();
        await hook.unmount();
    });

    it('clears an already-mounted mark when its captured request signal aborts', async () => {
        const abortController = new AbortController();
        rpc.read.mockResolvedValue(brandReadResult());
        const input = readInput({ signal: abortController.signal });

        const hook = await renderHook(() => useInstalledPluginBrandPresentation(input));
        expect(hook.getCurrent()).toEqual({
            displayName: 'Acme Brand',
            bytes: createValidPluginBrandPngFixture(),
        });

        await act(async () => {
            abortController.abort();
        });
        expect(hook.getCurrent()).toBeNull();
        await hook.unmount();
    });

    it('adopts a new target, generation, and Account lifetime before publishing that target\'s bytes', async () => {
        const targetPluginId = 'acme.next-brand';
        const targetResource = Object.freeze({ pluginId: targetPluginId, localId: 'assets/brand' });
        const targetPackage = PluginProjectionInstalledPackageV2Schema.parse({
            id: targetPluginId,
            displayName: 'Next Brand',
            version: '2.0.0',
            enabled: true,
            source: { kind: 'localPath', locator: targetPluginId },
            brand: {
                state: 'available',
                resource: targetResource,
                width: 128,
                height: 128,
                digest: BRAND_DIGEST,
            },
        });
        let resolveFirst!: (result: MachinePluginUiResourceReadResult) => void;
        let resolveSecond!: (result: MachinePluginUiResourceReadResult) => void;
        const firstRead = new Promise<MachinePluginUiResourceReadResult>((resolve) => {
            resolveFirst = resolve;
        });
        const secondRead = new Promise<MachinePluginUiResourceReadResult>((resolve) => {
            resolveSecond = resolve;
        });
        const pendingReads = [firstRead, secondRead];
        rpc.read.mockImplementation(() => {
            const next = pendingReads.shift();
            if (!next) throw new Error('Unexpected brand Resource read');
            return next;
        });

        const firstLifetime = createLifetime();
        const secondLifetime = createLifetime();
        const firstAbortController = new AbortController();
        const secondAbortController = new AbortController();
        const hook = await renderHook(
            (input) => useInstalledPluginBrandPresentation(input),
            {
                initialProps: readInput({
                    accountLifetime: firstLifetime.lifetime,
                    signal: firstAbortController.signal,
                }),
            },
        );

        await hook.rerender(readInput({
            installedPackage: targetPackage,
            expectedGeneration: 8,
            accountLifetime: secondLifetime.lifetime,
            signal: secondAbortController.signal,
        }));
        expect(hook.getCurrent()).toEqual({ displayName: 'Next Brand' });

        await act(async () => {
            resolveFirst(brandReadResult());
            await Promise.resolve();
        });
        expect(hook.getCurrent()).toEqual({ displayName: 'Next Brand' });

        await act(async () => {
            resolveSecond(brandReadResult({
                resource: targetResource,
                bytes: createValidPluginBrandPngFixture(),
            }));
            await Promise.resolve();
        });
        expect(hook.getCurrent()).toEqual({
            displayName: 'Next Brand',
            bytes: createValidPluginBrandPngFixture(),
        });
        await hook.unmount();
    });
});
