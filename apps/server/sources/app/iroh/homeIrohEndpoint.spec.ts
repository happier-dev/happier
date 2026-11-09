import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseIrohEndpointDescriptorV1 } from '@happier-dev/protocol';
import { IrohError } from '@happier-dev/iroh-native/node';
import * as homeIrohEndpointOwner from './homeIrohEndpoint';

vi.mock('@/utils/logging/log', () => ({ log: vi.fn() }));
vi.mock('@/app/serverIdentity/serverIdentity', () => ({
    getOrCreateServerIdentityId: vi.fn(async () => 'srv_iroh_owner_spec'),
}));

const VALID_ENDPOINT_ID = 'a'.repeat(64);
const DRIFTED_ENDPOINT_ID = 'b'.repeat(64);
const API_PORT = 3005;
const HOME_SERVER_IDENTITY_ID = 'srv_iroh_owner_spec';
const CANONICAL_SERVER_URL = 'https://home.example.test';
const DEFAULT_DIRECT_ADDRESSES = ['198.51.100.7:54321'];

type NativeLifecycle = NonNullable<
    Parameters<
        typeof import('./homeIrohEndpoint')['ensureHomeIrohEndpoint']
    >[0]['native']
>;

type NativeLifecycleMock = {
    [K in keyof NativeLifecycle]-?: Mock<NativeLifecycle[K]>;
};

function createNativeFake(overrides: Partial<NativeLifecycle> = {}): NativeLifecycleMock {
    const native = {
        createEndpoint: vi.fn(async (request: { keyPath: string; relayPolicy: string; relayUrls: readonly string[] }) => ({
            endpointHandle: request.keyPath,
            endpointId: VALID_ENDPOINT_ID,
            relayMode: request.relayPolicy === 'disabled' ? 'disabled' : 'custom',
            capProfile: 'homeInteractive',
            relayUrls: [...request.relayUrls],
        })),
        startHomeAcceptor: vi.fn(async (request: { endpointHandle: string; targetHost: string; targetPort: number }) => ({
            endpointHandle: request.endpointHandle,
            reused: false,
            status: { running: true },
        })),
        stopHomeAcceptor: vi.fn(async () => {}),
        getEndpointStatus: vi.fn(async () => ({
            endpointId: VALID_ENDPOINT_ID,
            directAddresses: [...DEFAULT_DIRECT_ADDRESSES],
            active: true,
        })),
        shutdownEndpoint: vi.fn(async () => {}),
        ...overrides,
    };
    return native as NativeLifecycleMock;
}

async function loadOwnerModule() {
    return homeIrohEndpointOwner;
}

function envFor(dataDir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
        HAPPIER_CANONICAL_SERVER_URL: CANONICAL_SERVER_URL,
        HAPPIER_MANAGED_RELAY_PURPOSE: 'personal-home',
        HAPPIER_SERVER_LIGHT_DATA_DIR: dataDir,
        ...extra,
    };
}

function keyPathFor(dataDir: string): string {
    return join(dataDir, 'runtime', 'iroh', 'endpoint.key');
}

function continuityPathFor(dataDir: string): string {
    return join(dataDir, 'runtime', 'iroh', 'home.descriptor.json');
}

async function writeContinuityFixture(dataDir: string, continuity: Record<string, unknown>): Promise<void> {
    await mkdir(join(dataDir, 'runtime', 'iroh'), { recursive: true });
    await writeFile(continuityPathFor(dataDir), `${JSON.stringify(continuity)}\n`, 'utf-8');
}

async function writeKeyFixture(dataDir: string): Promise<void> {
    await mkdir(join(dataDir, 'runtime', 'iroh'), { recursive: true });
    await writeFile(keyPathFor(dataDir), Buffer.alloc(32, 7));
}

function continuityFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        revision: 3,
        contentKey: `v1:i:${'c'.repeat(64)}`,
        irohEndpointId: VALID_ENDPOINT_ID,
        ...overrides,
    };
}

