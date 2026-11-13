import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import axios from 'axios';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIrohNodeNativeModule } from '@happier-dev/iroh-native/node';
import { MACHINE_PLAIN_DATA_KEY_MARKER, decodeBase64, encodePlainMachineStoredContent } from '@happier-dev/protocol';

import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { registerAccountEncryptionRoutes } from '@/app/api/routes/account/registerAccountEncryptionRoutes';
import { machinesRoutes } from '@/app/api/routes/machines/machinesRoutes';
import { resolveServerFeaturesForGating } from '@/app/features/catalog/serverFeatureGate';
import { createAccountTokenForTests, createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { db } from '@/storage/db';
import { registerPeerMediationGrantRoutes } from './registerPeerMediationGrantRoutes';
import { ApiClient } from '../../../../../../../../cli/src/api/api';
import { runWithServerHttpBaseUrl } from '../../../../../../../../cli/src/api/client/serverHttpBaseUrl';
import { createDaemonMachineIrohRuntime } from '../../../../../../../../cli/src/daemon/peer/iroh/daemonMachineIrohRuntime';
import { createWorkspaceMachineCarrierTunnelOpen } from '../../../../../../../../cli/src/daemon/peer/iroh/workspaceMachineCarrierTunnelOpen';

describe('Home route issuance consumed by the production workspace carrier', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-route-carrier-', initAuth: true, env: {
            HAPPIER_MANAGED_RELAY_PURPOSE: undefined,
            HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID: undefined,
            HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY: undefined,
            HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PUBLIC_KEY: undefined,
            HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_EXPIRES_AT: undefined,
            HAPPIER_FEATURE_MACHINES_TRANSFER_DIRECT_PEER__ENABLED: 'true',
            HAPPIER_FEATURE_MACHINES_RPC_DIRECT_PEER__ENABLED: 'true',
        } });
    }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });

    it.each([
        { flow: 'file_transfer', sharedTarget: false },
        { flow: 'workspace_sync', sharedTarget: false },
        { flow: 'workspace_sync', sharedTarget: true },
    ] as const)('uses the default Home signer for $flow (shared target: $sharedTarget) and preserves a route refusal before native dial', async ({ flow, sharedTarget }) => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const targetCustodian = sharedTarget ? await db.account.create({ data: { encryptionMode: 'plain' } }) : account;
        const endpoints = ['a'.repeat(64), 'b'.repeat(64)];
        const machines = await Promise.all(endpoints.map((endpointId, index) => db.machine.create({ data: {
            id: randomUUID(), accountId: index === 1 ? targetCustodian.id : account.id, active: true, installationId: randomUUID(),
            metadata: encodePlainMachineStoredContent({ host: 'carrier', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/carrier', happyHomeDir: '/home/carrier/.happier' }),
            dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
            operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: { irohMachineEndpoint: { protocolVersions: [1], endpointId,
                directAddresses: ['127.0.0.1:7777'] } },
        } })));
        const source = machines[0]!;
        const target = machines[1]!;
        if (sharedTarget) await db.machineGrant.create({ data: { principalKind: 'account',
            machineId: target.id, accountId: account.id, accessLevel: 'admin', createdByAccountId: targetCustodian.id,
        } });
        const home = Fastify().withTypeProvider<ZodTypeProvider>();
        home.setValidatorCompiler(validatorCompiler);
        home.setSerializerCompiler(serializerCompiler);
        enableAuthentication(home);
        registerAccountEncryptionRoutes(home);
        machinesRoutes(home);
        registerPeerMediationGrantRoutes(home, { env: harness.envBase });
        let nativeDials = 0;
        const unexpected = async (): Promise<never> => { throw new Error('Unexpected native operation'); };
        const endpointStatus = { endpointHandle: 'carrier-source', endpointId: endpoints[0],
            relayMode: 'disabled', relayPolicy: 'disabled', relayUrls: [], directAddresses: [], capProfile: 'machineBulk', active: true };
        // Only the native C ABI is substituted. HTTP, auth, SQLite admission,
        // signer, capability reader, proof and daemon verification remain real.
        const runtime = await createDaemonMachineIrohRuntime({ happyHomeDir: harness.baseDir, identity: 'ephemeral',
            relayConfig: { relayPolicy: 'disabled', relayUrls: [] },
            native: createIrohNodeNativeModule({
                getAvailability: () => ({ available: true, os: 'linux', arch: 'x64', engine: 'fixture', surface: [] }),
                createEndpoint: async () => JSON.stringify({ ok: true, result: endpointStatus }),
                getEndpointStatus: async () => JSON.stringify({ ok: true, result: endpointStatus }),
                startMachineTunnel: async () => {
                    nativeDials++;
                    return JSON.stringify({ ok: true, result: { machineTunnelId: 'carrier-tunnel', endpointHandle: 'carrier-source',
                        localPort: 48123, ...(flow === 'workspace_sync' ? { localCapability: 'c'.repeat(64) } : {}), connectionActive: true,
                        remoteEndpointId: endpoints[1], observedPath: 'direct', startedAtMs: 1, lastErrorCode: null } });
                },
                stopMachineTunnel: async () => JSON.stringify({ ok: true, result: null }),
                shutdownEndpoint: async () => JSON.stringify({ ok: true, result: null }),
                startHomeAcceptor: unexpected, stopHomeAcceptor: unexpected, ensureHomeTunnel: unexpected,
                releaseHomeTunnel: unexpected, getTunnelStatus: unexpected, startMachineAcceptor: unexpected,
                stopMachineAcceptor: unexpected, getMachineAcceptorStatus: unexpected,
                startMachineHttpTunnel: unexpected, getMachineTunnelStatus: unexpected,
            }),
        });
        try {
            if (!runtime.available) throw runtime.reason === 'startup_failed' ? runtime.error : new Error(runtime.message);
            const origin = await home.listen({ host: '127.0.0.1', port: 0 });
            const token = await createAccountTokenForTests(account.id, { kind: 'terminal', authority: 'account_automation' });
            const api = await ApiClient.create({ token, encryption: null });
            const roots = resolveServerFeaturesForGating(harness.envBase).capabilities.machines.peerMediation.grantSigningKeys;
            expect(roots).toHaveLength(1);
            const mintedRequests: unknown[] = [];
            const open = createWorkspaceMachineCarrierTunnelOpen({ accountId: account.id, localMachineId: source.id,
                runtime, resolveTrustRoots: () => roots,
                readTargetMachine: async (machineId, signal) => api.getMachine(machineId, signal ? { signal } : undefined),
                mintGrant: async (request, signal) => {
                    mintedRequests.push(request);
                    return api.mintPeerMediationRouteGrant(request, signal ? { signal } : undefined);
                },
            });
            const operationId = randomUUID();
            const openRequestedTunnel = () => flow === 'file_transfer'
                ? open({ flow, sourceMachineId: source.id, targetMachineId: target.id })
                : open({ flow, operationId, sourceMachineId: source.id, targetMachineId: target.id });
            await runWithServerHttpBaseUrl(origin, async () => {
                const tunnel = await openRequestedTunnel().catch((error: unknown) => {
                    // A failed HTTP fixture must not print its generated bearer.
                    if (axios.isAxiosError(error)) throw new Error(`Composed grant request failed with HTTP ${error.response?.status ?? 'transport'}`);
                    throw error;
                });
                expect(tunnel).toMatchObject({ localPort: 48123, observedPath: 'direct' });
                await tunnel.close();
                expect(nativeDials).toBe(1);
                if (sharedTarget) {
                    // Transport-only issuance still needs the requester's current
                    // Machine admission; a withdrawn share mints nothing.
                    await db.machineGrant.deleteMany({ where: { principalKind: 'account', machineId: target.id, accountId: account.id } });
                    await expect(api.mintPeerMediationRouteGrant(mintedRequests.at(-1))).rejects.toMatchObject({
                        code: 'peer_unavailable', reasonCode: expect.any(String) });
                    await db.machineGrant.create({ data: { principalKind: 'account',
                        machineId: target.id, accountId: account.id, accessLevel: 'admin', createdByAccountId: targetCustodian.id,
                    } });
                }

                await db.machine.update({ where: { id: source.id }, data: { operationProtocolCapabilities: {} } });
                await expect(openRequestedTunnel()).rejects.toMatchObject({ code: 'peer_unavailable',
                    reasonCode: 'machine_iroh_endpoint_unavailable',
                    message: 'Peer mediation route grant is unavailable: machine_iroh_endpoint_unavailable' });
                await db.machine.update({ where: { id: source.id }, data: { operationProtocolCapabilities: {
                    irohMachineEndpoint: { protocolVersions: [1], endpointId: 'd'.repeat(64) },
                } } });
                await expect(openRequestedTunnel()).rejects.toMatchObject({ code: 'peer_unavailable',
                    reasonCode: 'machine_iroh_endpoint_mismatch' });
                await db.machine.update({ where: { id: source.id }, data: { revokedAt: new Date() } });
                await expect(openRequestedTunnel()).rejects.toMatchObject({ code: 'peer_unavailable',
                    reasonCode: 'machine_unavailable' });
                expect(nativeDials).toBe(1);
            });
        } finally {
            await runtime.shutdown();
            await home.close();
        }
    });
});
