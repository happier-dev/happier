import type { Server } from "socket.io";
import { describe, expect, it, vi } from "vitest";

import { createPeerMediationViewerSocketOwnershipVerifier } from "./viewerSocketOwnership";

function createIo(input: Readonly<{
    local?: Readonly<{ id: string; connected: boolean; data: Record<string, unknown> }>;
    remote?: Readonly<{ id: string; connected: boolean; data: Record<string, unknown> }>;
    remoteLookupError?: Error;
}>): Pick<Server, "in" | "sockets"> {
    const localSockets = new Map(input.local ? [[input.local.id, input.local]] : []);
    const fetchSockets = vi.fn(async () => {
        if (input.remoteLookupError) throw input.remoteLookupError;
        return input.remote ? [input.remote] : [];
    });
    // This fixture mirrors only the Socket.IO lookup boundary consumed by the verifier.
    return {
        sockets: { sockets: localSockets },
        in: vi.fn(() => ({ fetchSockets })),
    } as unknown as Pick<Server, "in" | "sockets">;
}

describe("createPeerMediationViewerSocketOwnershipVerifier", () => {
    it("accepts an authenticated user-scoped socket discovered on another adapter replica", async () => {
        const io = createIo({
            remote: {
                id: "relay_socket_remote",
                connected: true,
                data: { userId: "account_1", clientType: "user-scoped" },
            },
        });
        const verify = createPeerMediationViewerSocketOwnershipVerifier(io);

        await expect(verify({
            accountId: "account_1",
            socketId: "relay_socket_remote",
        })).resolves.toBe(true);
        expect(io.in).toHaveBeenCalledWith("relay_socket_remote");
    });

    it("rejects a remote socket owned by another account", async () => {
        const verify = createPeerMediationViewerSocketOwnershipVerifier(createIo({
            remote: {
                id: "relay_socket_remote",
                connected: true,
                data: { userId: "account_2", clientType: "user-scoped" },
            },
        }));

        await expect(verify({
            accountId: "account_1",
            socketId: "relay_socket_remote",
        })).resolves.toBe(false);
    });

    it("fails closed when the adapter-wide socket lookup fails", async () => {
        const verify = createPeerMediationViewerSocketOwnershipVerifier(createIo({
            remoteLookupError: new Error("adapter unavailable"),
        }));

        await expect(verify({
            accountId: "account_1",
            socketId: "relay_socket_remote",
        })).resolves.toBe(false);
    });
});