describe('home Iroh endpoint composition', () => {
    let dataDir: string;

    beforeEach(async () => {
        dataDir = await mkdtemp(join(tmpdir(), 'home-iroh-owner-'));
    });

    afterEach(async () => {
        await homeIrohEndpointOwner.resetHomeIrohEndpointStateForTests();
        await rm(dataDir, { recursive: true, force: true });
    });

    it('composes one endpoint plus one fixed-loopback acceptor after the API listens and publishes the parsed descriptor snapshot', async () => {
        const owner = await loadOwnerModule();
        const native = createNativeFake();

        const state = await owner.ensureHomeIrohEndpoint({
            env: envFor(dataDir),
            apiPort: API_PORT,
            native,
        });

        expect(state.status).toBe('active');
        expect(state.failureReason).toBeNull();
        expect(state.snapshot).toEqual({
            endpoint: parseIrohEndpointDescriptorV1({
                endpointId: VALID_ENDPOINT_ID,
                directAddresses: [...DEFAULT_DIRECT_ADDRESSES],
            }),
        });
        await expect(owner.getHomeIrohEndpointState()).resolves.toEqual(state);

        expect(native.createEndpoint).toHaveBeenCalledTimes(1);
        expect(native.createEndpoint.mock.calls[0]?.[0]).toEqual({
            keyPath: keyPathFor(dataDir),
            // Unconfigured relay env resolves to the canonical default policy
            // `automatic` with no operator relay URLs.
            relayPolicy: 'automatic',
            relayUrls: [],
            capProfile: 'homeInteractive',
        });
        expect(native.startHomeAcceptor).toHaveBeenCalledTimes(1);
        expect(native.startHomeAcceptor.mock.calls[0]?.[0]).toEqual({
            endpointHandle: keyPathFor(dataDir),
            targetHost: '127.0.0.1',
            targetPort: API_PORT,
        });
        expect(native.shutdownEndpoint).not.toHaveBeenCalled();

        await expect(readFile(continuityPathFor(dataDir), 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('exposes current key retirement to final admission without another native status read', async () => {
        const owner = await loadOwnerModule();
        const native = createNativeFake();
        const prepared = await owner.ensureHomeIrohEndpoint({ env: envFor(dataDir), apiPort: API_PORT, native });
        native.getEndpointStatus.mockRejectedValue(new Error('Final admission must not perform native IO'));
        expect(owner.readHomeIrohEndpointLifecycleState()).toEqual(prepared);
        const stopping = owner.stopHomeIrohEndpoint();
        expect(owner.readHomeIrohEndpointLifecycleState().snapshot).toBeNull();
        await stopping;
        expect(owner.readHomeIrohEndpointLifecycleState().status).not.toBe('active');
    });

    it.each([
        { marker: { HAPPIER_SOCKET_ADAPTER: 'redis-streams' }, operation: 'compose' },
        { marker: { HAPPIER_SOCKET_REDIS_ADAPTER: '1' }, operation: 'compose' },
        { marker: { HAPPIER_SOCKET_ADAPTER: 'redis-streams' }, operation: 'materialize' },
    ])('refuses $operation for the cluster marker $marker', async ({ marker, operation }) => {
        const owner = await loadOwnerModule();
        const native = createNativeFake();
        const env = envFor(dataDir, marker);
        if (operation === 'compose') {
            expect(await owner.ensureHomeIrohEndpoint({ env, apiPort: API_PORT, native })).toEqual({
                status: 'unavailable', snapshot: null, failureReason: 'iroh_multi_instance_unsupported',
            });
        } else {
            expect(await owner.materializeHomeIrohEndpointDescriptor({ env, native })).toEqual({
                status: 'failed', failureReason: 'iroh_multi_instance_unsupported',
            });
        }
        expect(native.createEndpoint).not.toHaveBeenCalled();
        expect(native.startHomeAcceptor).not.toHaveBeenCalled();
    });

    it('materializes fresh relocation endpoint facts without owning the outer descriptor revision', async () => {
        const owner = await loadOwnerModule();
        const native = createNativeFake({
            createEndpoint: vi.fn(async (request: { keyPath: string; relayPolicy: string; relayUrls: readonly string[] }) => {
                await mkdir(join(dataDir, 'runtime', 'iroh'), { recursive: true });
                await writeFile(request.keyPath, Buffer.alloc(32, 9));
                return {
                    endpointHandle: request.keyPath,
                    endpointId: VALID_ENDPOINT_ID,
                    relayMode: request.relayPolicy === 'disabled' ? 'disabled' : 'custom',
                    capProfile: 'homeInteractive',
                    relayUrls: [...request.relayUrls],
                };
            }),
        });

        const result = await owner.materializeHomeIrohEndpointDescriptor({
            env: envFor(dataDir),
            native,
        });

        expect(result).toEqual({
            status: 'ready',
            endpoint: parseIrohEndpointDescriptorV1({
                endpointId: VALID_ENDPOINT_ID,
                directAddresses: [...DEFAULT_DIRECT_ADDRESSES],
            }),
        });
        expect(native.startHomeAcceptor).not.toHaveBeenCalled();
        expect(native.shutdownEndpoint).toHaveBeenCalledWith({ endpointHandle: keyPathFor(dataDir) });

        const repeated = await owner.materializeHomeIrohEndpointDescriptor({
            env: envFor(dataDir),
            native,
        });
        expect(repeated).toEqual(result);
        expect(native.startHomeAcceptor).not.toHaveBeenCalled();
        expect(native.shutdownEndpoint).toHaveBeenCalledTimes(2);

        await expect(readFile(continuityPathFor(dataDir), 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });

        const active = await owner.ensureHomeIrohEndpoint({ env: envFor(dataDir), apiPort: API_PORT, native });
        expect(active.status).toBe('active');
        expect(active.snapshot?.endpoint.endpointId).toBe(VALID_ENDPOINT_ID);
        expect(native.startHomeAcceptor).toHaveBeenCalledTimes(1);
    });

    it('reuses the one active lifecycle for a repeated compatible ensure without binding duplicates', async () => {
        const owner = await loadOwnerModule();
        const native = createNativeFake();
        const env = envFor(dataDir);

        const first = await owner.ensureHomeIrohEndpoint({ env, apiPort: API_PORT, native });
        const second = await owner.ensureHomeIrohEndpoint({ env, apiPort: API_PORT, native });

        expect(second).toEqual(first);
        expect(native.createEndpoint).toHaveBeenCalledTimes(1);
        expect(native.startHomeAcceptor).toHaveBeenCalledTimes(1);
    });

    it('fails a repeated ensure with a typed conflict on incompatible configuration', async () => {
        const owner = await loadOwnerModule();
        const native = createNativeFake();

        await owner.ensureHomeIrohEndpoint({ env: envFor(dataDir), apiPort: API_PORT, native });

        // The first ensure used the default `automatic` policy, so the
        // incompatible repeat must actually switch policy.
        await expect(owner.ensureHomeIrohEndpoint({
            env: envFor(dataDir, { HAPPIER_IROH_RELAY_POLICY: 'disabled' }),
            apiPort: API_PORT,
            native,
        })).rejects.toMatchObject({ name: 'IrohError', code: 'endpoint_config_conflict' });

        expect(native.createEndpoint).toHaveBeenCalledTimes(1);
    });

    it('carries explicit operator relay URLs to the native endpoint and into the descriptor', async () => {
        const owner = await loadOwnerModule();
        const native = createNativeFake();

        const state = await owner.ensureHomeIrohEndpoint({
            env: envFor(dataDir, {
                HAPPIER_IROH_RELAY_POLICY: 'automatic',
                HAPPIER_IROH_RELAY_URLS: 'https://relay-b.example.test, https://relay-a.example.test',
            }),
            apiPort: API_PORT,
            native,
        });

        expect(state.status).toBe('active');
        expect(native.createEndpoint.mock.calls[0]?.[0]).toEqual({
            keyPath: keyPathFor(dataDir),
            relayPolicy: 'automatic',
            relayUrls: ['https://relay-a.example.test', 'https://relay-b.example.test'],
            capProfile: 'homeInteractive',
        });
        expect(state.snapshot?.endpoint.relayUrls).toEqual([
            'https://relay-a.example.test',
            'https://relay-b.example.test',
        ]);
    });

    it('fails closed when the disabled relay policy is combined with operator relay URLs', async () => {
        const owner = await loadOwnerModule();
        const native = createNativeFake();

        const state = await owner.ensureHomeIrohEndpoint({
            env: envFor(dataDir, {
                HAPPIER_IROH_RELAY_POLICY: 'disabled',
                HAPPIER_IROH_RELAY_URLS: 'https://relay.example.test',
            }),
            apiPort: API_PORT,
            native,
        });

        expect(state).toEqual({ status: 'failed', snapshot: null, failureReason: 'invalid_iroh_config' });
        expect(native.createEndpoint).not.toHaveBeenCalled();
        expect(state.snapshot).toBeNull();
    });

    it('keeps relay query credentials out of the native transport and published descriptor', async () => {
        const owner = await loadOwnerModule();
        const native = createNativeFake();

        const state = await owner.ensureHomeIrohEndpoint({
            env: envFor(dataDir, {
                HAPPIER_IROH_RELAY_POLICY: 'automatic',
                HAPPIER_IROH_RELAY_URLS: 'https://relay.example.test?token=shared-secret',
            }),
            apiPort: API_PORT,
            native,
        });

        expect(state).toEqual({ status: 'failed', snapshot: null, failureReason: 'invalid_iroh_config' });
        expect(native.createEndpoint).not.toHaveBeenCalled();
    });

    it('requires the stable canonical Home auth audience from HAPPIER_CANONICAL_SERVER_URL', async () => {
        const owner = await loadOwnerModule();
        const native = createNativeFake();
        const env = envFor(dataDir);
        delete env.HAPPIER_CANONICAL_SERVER_URL;

        const state = await owner.ensureHomeIrohEndpoint({ env, apiPort: API_PORT, native });

        expect(state).toEqual({ status: 'failed', snapshot: null, failureReason: 'canonical_server_url_missing' });
        expect(native.createEndpoint).not.toHaveBeenCalled();
        expect(native.startHomeAcceptor).not.toHaveBeenCalled();
    });

    it('fails closed when continuity metadata is unreadable', async () => {
        await writeContinuityFixture(dataDir, { broken: true });
        const owner = await loadOwnerModule();
        const native = createNativeFake();

        const state = await owner.ensureHomeIrohEndpoint({ env: envFor(dataDir), apiPort: API_PORT, native });

        expect(state).toEqual({ status: 'failed', snapshot: null, failureReason: 'continuity_metadata_unreadable' });
        expect(native.createEndpoint).not.toHaveBeenCalled();
    });

    it('fails closed when continuity proves prior provisioning but the endpoint key is now lost', async () => {
        await writeContinuityFixture(dataDir, continuityFixture());
        const owner = await loadOwnerModule();
        const native = createNativeFake();

        const state = await owner.ensureHomeIrohEndpoint({ env: envFor(dataDir), apiPort: API_PORT, native });

        expect(state).toEqual({ status: 'failed', snapshot: null, failureReason: 'endpoint_key_lost' });
        expect(native.createEndpoint).not.toHaveBeenCalled();
        expect(native.shutdownEndpoint).not.toHaveBeenCalled();
        expect(JSON.parse(await readFile(continuityPathFor(dataDir), 'utf-8'))).toEqual(continuityFixture());
    });

    it('composes endpoint facts without allocating an outer descriptor revision', async () => {
        await writeKeyFixture(dataDir);
        const owner = await loadOwnerModule();
        const native = createNativeFake();

        const state = await owner.ensureHomeIrohEndpoint({ env: envFor(dataDir), apiPort: API_PORT, native });

        expect(state.status).toBe('active');
        expect(state.snapshot).toEqual({
            endpoint: parseIrohEndpointDescriptorV1({
                endpointId: VALID_ENDPOINT_ID,
                directAddresses: [...DEFAULT_DIRECT_ADDRESSES],
            }),
        });
        expect(state.snapshot).not.toHaveProperty('revision');
    });

    it.each([
        {},
        { HAPPIER_SOCKET_ADAPTER: 'redis-streams', HAPPIER_HOME_IROH_HOLDER: '1' },
    ])('fails closed and cleans up when outer continuity detects endpoint identity drift (%o)', async marker => {
        await writeKeyFixture(dataDir);
        await writeContinuityFixture(dataDir, continuityFixture());
        const owner = await loadOwnerModule();
        const native = createNativeFake({
            createEndpoint: vi.fn(async (request: { keyPath: string; relayPolicy: string; relayUrls: readonly string[] }) => ({
                endpointHandle: request.keyPath,
                endpointId: DRIFTED_ENDPOINT_ID,
                relayMode: 'disabled',
                capProfile: 'homeInteractive',
                relayUrls: [...request.relayUrls],
            })),
            getEndpointStatus: vi.fn(async () => ({
                endpointId: DRIFTED_ENDPOINT_ID,
                directAddresses: [...DEFAULT_DIRECT_ADDRESSES],
                active: true,
            })),
        });

        const state = await owner.ensureHomeIrohEndpoint({ env: envFor(dataDir, marker), apiPort: API_PORT, native });

        expect(state).toEqual({ status: 'failed', snapshot: null, failureReason: 'endpoint_identity_drift' });
        expect(native.shutdownEndpoint).toHaveBeenCalledWith({ endpointHandle: keyPathFor(dataDir) });
        expect(native.startHomeAcceptor).not.toHaveBeenCalled();
        expect(JSON.parse(await readFile(continuityPathFor(dataDir), 'utf-8'))).toEqual(continuityFixture());
    });

    it('returns current direct-address facts without writing descriptor continuity', async () => {
        await writeKeyFixture(dataDir);
        await writeContinuityFixture(dataDir, continuityFixture());
        const owner = await loadOwnerModule();
        const native = createNativeFake({
            getEndpointStatus: vi.fn(async () => ({
                endpointId: VALID_ENDPOINT_ID,
                directAddresses: ['198.51.100.9:54321'],
                active: true,
            })),
        });

        const state = await owner.ensureHomeIrohEndpoint({ env: envFor(dataDir), apiPort: API_PORT, native });

        expect(state.status).toBe('active');
        expect(state.snapshot?.endpoint.directAddresses).toEqual(['198.51.100.9:54321']);
        expect(JSON.parse(await readFile(continuityPathFor(dataDir), 'utf-8'))).toEqual(continuityFixture());
    });

    it('does not compose canonical Home identity or URL into endpoint facts', async () => {
        await writeKeyFixture(dataDir);
        await writeContinuityFixture(dataDir, continuityFixture());
        const owner = await loadOwnerModule();
        const native = createNativeFake();
        const nextCanonicalServerUrl = 'https://moved-home.example.test';

        const state = await owner.ensureHomeIrohEndpoint({
            env: envFor(dataDir, { HAPPIER_CANONICAL_SERVER_URL: nextCanonicalServerUrl }),
            apiPort: API_PORT,
            native,
        });

        expect(state.status).toBe('active');
        expect(state.snapshot).not.toHaveProperty('canonicalServerUrl');
        expect(JSON.parse(await readFile(continuityPathFor(dataDir), 'utf-8'))).toEqual(continuityFixture());
    });

    it('accepts an older outer continuity record without EndpointId when its key is present', async () => {
        await writeKeyFixture(dataDir);
        await writeContinuityFixture(dataDir, { revision: 3, contentKey: `v1:i:${'c'.repeat(64)}` });
        const owner = await loadOwnerModule();
        const native = createNativeFake();

        const state = await owner.ensureHomeIrohEndpoint({ env: envFor(dataDir), apiPort: API_PORT, native });

        expect(state.status).toBe('active');
        expect(state.snapshot?.endpoint.endpointId).toBe(VALID_ENDPOINT_ID);
    });

    it('refreshes live direct-address facts on descriptor-state reads without persisting a second continuity record', async () => {
        await writeKeyFixture(dataDir);
        await writeContinuityFixture(dataDir, continuityFixture());
        const owner = await loadOwnerModule();
        const native = createNativeFake();

        const state = await owner.ensureHomeIrohEndpoint({ env: envFor(dataDir), apiPort: API_PORT, native });
        expect(state.status).toBe('active');

        native.getEndpointStatus.mockResolvedValue({
            endpointId: VALID_ENDPOINT_ID,
            directAddresses: [' 198.51.100.9:54321 ', '198.51.100.9:54321'],
            active: true,
        });

        const refreshed = await owner.getHomeIrohEndpointState();

        expect(refreshed.status).toBe('active');
        expect(refreshed.snapshot?.endpoint.directAddresses).toEqual(['198.51.100.9:54321']);
        expect(JSON.parse(await readFile(continuityPathFor(dataDir), 'utf-8'))).toEqual(continuityFixture());
    });

    it('keeps endpoint facts stable when refreshed status is unchanged', async () => {
        await writeKeyFixture(dataDir);
        await writeContinuityFixture(dataDir, continuityFixture());
        const owner = await loadOwnerModule();
        const native = createNativeFake();

        const state = await owner.ensureHomeIrohEndpoint({ env: envFor(dataDir), apiPort: API_PORT, native });
        const refreshed = await owner.getHomeIrohEndpointState();

        expect(refreshed).toEqual(state);
        expect(JSON.parse(await readFile(continuityPathFor(dataDir), 'utf-8'))).toEqual(continuityFixture());
    });

    it('keeps endpoint facts when a refresh status read rejects and refreshes on the next request', async () => {
        await writeKeyFixture(dataDir);
        await writeContinuityFixture(dataDir, continuityFixture());
        const owner = await loadOwnerModule();
        const native = createNativeFake();

        const state = await owner.ensureHomeIrohEndpoint({ env: envFor(dataDir), apiPort: API_PORT, native });
        native.getEndpointStatus.mockRejectedValueOnce(new Error('native status read unavailable'));
        expect(await owner.getHomeIrohEndpointState()).toEqual(state);

        native.getEndpointStatus.mockResolvedValue({
            endpointId: VALID_ENDPOINT_ID,
            directAddresses: ['198.51.100.9:54321'],
            active: true,
        });
        const advanced = await owner.getHomeIrohEndpointState();

        expect(advanced.snapshot?.endpoint.directAddresses).toEqual(['198.51.100.9:54321']);
    });

    it('does not revive an endpoint when a pending status refresh completes after stop', async () => {
        await writeKeyFixture(dataDir);
        await writeContinuityFixture(dataDir, continuityFixture());
        const owner = await loadOwnerModule();
        let resolveRefreshStatus: ((value: Awaited<ReturnType<NativeLifecycle['getEndpointStatus']>>) => void) | null = null;
        let statusReadCount = 0;
        const native = createNativeFake({
            getEndpointStatus: vi.fn(async () => {
                statusReadCount += 1;
                if (statusReadCount === 1) {
                    return {
                        endpointId: VALID_ENDPOINT_ID,
                        directAddresses: [...DEFAULT_DIRECT_ADDRESSES],
                        active: true,
                    };
                }
                return await new Promise<Awaited<ReturnType<NativeLifecycle['getEndpointStatus']>>>((resolve) => {
                    resolveRefreshStatus = resolve;
                });
            }),
        });

        expect((await owner.ensureHomeIrohEndpoint({ env: envFor(dataDir), apiPort: API_PORT, native })).status).toBe('active');

        const refresh = owner.getHomeIrohEndpointState();
        await vi.waitFor(() => expect(resolveRefreshStatus).toBeTypeOf('function'));
        await owner.stopHomeIrohEndpoint();

        resolveRefreshStatus!({
            endpointId: VALID_ENDPOINT_ID,
            directAddresses: ['198.51.100.9:54321'],
            active: true,
        });

        await expect(refresh).resolves.toEqual({
            status: 'stopping',
            snapshot: null,
            failureReason: null,
        });
        await expect(owner.getHomeIrohEndpointState()).resolves.toEqual({
            status: 'stopping',
            snapshot: null,
            failureReason: null,
        });
        expect(native.shutdownEndpoint).toHaveBeenCalledTimes(1);
    });

    it('fails a refresh closed when the live endpoint no longer matches the published identity', async () => {
        await writeKeyFixture(dataDir);
        await writeContinuityFixture(dataDir, continuityFixture());
        const owner = await loadOwnerModule();
        const native = createNativeFake();

        expect((await owner.ensureHomeIrohEndpoint({ env: envFor(dataDir), apiPort: API_PORT, native })).status).toBe('active');

        native.getEndpointStatus.mockResolvedValue({
            endpointId: DRIFTED_ENDPOINT_ID,
            directAddresses: ['198.51.100.9:54321'],
            active: true,
        });

        expect(await owner.getHomeIrohEndpointState()).toEqual({
            status: 'failed',
            snapshot: null,
            failureReason: 'endpoint_not_active',
        });
        expect(await owner.getHomeIrohEndpointState()).toMatchObject({ status: 'failed' });
    });


    it('fails closed when the native endpoint never becomes active', async () => {
        const owner = await loadOwnerModule();
        const native = createNativeFake({
            getEndpointStatus: vi.fn(async () => ({
                endpointId: VALID_ENDPOINT_ID,
                directAddresses: [...DEFAULT_DIRECT_ADDRESSES],
                active: false,
            })),
        });

        const state = await owner.ensureHomeIrohEndpoint({ env: envFor(dataDir), apiPort: API_PORT, native });

        expect(state).toEqual({ status: 'failed', snapshot: null, failureReason: 'endpoint_not_active' });
        expect(native.startHomeAcceptor).not.toHaveBeenCalled();
        expect(native.shutdownEndpoint).toHaveBeenCalledWith({ endpointHandle: keyPathFor(dataDir) });
        await expect(readFile(continuityPathFor(dataDir), 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('fails closed when the fixed acceptor does not start', async () => {
        const owner = await loadOwnerModule();
        const native = createNativeFake({
            startHomeAcceptor: vi.fn(async (request: { endpointHandle: string }) => ({
                endpointHandle: request.endpointHandle,
                reused: false,
                status: { running: false },
            })),
        });

        const state = await owner.ensureHomeIrohEndpoint({ env: envFor(dataDir), apiPort: API_PORT, native });

        expect(state).toEqual({ status: 'failed', snapshot: null, failureReason: 'acceptor_not_running' });
        expect(native.stopHomeAcceptor).not.toHaveBeenCalled();
        expect(native.shutdownEndpoint).toHaveBeenCalledWith({ endpointHandle: keyPathFor(dataDir) });
        expect(state.snapshot).toBeNull();
    });

    it('fails closed when the acceptor reports a handle other than the provisioned endpoint handle', async () => {
        const owner = await loadOwnerModule();
        const native = createNativeFake({
            startHomeAcceptor: vi.fn(async () => ({
                endpointHandle: 'different-owned-endpoint',
                reused: false,
                status: { running: true },
            })),
        });

        const state = await owner.ensureHomeIrohEndpoint({ env: envFor(dataDir), apiPort: API_PORT, native });

        expect(state).toEqual({ status: 'failed', snapshot: null, failureReason: 'acceptor_not_running' });
        expect(native.shutdownEndpoint).toHaveBeenCalledWith({ endpointHandle: keyPathFor(dataDir) });
    });

    it('fails closed when the native descriptor payload cannot be parsed by the protocol parser', async () => {
        const owner = await loadOwnerModule();
        const native = createNativeFake({
            createEndpoint: vi.fn(async (request: { keyPath: string; relayPolicy: string; relayUrls: readonly string[] }) => ({
                endpointHandle: request.keyPath,
                endpointId: 'not-a-valid-endpoint-id',
                relayMode: 'disabled',
                capProfile: 'homeInteractive',
                relayUrls: [...request.relayUrls],
            })),
            getEndpointStatus: vi.fn(async () => ({
                endpointId: 'not-a-valid-endpoint-id',
                directAddresses: [...DEFAULT_DIRECT_ADDRESSES],
                active: true,
            })),
        });

        const state = await owner.ensureHomeIrohEndpoint({ env: envFor(dataDir), apiPort: API_PORT, native });

        expect(state).toEqual({ status: 'failed', snapshot: null, failureReason: 'descriptor_invalid' });
        expect(native.shutdownEndpoint).toHaveBeenCalledWith({ endpointHandle: keyPathFor(dataDir) });
        expect(state.snapshot).toBeNull();
    });

    it('fails closed when the API listen port is unavailable', async () => {
        const owner = await loadOwnerModule();
        const native = createNativeFake();

        const state = await owner.ensureHomeIrohEndpoint({ env: envFor(dataDir), apiPort: null, native });

        expect(state).toEqual({ status: 'failed', snapshot: null, failureReason: 'api_listen_port_unavailable' });
        expect(native.createEndpoint).not.toHaveBeenCalled();
    });

    it('reports honest unavailability without failing the process when the native transport is absent and Iroh is not explicitly configured', async () => {
        const owner = await loadOwnerModule();

        const state = await owner.ensureHomeIrohEndpoint({ env: envFor(dataDir), apiPort: API_PORT, native: null });

        expect(state).toEqual({ status: 'unavailable', snapshot: null, failureReason: null });
        await expect(owner.getHomeIrohEndpointState()).resolves.toEqual({
            status: 'unavailable',
            snapshot: null,
            failureReason: null,
        });
    });

    it('reports honest unavailability when relay policy and URLs are configured but the native transport is absent', async () => {
        const owner = await loadOwnerModule();

        const state = await owner.ensureHomeIrohEndpoint({
            env: envFor(dataDir, {
                HAPPIER_IROH_RELAY_POLICY: 'automatic',
                HAPPIER_IROH_RELAY_URLS: 'https://relay.example.test',
            }),
            apiPort: API_PORT,
            native: null,
        });

        expect(state).toEqual({ status: 'unavailable', snapshot: null, failureReason: null });
        await expect(owner.getHomeIrohEndpointState()).resolves.toEqual(state);
    });

    it('publishes a stopping transition and delegates native cleanup to aggregate endpoint shutdown', async () => {
        const owner = await loadOwnerModule();
        const order: string[] = [];
        const native = createNativeFake({
            shutdownEndpoint: vi.fn(async () => {
                order.push('shutdownEndpoint');
            }),
        });
        await owner.ensureHomeIrohEndpoint({ env: envFor(dataDir), apiPort: API_PORT, native });

        await owner.stopHomeIrohEndpoint();

        expect(order).toEqual(['shutdownEndpoint']);
        expect(native.stopHomeAcceptor).not.toHaveBeenCalled();
        expect(native.shutdownEndpoint).toHaveBeenCalledWith({ endpointHandle: keyPathFor(dataDir) });
        await expect(owner.getHomeIrohEndpointState()).resolves.toEqual({
            status: 'stopping',
            snapshot: null,
            failureReason: null,
        });

        await owner.stopHomeIrohEndpoint();
        expect(native.shutdownEndpoint).toHaveBeenCalledTimes(1);
    });

    it('keeps the endpoint owned when shutdown cleanup rejects, refuses new work meanwhile, and disposes it on retry', async () => {
        await writeKeyFixture(dataDir);
        const owner = await loadOwnerModule();
        let failShutdown = true;
        const native = createNativeFake({
            shutdownEndpoint: vi.fn(async () => {
                if (failShutdown) {
                    failShutdown = false;
                    throw new Error('native endpoint shutdown failed');
                }
            }),
        });
        const env = envFor(dataDir);
        await owner.ensureHomeIrohEndpoint({ env, apiPort: API_PORT, native });

        await expect(owner.stopHomeIrohEndpoint()).rejects.toThrow('native endpoint shutdown failed');
        expect(native.stopHomeAcceptor).not.toHaveBeenCalled();
        expect(native.shutdownEndpoint).toHaveBeenCalledTimes(1);

        // The retained native resource refuses new composition work instead of
        // creating a second owner.
        const refused = await owner.ensureHomeIrohEndpoint({ env, apiPort: API_PORT, native });
        expect(refused).toEqual({ status: 'failed', snapshot: null, failureReason: 'endpoint_cleanup_pending' });
        expect(native.createEndpoint).toHaveBeenCalledTimes(1);
        await expect(owner.materializeHomeIrohEndpointDescriptor({
            env,
            native,
        })).resolves.toEqual({ status: 'failed', failureReason: 'endpoint_cleanup_pending' });

        // A later disposal retries only the unsettled step.
        await owner.stopHomeIrohEndpoint();
        expect(native.stopHomeAcceptor).not.toHaveBeenCalled();
        expect(native.shutdownEndpoint).toHaveBeenCalledTimes(2);

        const recomposed = await owner.ensureHomeIrohEndpoint({ env, apiPort: API_PORT, native });
        expect(recomposed.status).toBe('active');
        expect(native.createEndpoint).toHaveBeenCalledTimes(2);
    });

    it('shares one in-flight cleanup between concurrent stops without caching the rejected attempt', async () => {
        const owner = await loadOwnerModule();
        let failShutdown = true;
        const native = createNativeFake({
            shutdownEndpoint: vi.fn(async () => {
                if (failShutdown) {
                    failShutdown = false;
                    throw new Error('native endpoint shutdown failed');
                }
            }),
        });
        await owner.ensureHomeIrohEndpoint({ env: envFor(dataDir), apiPort: API_PORT, native });

        const outcomes = await Promise.allSettled([owner.stopHomeIrohEndpoint(), owner.stopHomeIrohEndpoint()]);
        expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected']);
        expect(native.shutdownEndpoint).toHaveBeenCalledTimes(1);

        await owner.stopHomeIrohEndpoint();
        expect(native.shutdownEndpoint).toHaveBeenCalledTimes(2);
    });

    it('waits for an admitted composition and prevents its late acceptor from publishing after stop', async () => {
        const owner = await loadOwnerModule();
        let resolveAcceptor: ((value: Awaited<ReturnType<NativeLifecycle['startHomeAcceptor']>>) => void) | null = null;
        const native = createNativeFake({
            startHomeAcceptor: vi.fn(async (
                _request: Parameters<NativeLifecycle['startHomeAcceptor']>[0],
            ) => await new Promise<Awaited<ReturnType<NativeLifecycle['startHomeAcceptor']>>>((resolve) => {
                resolveAcceptor = resolve;
            })),
        });

        const ensure = owner.ensureHomeIrohEndpoint({ env: envFor(dataDir), apiPort: API_PORT, native });
        await vi.waitFor(() => expect(resolveAcceptor).toBeTypeOf('function'));

        let stopSettled = false;
        const stop = owner.stopHomeIrohEndpoint().then(() => {
            stopSettled = true;
        });
        await Promise.resolve();
        expect(stopSettled).toBe(false);

        resolveAcceptor!({
            endpointHandle: keyPathFor(dataDir),
            reused: false,
            status: { running: true },
        });
        await expect(ensure).resolves.toMatchObject({ status: 'stopping' });
        await stop;

        await expect(owner.getHomeIrohEndpointState()).resolves.toEqual({
            status: 'stopping',
            snapshot: null,
            failureReason: null,
        });
        expect(native.stopHomeAcceptor).not.toHaveBeenCalled();
        expect(native.shutdownEndpoint).toHaveBeenCalledTimes(1);
    });

    it('keeps a rejected startup-failure cleanup owned and retryable', async () => {
        const owner = await loadOwnerModule();
        let failShutdown = true;
        const native = createNativeFake({
            startHomeAcceptor: vi.fn(async (request: { endpointHandle: string }) => ({
                endpointHandle: request.endpointHandle,
                reused: false,
                status: { running: false },
            })),
            shutdownEndpoint: vi.fn(async () => {
                if (failShutdown) {
                    failShutdown = false;
                    throw new Error('native endpoint shutdown failed');
                }
            }),
        });

        const state = await owner.ensureHomeIrohEndpoint({ env: envFor(dataDir), apiPort: API_PORT, native });

        expect(state).toEqual({ status: 'failed', snapshot: null, failureReason: 'acceptor_not_running' });
        expect(native.shutdownEndpoint).toHaveBeenCalledTimes(1);

        await owner.stopHomeIrohEndpoint();
        expect(native.stopHomeAcceptor).not.toHaveBeenCalled();
        expect(native.shutdownEndpoint).toHaveBeenCalledTimes(2);
    });

    it('maps a native config conflict to a typed fail-closed result', async () => {
        const owner = await loadOwnerModule();
        const native = createNativeFake({
            createEndpoint: vi.fn(async () => {
                throw new IrohError('endpoint_config_conflict', 'endpoint identity already bound');
            }),
        });

        const state = await owner.ensureHomeIrohEndpoint({ env: envFor(dataDir), apiPort: API_PORT, native });

        expect(state).toEqual({ status: 'failed', snapshot: null, failureReason: 'endpoint_config_conflict' });
        expect(state.snapshot).toBeNull();
    });

    it('maps a native endpoint key failure to a typed fail-closed result', async () => {
        const owner = await loadOwnerModule();
        const native = createNativeFake({
            createEndpoint: vi.fn(async () => {
                throw new Error('endpoint_key_unavailable: endpoint identity key is missing or corrupt');
            }),
        });

        const state = await owner.ensureHomeIrohEndpoint({ env: envFor(dataDir), apiPort: API_PORT, native });

        expect(state).toEqual({ status: 'failed', snapshot: null, failureReason: 'endpoint_key_unavailable' });
    });

    describe('resolveHomeIrohAcceptorPort', () => {
        it('derives the actual bound port from the Fastify server address', async () => {
            const owner = await loadOwnerModule();
            const api = { server: { address: () => ({ address: '0.0.0.0', family: 'IPv4', port: API_PORT }) } };
            expect(owner.resolveHomeIrohAcceptorPort(api)).toBe(API_PORT);
        });

        it('fails closed on a missing, string, or zero port', async () => {
            const owner = await loadOwnerModule();
            expect(owner.resolveHomeIrohAcceptorPort({ server: { address: () => null } })).toBeNull();
            expect(owner.resolveHomeIrohAcceptorPort({ server: { address: () => '/tmp/api.sock' } })).toBeNull();
            expect(owner.resolveHomeIrohAcceptorPort({
                server: { address: () => ({ address: '0.0.0.0', family: 'IPv4', port: 0 }) },
            })).toBeNull();
        });
    });
});
