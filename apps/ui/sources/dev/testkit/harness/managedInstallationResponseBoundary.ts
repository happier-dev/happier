import { vi } from 'vitest';
import nacl from 'tweetnacl';
import { ManagedInstallationResponseV1Schema, type ManagedInstallationResponseV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { readHostAdmittedReviewedParentV1 } from '@happier-dev/protocol/actions/actionExecutor';
import type { HostReviewedChildPortV1 } from '@happier-dev/protocol/actions/executor/types';

import { encodeBase64 } from '@/encryption/base64';
import { primeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { createRootLayoutFeaturesResponse } from '../fixtures/featureFixtures';
import type { createHomeGovernanceHarness } from './homeGovernanceHarness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from './serverAccountConnectionHarness';

/** Only the requester Home HTTP and installed controller Socket are replaced; the response Action and pairing stay real. */
export function installManagedInstallationResponseBoundary(input: Readonly<{
    homes: ReturnType<typeof createHomeGovernanceHarness>;
    serverId: string;
    serverUrl: string;
    homeId: string;
    token: string;
    enrollmentAccountId: string;
    readMachine: () => ManagedMachineV1;
    onAnswer: (response: ManagedInstallationResponseV1) => void;
    refuseAnswer?: string;
    readReviewedChild?: () => HostReviewedChildPortV1 | undefined;
}>) {
    const answers: ManagedInstallationResponseV1[] = [];
    const deliveries: ManagedInstallationResponseV1[] = [];
    const guest = nacl.box.keyPair();
    const features = createRootLayoutFeaturesResponse({ features: { encryption: { plaintextStorage: { enabled: true } },
        e2ee: { keylessAccounts: { enabled: true } } }, capabilities: { serverIdentity: { serverIdentityId: input.homeId } } });
    input.homes.answer(input.serverId, '/v1/features', { body: features });
    input.homes.answer(input.serverId, '/v1/features/authenticated', { body: features });
    primeServerFeaturesSnapshot({ serverId: input.serverId, snapshot: { status: 'ready', features } });
    input.homes.answer(input.serverId, '/v1/machines/managed/actions/get', { select: () => ({ body: input.readMachine() }) });
    input.homes.answer(input.serverId, '/v1/auth/request/status', { body: { status: 'pending', supportsV2: true } });
    input.homes.answer(input.serverId, '/v1/auth/response', { body: { success: true } });
    const registration = installDisconnectedServerSocketBoundary(socket => {
        configureConnectedServerSocketBoundary(socket);
        socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event, packet) => {
            if (event !== SOCKET_RPC_EVENTS.CALL) return {};
            const outer = packet && typeof packet === 'object' && 'params' in packet ? packet.params : undefined;
            const response = ManagedInstallationResponseV1Schema.parse(outer && typeof outer === 'object' && 'params' in outer ? outer.params : undefined);
            if (response.delivery) {
                deliveries.push(response);
                const reviewedParent = readHostAdmittedReviewedParentV1(input.readReviewedChild?.());
                return { ok: true, result: { ok: true, result: {
                    publicKey: encodeBase64(guest.publicKey), homeServerIdentityId: input.homeId,
                    enrollmentAccountId: input.enrollmentAccountId, supportsTokenOnly: true, pairingRequirement: 'v3',
                    pairing: { secretB64Url: encodeBase64(new Uint8Array(32).fill(9), 'base64url'),
                        createdAtMs: Date.now(), expiresAtMs: Date.now() + 60_000 },
                    ...(reviewedParent ? { reviewedParent: { actionId: reviewedParent.actionId } } : {}),
                } } };
            }
            answers.push(response);
            if (input.refuseAnswer) return { ok: true, result: { ok: false, error: { code: input.refuseAnswer, message: 'Question changed' } } };
            input.onAnswer(response);
            return { ok: true, result: { ok: true, result: { ok: true } } };
        });
    }, { serverUrl: input.serverUrl, token: input.token });
    return { answers, deliveries, dispose: registration.dispose };
}
