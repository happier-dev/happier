import {
    PluginProjectionInstalledPackageV2Schema,
} from '@happier-dev/protocol';
import { BUNDLED_AGENT_CONTRIBUTION_IDENTITIES } from '@happier-dev/agents/agent-ids';
import {
    PluginUiArtifactDigestV1Schema,
    type PluginUiArtifactDigestV1,
} from '@happier-dev/protocol/plugins/ui';
import {
    createPackageAssetArchiveV1,
    openPackageAssetArchiveV1,
    type PackageAssetArchiveOpenedV1,
} from '@happier-dev/protocol/plugins/availability';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { subscribeHomeCredentialChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { activateStorageAccountScope } from '@/dev/testkit/mocks/storage';

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
const bundledBrands = vi.hoisted(() => [] as { pluginId: string; resourceId: string; releaseVersion: string; displayName: string; digest: string; bytes: Uint8Array }[]);
// Packaged inventory bytes are the app/Expo asset boundary; admission stays real.
vi.mock('@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts', () => ({
    BUNDLED_PLUGIN_UI_APP_ARTIFACTS: [],
    BUNDLED_PLUGIN_UI_APP_DECLARATIONS: [],
    BUNDLED_PLUGIN_BRAND_MARKS: bundledBrands,
}));
installTokenStorageWebPlatformMocks();

// These reads use the supplied RPC/Account sources, never a live socket client.
vi.mock('@/sync/api/session/apiSocket', () => ({ apiSocket: { request: vi.fn() } }));

// The daemon RPC is the only substituted boundary. The adapter and contextual
// Resource client remain real so this proves the exact host-stamped request.
vi.mock('@/sync/ops/machineContributionRegistryProjection', () => ({
    machinePluginUiResourceRead: rpc.read,
    machinePluginSecretStatus: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSecretSet: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSecretDelete: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSettingsGet: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSettingsSet: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
}));

import {
    readInstalledPluginBrandPresentation,
    useBundledPluginBrandPresentation,
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
        opened,
        digest: archive.descriptor.resources[0]!.digestSha256,
        withdraw() {
            admission = Object.freeze({ kind: 'unavailable', code: 'artifact_not_current' });
        },
    });
}

function installedPackage(input: Readonly<{
    enabled?: boolean;
    brand?: unknown;
    occurrenceId?: string;
}> = {}) {
    return PluginProjectionInstalledPackageV2Schema.parse({
        id: PLUGIN_ID,
        displayName: 'Acme Brand',
        version: '1.0.0',
        enabled: input.enabled ?? true,
        occurrenceId: input.occurrenceId ?? 'brand-occurrence-7',
        source: { kind: 'localPath', locator: PLUGIN_ID },
        ...(input.brand === undefined
            ? {}
            : { brand: input.brand }),
    });
}

function availableBrand(input: Readonly<{
    digest?: PluginUiArtifactDigestV1;
    pluginId?: string;
    monochrome?: boolean;
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
        ...(input.monochrome === undefined ? {} : { monochrome: input.monochrome }),
    };
}

