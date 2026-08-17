import { describe, expect, it, vi } from "vitest";

import {
    createPluginCollectionHostReferenceResolver,
    type PluginCollectionHostReferenceAdapter,
    type PluginCollectionHostReferenceAdapters,
    type PluginCollectionHostReferenceKind,
} from "./hostReferences";
import { pluginCollectionHostReferenceResolver } from "./hostReferenceResolver";

function createAdapters(
    overrides: Partial<PluginCollectionHostReferenceAdapters> = {},
): PluginCollectionHostReferenceAdapters {
    const unavailableAdapter = <TKind extends PluginCollectionHostReferenceKind>(
        hostKind: TKind,
    ): PluginCollectionHostReferenceAdapter<TKind> => ({
        hostKind,
        async resolveInTx() {
            return { status: "unavailable" };
        },
    });

    return {
        account: unavailableAdapter("account"),
        machine: unavailableAdapter("machine"),
        session: unavailableAdapter("session"),
        message: unavailableAdapter("message"),
        artifact: unavailableAdapter("artifact"),
        connectedAccount: unavailableAdapter("connectedAccount"),
        ...overrides,
    };
}

describe("createPluginCollectionHostReferenceResolver", () => {
    it("delegates an account-scoped target only to its one declared host-domain adapter", async () => {
        const resolveMachine = vi.fn(async () => ({ status: "tombstone" as const }));
        const resolver = createPluginCollectionHostReferenceResolver(createAdapters({
            machine: {
                hostKind: "machine",
                resolveInTx: resolveMachine,
            } satisfies PluginCollectionHostReferenceAdapter,
        }));

        await expect(resolver.resolveInTx({
            tx: undefined as never,
            accountId: "account-1",
            hostKind: "machine",
            targetId: "machine-1",
        })).resolves.toEqual({ status: "tombstone" });
        expect(resolveMachine).toHaveBeenCalledWith({
            tx: undefined,
            accountId: "account-1",
            targetId: "machine-1",
        });
    });

    it("rejects an unsupported host kind instead of treating it as a missing target", async () => {
        const resolver = createPluginCollectionHostReferenceResolver(createAdapters());

        await expect(resolver.resolveInTx({
            tx: undefined as never,
            accountId: "account-1",
            hostKind: "project" as never,
            targetId: "project-1",
        })).rejects.toThrow(/unsupported host-reference kind/i);
    });

    it("recognizes only the exact active Account identity without turning a relation into account discovery", async () => {
        await expect(pluginCollectionHostReferenceResolver.resolveInTx({
            tx: undefined as never,
            accountId: "account-1",
            hostKind: "account",
            targetId: "account-1",
        })).resolves.toEqual({ status: "available" });
        await expect(pluginCollectionHostReferenceResolver.resolveInTx({
            tx: undefined as never,
            accountId: "account-1",
            hostKind: "account",
            targetId: "account-2",
        })).resolves.toEqual({ status: "unavailable" });
    });

});
