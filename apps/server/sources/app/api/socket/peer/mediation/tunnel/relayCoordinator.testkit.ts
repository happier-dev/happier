import { PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT } from "@happier-dev/protocol";

// Relative, not aliased: the CLI relay test imports this testkit across packages
// to drive the real server handler, and cannot resolve the server `@/` alias.
import { getSocketRooms } from "../../../../socketRooms";

import type {
    PeerTcpTunnelRelayAdmissionResult,
    PeerTcpTunnelRelayCoordinator,
} from "./relayCoordinator";

type RelayCoordinatorTestIo = Readonly<{
    to(room: string): Readonly<{ emit(event: string, payload: unknown): unknown }>;
}>;

function machineRoom(accountId: string, machineId: string): string {
    const rooms = getSocketRooms({
        userId: accountId,
        clientType: "machine-scoped",
        machineId,
    });
    return rooms.find((room) => room.startsWith(`machine:${machineId}:`))
        ?? `machine:${machineId}:${accountId}`;
}

const coordinatorsByIo = new WeakMap<object, Map<string, PeerTcpTunnelRelayCoordinator>>();

/**
 * The in-memory cluster coordinator for relay handler tests.
 *
 * `registerPeerTcpTunnelRelaySocketHandler` requires a coordinator: it is the one
 * decision-maker for single-use relay-grant consumption and exact-machine attachment.
 * This testkit reproduces that contract without a live Socket.IO server — one attachment
 * per tunnel key, a grant id spendable exactly once, and owner→machine delivery into the
 * exact machine room — so a test observes the same emissions production would produce.
 *
 * One server has ONE coordinator, so repeated calls for the same `io` and account return
 * the same instance. A test that registers a user socket and its machine socket therefore
 * gets the production topology: both handlers observe one admission ledger and one
 * attachment table, exactly as `apps/server/sources/app/api/socket.ts` wires them.
 */
export function createRelayTestCoordinator(
    io: RelayCoordinatorTestIo,
    accountId = "user_1",
): PeerTcpTunnelRelayCoordinator {
    let byAccount = coordinatorsByIo.get(io);
    if (!byAccount) {
        byAccount = new Map();
        coordinatorsByIo.set(io, byAccount);
    }
    const existing = byAccount.get(accountId);
    if (existing) return existing;
    const created = buildRelayTestCoordinator(io, accountId);
    byAccount.set(accountId, created);
    return created;
}

function buildRelayTestCoordinator(
    io: RelayCoordinatorTestIo,
    accountId: string,
): PeerTcpTunnelRelayCoordinator {
    const attachmentsByTunnelKey = new Map<string, Readonly<{
        machineId: string;
        onMachineDisconnect: () => void | Promise<void>;
    }>>();
    const consumedGrantIds = new Set<string>();
    const coordinator: PeerTcpTunnelRelayCoordinator = {
        admit: async (input): Promise<PeerTcpTunnelRelayAdmissionResult> => {
            if (consumedGrantIds.has(input.grantId)) {
                return { status: "rejected", reason: "grant_already_consumed" };
            }
            consumedGrantIds.add(input.grantId);
            attachmentsByTunnelKey.set(input.tunnelKey, {
                machineId: input.machineId,
                onMachineDisconnect: () => input.onMachineDisconnect(),
            });
            return { status: "attached" };
        },
        routeMachineEnvelope: (input) => (
            attachmentsByTunnelKey.has(input.tunnelKey) ? "local_exact" : "rejected"
        ),
        routeOwnerEnvelope: (input) => {
            const attachment = attachmentsByTunnelKey.get(input.tunnelKey);
            if (!attachment) return false;
            io.to(machineRoom(accountId, attachment.machineId)).emit(
                PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT,
                input.envelope,
            );
            return true;
        },
        release: (tunnelKey) => {
            attachmentsByTunnelKey.delete(tunnelKey);
        },
        close: async () => {
            attachmentsByTunnelKey.clear();
        },
    };
    machineDisconnectorsByCoordinator.set(coordinator, async (machineId) => {
        const affected = [...attachmentsByTunnelKey.entries()]
            .filter(([, attachment]) => attachment.machineId === machineId);
        for (const [tunnelKey, attachment] of affected) {
            attachmentsByTunnelKey.delete(tunnelKey);
            await attachment.onMachineDisconnect();
        }
    });
    return coordinator;
}

const machineDisconnectorsByCoordinator = new WeakMap<
    PeerTcpTunnelRelayCoordinator,
    (machineId: string) => Promise<void>
>();

/**
 * Drops the exact machine attachment the way the real coordinator does when the
 * machine socket disconnects: the coordinator — not the machine's own relay handler —
 * owns that socket and notifies the tunnel owner. A test that only fires the machine
 * socket's `disconnect` event is asserting the retired coordinator-free topology.
 */
export async function disconnectRelayTestMachine(
    coordinator: PeerTcpTunnelRelayCoordinator,
    machineId: string,
): Promise<void> {
    await machineDisconnectorsByCoordinator.get(coordinator)?.(machineId);
}