function createLifetime(scope: ActiveServerAccountScopeLifetime['scope'] = { serverId: 'server-a', accountId: 'account-a' }) {
    let current = true;
    const listeners = new Set<() => void>();
    const lifetime: ActiveServerAccountScopeLifetime = Object.freeze({
        scope,
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
        signal: input.signal ?? new AbortController().signal,
        accountLifetime: input.accountLifetime ?? createLifetime().lifetime,
        isCurrent: input.isCurrent ?? (() => true),
        ...(input.packageAssets !== undefined ? { packageAssets: input.packageAssets } : {}),
    };
}

describe('installed package brand presentation', () => {
    let browserStorage: ReturnType<typeof installLocalStorageMock>;
    beforeEach(() => {
        rpc.read.mockReset();
        bundledBrands.splice(0, bundledBrands.length, {
            pluginId: 'happier.inspector', resourceId: 'brand-icon', releaseVersion: '0.0.0',
            displayName: 'Inspector', digest: `sha256:${'b'.repeat(64)}`, bytes: createValidPluginBrandPngFixture(),
        });
        browserStorage = installLocalStorageMock();
    });
    afterEach(() => browserStorage.restore());

    it.each(['claude', 'codex', 'coderabbit'] as const)('keeps the same admitted %s mark in flat and by-kind installed views', async (agentId) => {
        const pluginId = BUNDLED_AGENT_CONTRIBUTION_IDENTITIES[agentId].pluginId;
        const input = readInput({
            installedPackage: PluginProjectionInstalledPackageV2Schema.parse({
                id: pluginId, displayName: agentId, version: '0.0.0', enabled: true,
                source: { kind: 'bundled', locator: pluginId },
            }),
            machineId: null,
        });
        // The flat path has no Machine projection; the by-kind path carries its installed package.
        const hook = await renderHook(() => ({
            flat: useBundledPluginBrandPresentation(pluginId, agentId, agentId),
            byKind: useInstalledPluginBrandPresentation(input),
        }));
        try {
            const { flat, byKind } = hook.getCurrent();
            expect(flat?.light).toBeDefined();
            expect(byKind?.light).toBe(flat?.light);
            expect(byKind?.dark).toBe(flat?.dark);
            expect(byKind?.bytes).toBe(flat?.bytes);
            expect(byKind?.monochrome).toBe(flat?.monochrome);
            expect(rpc.read).not.toHaveBeenCalled();
        } finally {
            await hook.unmount();
        }
    });

    it('admits bundled artwork in the mount commit without waiting for an asynchronous resource read', () => {
        const input = readInput({
            installedPackage: PluginProjectionInstalledPackageV2Schema.parse({
                id: 'happier.inspector', displayName: 'Inspector', version: '0.0.0', enabled: true,
                source: { kind: 'bundled', locator: '@happier-dev/plugins-inspector' },
            }),
        });
        let presentation: ReturnType<typeof useInstalledPluginBrandPresentation> = null;
        function Probe() {
            presentation = useInstalledPluginBrandPresentation(input);
            return null;
        }
        // A synchronous commit is intentional: bundled assets have no asynchronous boundary.
        let tree: ReactTestRenderer | undefined;
        try {
            act(() => { tree = create(createElement(Probe)); });
            expect(presentation).toMatchObject({ displayName: 'Inspector', bytes: createValidPluginBrandPngFixture() });
            expect(rpc.read).not.toHaveBeenCalled();
        } finally {
            act(() => tree?.unmount());
        }
    });

    it('updates every cold consumer when a sibling admits their shared bundled mark', () => {
        const seen: Array<ReturnType<typeof useBundledPluginBrandPresentation>> = [null, null];
        function Probe({ slot }: { slot: number }) {
            seen[slot] = useBundledPluginBrandPresentation('happier.inspector', 'Concurrent Inspector');
            return null;
        }
        let tree: ReactTestRenderer | undefined;
        try {
            act(() => { tree = create(createElement('probes', null,
                createElement(Probe, { slot: 0 }), createElement(Probe, { slot: 1 }))); });
            expect(seen[0]?.bytes).toEqual(createValidPluginBrandPngFixture());
            expect(seen[1]).toBe(seen[0]);
            expect(rpc.read).not.toHaveBeenCalled();
        } finally {
            act(() => tree?.unmount());
        }
    });

    it('draws a bundled mark that was admitted before on the first render of its next mount, never its text identity first', () => {
        const rendered: Array<ReturnType<typeof useBundledPluginBrandPresentation>> = [];
        function Probe() {
            rendered.push(useBundledPluginBrandPresentation('happier.inspector', 'Inspector'));
            return null;
        }
        const mountOnce = () => {
            rendered.length = 0;
            let tree: ReactTestRenderer | undefined;
            act(() => { tree = create(createElement(Probe)); });
            act(() => tree?.unmount());
            return [...rendered];
        };
        // Admission is off the render path, so the first-ever mount commits without the mark and then receives it.
        const first = mountOnce();
        expect(first[0]).toBeNull();
        expect(first.at(-1)).toMatchObject({ displayName: 'Inspector' });
        const second = mountOnce();
        expect(second[0]).toMatchObject({ displayName: 'Inspector' });
        // A remount of an admitted mark is one render of the same mark: no second admission, no new
        // identity for the image below it (a list returning or switching tabs remounts every row).
        expect(second).toHaveLength(1);
        expect(second[0]).toBe(first.at(-1));
    });

    it.each(['server-a', 'other-home'])('uses only the already-applied Home lifetime for immediate brand admission (%s)', async (serverId) => {
        const active = await activateStorageAccountScope({ serverId: 'server-a', accountId: 'account-a' });
        const { useServerInstalledPluginBrand } = await import('@/components/settings/plugins/PluginMark');
        const seen: Array<ReturnType<typeof useServerInstalledPluginBrand>> = [];
        const input = {
            installedPackage: installedPackage({ brand: { state: 'missing' } }),
            machineId: 'machine-a',
            serverId,
        };
        const hook = await renderHook(() => {
            const presentation = useServerInstalledPluginBrand(input);
            seen.push(presentation);
            return presentation;
        });
        try {
            expect(seen[0]).toEqual(serverId === 'server-a' ? { displayName: 'Acme Brand' } : null);
            await act(async () => active.dispose());
            expect(hook.getCurrent()).toBeNull();
        } finally {
            await hook.unmount();
            active.dispose();
        }
    });

    it('admits bundled non-Agent marks through the same owner without Account archive or daemon reads', async () => {
        const bundledPackage = PluginProjectionInstalledPackageV2Schema.parse({
            id: 'happier.inspector', displayName: 'Inspector', version: '0.0.0', enabled: true,
            source: { kind: 'bundled', locator: '@happier-dev/plugins-inspector' },
            brand: { ...availableBrand(), resource: { pluginId: 'happier.inspector', localId: 'brand-icon' } },
        });
        const brand = await readInstalledPluginBrandPresentation(readInput({
            installedPackage: bundledPackage, machineId: null, packageAssets: null,
        }));
        expect(brand?.bytes).toEqual(createValidPluginBrandPngFixture());
        expect(rpc.read).not.toHaveBeenCalled();
        expect((await readInstalledPluginBrandPresentation(readInput({
            installedPackage: { ...bundledPackage, brand: {
                ...availableBrand({ pluginId: 'happier.inspector', digest: `sha256:${'c'.repeat(64)}` }),
                resource: { pluginId: 'happier.inspector', localId: 'brand-icon' },
            } },
            machineId: null, packageAssets: null,
        })))?.bytes).toBeUndefined();
    });

    it('uses the real active Account lifetime for distinct admitted view lifetimes and rereads after its retirement', async () => {
        const active = await activateStorageAccountScope({ serverId: 'server-a', accountId: 'account-a' });
        const firstView = createLifetime();
        const secondView = createLifetime();
        rpc.read.mockResolvedValue(brandReadResult());
        try {
            const first = await readInstalledPluginBrandPresentation(readInput({ accountLifetime: firstView.lifetime }));
            firstView.retire();
            expect(await readInstalledPluginBrandPresentation(readInput({ accountLifetime: secondView.lifetime }))).toBe(first);
            expect(rpc.read).toHaveBeenCalledTimes(1);
        } finally {
            active.dispose();
        }
        const remountedAccount = await activateStorageAccountScope({ serverId: 'server-a', accountId: 'account-a' });
        try {
            await readInstalledPluginBrandPresentation(readInput({ accountLifetime: createLifetime().lifetime }));
            expect(rpc.read).toHaveBeenCalledTimes(2);
        } finally {
            remountedAccount.dispose();
        }
    });

    it('never reuses routed marks across a Home or Account, or accepts a contradictory credential scope', async () => {
        rpc.read.mockResolvedValue(brandReadResult());
        const first = createLifetime();
        const otherAccount = createLifetime({ serverId: 'server-a', accountId: 'account-b' });
        const otherHome = createLifetime({ serverId: 'server-b', accountId: 'account-a' });
        for (const bound of [first, otherAccount, otherHome]) {
            expect((await readInstalledPluginBrandPresentation({
                ...readInput({ accountLifetime: bound.lifetime }), serverId: bound.lifetime.scope.serverId,
                credentialAccountScope: bound.lifetime.scope,
            }))?.bytes).toEqual(createValidPluginBrandPngFixture());
        }
        expect(rpc.read).toHaveBeenCalledTimes(3);
        await expect(readInstalledPluginBrandPresentation({
            ...readInput({ accountLifetime: otherAccount.lifetime }), credentialAccountScope: first.lifetime.scope,
        })).resolves.toBeNull();
        await expect(readInstalledPluginBrandPresentation({
            ...readInput({ accountLifetime: otherHome.lifetime }), credentialAccountScope: otherHome.lifetime.scope,
        })).resolves.toBeNull();
        expect(rpc.read).toHaveBeenCalledTimes(3);
        for (const serverId of ['server-a', 'server-b']) {
            expect(await TokenStorage.setCredentialsForServerUrl(`https://brand-${serverId}.test`, { serverId }, { token: 'replacement' })).toBe(true);
        }
    });

    it('shares routed Account marks across distinct view lifetimes until real Home credentials change', async () => {
        const homeUrl = 'https://brand-home.test';
        const firstLifetime = createLifetime();
        const secondLifetime = createLifetime();
        const firstController = new AbortController();
        let resolveRead!: (result: MachinePluginUiResourceReadResult) => void;
        let producerSignal: AbortSignal | undefined;
        rpc.read.mockImplementation((_machine, options: { signal?: AbortSignal }) => {
            producerSignal = options.signal;
            return new Promise<MachinePluginUiResourceReadResult>((resolve) => { resolveRead = resolve; });
        });
        const routedInput = (lifetime: ReturnType<typeof createLifetime>, signal = new AbortController().signal) => ({
            ...readInput({ accountLifetime: lifetime.lifetime, signal }),
            credentialAccountScope: lifetime.lifetime.scope,
        });
        const first = readInstalledPluginBrandPresentation(routedInput(firstLifetime, firstController.signal));
        const second = readInstalledPluginBrandPresentation(routedInput(secondLifetime));
        expect(rpc.read).toHaveBeenCalledTimes(1);
        firstController.abort();
        firstLifetime.retire();
        await expect(first).resolves.toBeNull();
        expect(producerSignal?.aborted).toBe(false);
        resolveRead(brandReadResult());
        const presentation = await second;
        expect(presentation?.bytes).toEqual(createValidPluginBrandPngFixture());
        secondLifetime.retire();
        expect(await readInstalledPluginBrandPresentation(routedInput(createLifetime()))).toBe(presentation);
        expect(rpc.read).toHaveBeenCalledTimes(1);

        // This is the real credential writer/fanout, only browser persistence
        // and the daemon RPC are substituted system boundaries.
        expect(await TokenStorage.setCredentialsForServerUrl(homeUrl, { serverId: 'server-a' }, { token: 'replacement-account-token' })).toBe(true);
        rpc.read.mockResolvedValue(brandReadResult());
        await readInstalledPluginBrandPresentation(routedInput(createLifetime()));
        expect(rpc.read).toHaveBeenCalledTimes(2);

        const pendingLifetime = createLifetime();
        const retireBinding = subscribeHomeCredentialChange((event) => {
            if (event.serverId === 'server-a') pendingLifetime.retire();
        });
        const replacementPackage = installedPackage({ brand: availableBrand(), occurrenceId: 'pending-replacement' });
        rpc.read.mockImplementation((_machine, options: { signal?: AbortSignal }) => {
            producerSignal = options.signal;
            return new Promise<MachinePluginUiResourceReadResult>((resolve) => { resolveRead = resolve; });
        });
        const pending = readInstalledPluginBrandPresentation({ ...routedInput(pendingLifetime), installedPackage: replacementPackage });
        expect(producerSignal?.aborted).toBe(false);
        expect(await TokenStorage.removeCredentialsForServerUrl(homeUrl, { serverId: 'server-a' })).toBe(true);
        expect(producerSignal?.aborted).toBe(true);
        resolveRead(brandReadResult());
        await expect(pending).resolves.toBeNull();
        retireBinding();
    });

    it('shares pending and settled marks across views without borrowing a view cancellation lifetime', async () => {
        const lifetime = createLifetime();
        const firstController = new AbortController();
        let resolveRead!: (result: MachinePluginUiResourceReadResult) => void;
        rpc.read.mockImplementation(() => new Promise<MachinePluginUiResourceReadResult>((resolve) => { resolveRead = resolve; }));
        const first = readInstalledPluginBrandPresentation(readInput({ accountLifetime: lifetime.lifetime, signal: firstController.signal }));
        const second = readInstalledPluginBrandPresentation(readInput({ accountLifetime: lifetime.lifetime }));
        expect(rpc.read).toHaveBeenCalledTimes(1);
        firstController.abort();
        await expect(first).resolves.toBeNull();
        resolveRead(brandReadResult());
        const presentation = await second;
        expect(presentation?.bytes).toEqual(createValidPluginBrandPngFixture());
        expect(await readInstalledPluginBrandPresentation(readInput({ accountLifetime: lifetime.lifetime }))).toBe(presentation);
        expect(rpc.read).toHaveBeenCalledTimes(1);
        lifetime.retire();
        await expect(readInstalledPluginBrandPresentation(readInput({ accountLifetime: lifetime.lifetime }))).resolves.toBeNull();
        rpc.read.mockResolvedValue(brandReadResult());
        await readInstalledPluginBrandPresentation(readInput());
        expect(rpc.read).toHaveBeenCalledTimes(2);
    });

    it('shares mounted hook marks and rereads a replacement package occurrence', async () => {
        const lifetime = createLifetime();
        rpc.read.mockResolvedValue(brandReadResult());
        const firstInput = readInput({ accountLifetime: lifetime.lifetime });
        const secondInput = readInput({ accountLifetime: lifetime.lifetime });
        const first = await renderHook(() => useInstalledPluginBrandPresentation(firstInput));
        const second = await renderHook(() => useInstalledPluginBrandPresentation(secondInput));
        expect(second.getCurrent()?.bytes).toEqual(first.getCurrent()?.bytes);
        expect(rpc.read).toHaveBeenCalledTimes(1);
        await first.unmount();
        await second.unmount();
        const remounted = await renderHook(() => useInstalledPluginBrandPresentation(firstInput));
        expect(remounted.getCurrent()?.bytes).toEqual(createValidPluginBrandPngFixture());
        expect(rpc.read).toHaveBeenCalledTimes(1);
        await remounted.unmount();
        await readInstalledPluginBrandPresentation(readInput({
            accountLifetime: lifetime.lifetime,
            installedPackage: installedPackage({ brand: availableBrand(), occurrenceId: 'replacement-occurrence' }),
        }));
        expect(rpc.read).toHaveBeenCalledTimes(2);
    });

    it('retains only the current external mark per plugin and Machine after repeated occurrence replacement', async () => {
        const lifetime = createLifetime();
        type Request = { result: Promise<Awaited<ReturnType<typeof readInstalledPluginBrandPresentation>>> };
        let requests: Map<unknown, Request> | undefined;
        const originalSet = Map.prototype.set;
        // Call through the real owner; inspect only its request map, without a
        // production inspection export or treating total process heap as cache bytes.
        const writes = vi.spyOn(Map.prototype, 'set').mockImplementation(function (this: Map<unknown, unknown>, key, value) {
            if (value && typeof value === 'object' && 'packageAssets' in value && 'result' in value && value.result instanceof Promise) {
                requests = this as Map<unknown, Request>;
            }
            return originalSet.call(this, key, value);
        });
        rpc.read.mockImplementation(async () => brandReadResult());
        const occurrenceInput = (machineId: string, occurrence: number) => readInput({
            accountLifetime: lifetime.lifetime,
            machineId,
            installedPackage: installedPackage({ brand: availableBrand(), occurrenceId: `replacement-${occurrence}` }),
        });
        try {
            for (let occurrence = 0; occurrence < 24; occurrence++) {
                await readInstalledPluginBrandPresentation(occurrenceInput(occurrence % 2 === 0 ? 'machine-a' : 'machine-b', occurrence));
            }
            expect(requests).toBeDefined();
            const retained = await Promise.all([...requests!.values()].map((request) => request.result));
            expect({
                requests: requests!.size,
                bytes: retained.reduce((total, presentation) => total + (presentation?.bytes?.byteLength ?? 0), 0),
            }).toEqual({ requests: 2, bytes: 2 * createValidPluginBrandPngFixture().byteLength });
            await readInstalledPluginBrandPresentation(occurrenceInput('machine-b', 23));
            expect(rpc.read).toHaveBeenCalledTimes(24);
            await readInstalledPluginBrandPresentation(occurrenceInput('machine-a', 0));
            expect(rpc.read).toHaveBeenCalledTimes(25);
            await readInstalledPluginBrandPresentation(occurrenceInput('machine-b', 23));
            expect(rpc.read).toHaveBeenCalledTimes(25);
            lifetime.retire();
            expect(requests!.size).toBe(0);
        } finally {
            writes.mockRestore();
            lifetime.retire();
        }
    });

    it('lets superseded pending callers settle without replacing the newer shared result', async () => {
        const lifetime = createLifetime();
        const resolvers: Array<(result: MachinePluginUiResourceReadResult) => void> = [];
        const signals: AbortSignal[] = [];
        rpc.read.mockImplementation((_machine, options: { signal: AbortSignal }) => {
            signals.push(options.signal);
            return new Promise<MachinePluginUiResourceReadResult>((resolve) => resolvers.push(resolve));
        });
        const firstInput = readInput({ accountLifetime: lifetime.lifetime });
        const replacementInput = readInput({ accountLifetime: lifetime.lifetime,
            installedPackage: installedPackage({ brand: availableBrand(), occurrenceId: 'replacement' }) });
        const first = readInstalledPluginBrandPresentation(firstInput);
        const replacement = readInstalledPluginBrandPresentation(replacementInput);
        const peer = readInstalledPluginBrandPresentation(replacementInput);
        expect(rpc.read).toHaveBeenCalledTimes(2);
        expect(signals.every((signal) => !signal.aborted)).toBe(true);
        resolvers[1]!(brandReadResult());
        const current = await replacement;
        expect(await peer).toBe(current);
        resolvers[0]!(brandReadResult());
        expect((await first)?.bytes).toEqual(createValidPluginBrandPngFixture());
        expect(await readInstalledPluginBrandPresentation(replacementInput)).toBe(current);
        expect(rpc.read).toHaveBeenCalledTimes(2);

        const pendingOld = readInstalledPluginBrandPresentation(firstInput);
        const pendingNew = readInstalledPluginBrandPresentation(replacementInput);
        expect(rpc.read).toHaveBeenCalledTimes(4);
        lifetime.retire();
        expect(signals.slice(2).every((signal) => signal.aborted)).toBe(true);
        resolvers[2]!(brandReadResult());
        resolvers[3]!(brandReadResult());
        await expect(pendingOld).resolves.toBeNull();
        await expect(pendingNew).resolves.toBeNull();
    });

    it.each(['reader', 'hook'] as const)('withdraws retained external bytes when a package becomes neutral (%s)', async (surface) => {
        const lifetime = createLifetime();
        rpc.read.mockResolvedValue(brandReadResult());
        const input = readInput({ accountLifetime: lifetime.lifetime });
        const neutral = { ...input, installedPackage: installedPackage({ brand: { state: 'missing' }, occurrenceId: 'unbranded-replacement' }) };
        if (surface === 'hook') {
            const hook = await renderHook((props: typeof input) => useInstalledPluginBrandPresentation(props), { initialProps: input });
            await hook.rerender(neutral);
            expect(hook.getCurrent()).toEqual({ displayName: 'Acme Brand' });
            await hook.unmount();
        } else {
            await readInstalledPluginBrandPresentation(input);
            expect(await readInstalledPluginBrandPresentation(neutral)).toEqual({ displayName: 'Acme Brand' });
        }
        await readInstalledPluginBrandPresentation(input);
        expect(rpc.read).toHaveBeenCalledTimes(2);
        lifetime.retire();
    });

    it('reads the admitted same-plugin PNG through the canonical contextual Resource authority', async () => {
        rpc.read.mockResolvedValue(brandReadResult());

        await expect(readInstalledPluginBrandPresentation(readInput({
            installedPackage: installedPackage({ brand: availableBrand({ monochrome: true }) }),
        }))).resolves.toEqual({
            displayName: 'Acme Brand',
            bytes: createValidPluginBrandPngFixture(),
            monochrome: true,
        });
        expect(rpc.read).toHaveBeenCalledWith('machine-a', expect.objectContaining({
            serverId: 'server-a',
            expectedCallerOccurrenceId: 'brand-occurrence-7',
            callerPluginId: PLUGIN_ID,
            resource: BRAND_RESOURCE,
        }));
    });

    it('aborts shared acquisition on Account retirement and fences its late delivery', async () => {
        const lifetime = createLifetime();
        let transportSignal: AbortSignal | undefined;
        let resolveRead!: (result: MachinePluginUiResourceReadResult) => void;
        rpc.read.mockImplementation((_machineId, options: { signal?: AbortSignal }) => {
            transportSignal = options.signal;
            return new Promise<MachinePluginUiResourceReadResult>((resolve) => { resolveRead = resolve; });
        });
        const pending = readInstalledPluginBrandPresentation(readInput({ accountLifetime: lifetime.lifetime }));
        expect(transportSignal?.aborted).toBe(false);
        lifetime.retire();
        expect(transportSignal?.aborted).toBe(true);
        resolveRead(brandReadResult());
        await expect(pending).resolves.toBeNull();
    });

    it('shares portable results only for the current reader and protected source identities', async () => {
        const lifetime = createLifetime();
        const portable = portablePackageAssets();
        const input = readInput({
            accountLifetime: lifetime.lifetime,
            packageAssets: portable.packageAssets,
            installedPackage: installedPackage({ brand: availableBrand({ digest: portable.digest }) }),
        });
        const first = await readInstalledPluginBrandPresentation(input);
        expect(await readInstalledPluginBrandPresentation(input)).toBe(first);
        expect(portable.source.readArchive).toHaveBeenCalledTimes(1);
        const replacement = portablePackageAssets();
        expect((await readInstalledPluginBrandPresentation({ ...input, packageAssets: { reader: portable.packageAssets.reader, source: replacement.source } }))?.bytes)
            .toEqual(createValidPluginBrandPngFixture());
        expect(replacement.source.readArchive).toHaveBeenCalledTimes(1);
        const third = portablePackageAssets();
        expect((await readInstalledPluginBrandPresentation({ ...input, packageAssets: third.packageAssets }))?.bytes)
            .toEqual(createValidPluginBrandPngFixture());
        expect(third.source.readArchive).toHaveBeenCalledTimes(1);
        third.withdraw();
        await expect(readInstalledPluginBrandPresentation({ ...input, packageAssets: third.packageAssets }))
            .resolves.toEqual({ displayName: 'Acme Brand' });
        expect(rpc.read).not.toHaveBeenCalled();
    });

    it('reads a portable brand only through its Availability-selected Package Asset lease', async () => {
        const portable = portablePackageAssets();

        await expect(readInstalledPluginBrandPresentation(readInput({
            machineId: null,
            packageAssets: portable.packageAssets,
            installedPackage: installedPackage({ brand: availableBrand({ digest: portable.digest, monochrome: true }) }),
        }))).resolves.toEqual({
            displayName: 'Acme Brand',
            bytes: createValidPluginBrandPngFixture(),
            monochrome: true,
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

    it('withdraws a mounted portable mark before a replacement source acquires its bytes', async () => {
        const lifetime = createLifetime();
        const portable = portablePackageAssets();
        const input = readInput({ accountLifetime: lifetime.lifetime, packageAssets: portable.packageAssets,
            installedPackage: installedPackage({ brand: availableBrand({ digest: portable.digest }) }) });
        const seen: Array<ReturnType<typeof useInstalledPluginBrandPresentation>> = [];
        const hook = await renderHook((props: typeof input) => {
            const result = useInstalledPluginBrandPresentation(props);
            seen.push(result);
            return result;
        }, { initialProps: input });
        expect(hook.getCurrent()?.bytes).toEqual(createValidPluginBrandPngFixture());
        const replacement = portablePackageAssets();
        let resolveArchive!: (archive: PackageAssetArchiveOpenedV1) => void;
        const archive = replacement.opened;
        const pendingSource: PluginProtectedAccountPackageAssetSource = {
            readArchive: () => new Promise<PackageAssetArchiveOpenedV1>((resolve) => { resolveArchive = resolve; }),
        };
        seen.length = 0;
        await hook.rerender({ ...input, packageAssets: { reader: input.packageAssets!.reader, source: pendingSource } });
        expect(seen.every((presentation) => presentation?.bytes === undefined)).toBe(true);
        await act(async () => { resolveArchive(archive); });
        expect(hook.getCurrent()?.bytes).toEqual(createValidPluginBrandPngFixture());
        await hook.unmount();
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
                code: 'plugin_occurrence_stale',
                reason: 'stale_occurrence',
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

    it('does not re-render an empty mark when its captured request signal aborts', async () => {
        const abortController = new AbortController();
        const input = readInput({ installedPackage: null, accountLifetime: null, signal: abortController.signal });
        let renders = 0;
        const hook = await renderHook(() => { renders += 1; return useInstalledPluginBrandPresentation(input); });
        expect(hook.getCurrent()).toBeNull();
        const before = renders;

        await act(async () => { abortController.abort(); });

        expect(hook.getCurrent()).toBeNull();
        expect(renders).toBe(before);
        expect(rpc.read).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('retains a neutral package presentation without publishing redundant mount updates', async () => {
        const input = readInput({ installedPackage: installedPackage({ brand: { state: 'missing' } }) });
        const presentations: unknown[] = [];
        const hook = await renderHook(() => {
            const presentation = useInstalledPluginBrandPresentation(input);
            presentations.push(presentation);
            return presentation;
        });
        expect(hook.getCurrent()).toEqual({ displayName: 'Acme Brand' });
        expect(presentations).toHaveLength(1);
        await hook.rerender();
        expect(hook.getCurrent()).toBe(presentations[0]);
        expect(rpc.read).not.toHaveBeenCalled();
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

    it('adopts a new target occurrence and Account lifetime before publishing that target\'s bytes', async () => {
        const targetPluginId = 'acme.next-brand';
        const targetResource = Object.freeze({ pluginId: targetPluginId, localId: 'assets/brand' });
        const targetPackage = PluginProjectionInstalledPackageV2Schema.parse({
            id: targetPluginId,
            displayName: 'Next Brand',
            version: '2.0.0',
            enabled: true,
            occurrenceId: 'next-brand-occurrence-8',
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
