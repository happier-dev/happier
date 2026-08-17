import type { PluginCollectionRelationV1 } from "@happier-dev/protocol";

import type { Tx } from "@/storage/inTx";

export type PluginCollectionHostReferenceKind = Extract<
    PluginCollectionRelationV1,
    { kind: "host" }
>["hostKind"];

/**
 * Host domains decide only whether an Account-scoped public identity is
 * resolvable. Data persists and follows the relation identity, but never reads
 * a host domain's private tables or turns a relation into a capability grant.
 */
export type PluginCollectionHostReferenceResolution =
    | Readonly<{ status: "available" }>
    | Readonly<{ status: "tombstone" }>
    | Readonly<{ status: "unavailable" }>;

export type PluginCollectionHostReferenceAdapter<
    TKind extends PluginCollectionHostReferenceKind = PluginCollectionHostReferenceKind,
> = Readonly<{
    hostKind: TKind;
    resolveInTx(input: Readonly<{
        tx: Tx;
        accountId: string;
        targetId: string;
    }>): Promise<PluginCollectionHostReferenceResolution>;
}>;

/**
 * Data has a fixed, complete set of canonical host-domain adapters. Making
 * the composition total prevents a missing domain from being mistaken for a
 * target that simply is not present.
 */
export type PluginCollectionHostReferenceAdapters = Readonly<{
    [TKind in PluginCollectionHostReferenceKind]: PluginCollectionHostReferenceAdapter<TKind>;
}>;

export type PluginCollectionHostReferenceResolver = Readonly<{
    resolveInTx(input: Readonly<{
        tx: Tx;
        accountId: string;
        hostKind: PluginCollectionHostReferenceKind;
        targetId: string;
    }>): Promise<PluginCollectionHostReferenceResolution>;
}>;

function unsupportedHostReferenceKind(hostKind: never): never {
    throw new Error(`Unsupported host-reference kind: ${String(hostKind)}`);
}

/**
 * The sole Data composition point for host-reference domains. Each kind has
 * exactly one canonical host-domain adapter; a missing adapter fails closed.
 */
export function createPluginCollectionHostReferenceResolver(
    adapters: PluginCollectionHostReferenceAdapters,
): PluginCollectionHostReferenceResolver {
    return Object.freeze({
        async resolveInTx(input) {
            const { hostKind, ...adapterInput } = input;
            switch (hostKind) {
                case "account":
                    return await adapters.account.resolveInTx(adapterInput);
                case "machine":
                    return await adapters.machine.resolveInTx(adapterInput);
                case "session":
                    return await adapters.session.resolveInTx(adapterInput);
                case "message":
                    return await adapters.message.resolveInTx(adapterInput);
                case "artifact":
                    return await adapters.artifact.resolveInTx(adapterInput);
                case "connectedAccount":
                    return await adapters.connectedAccount.resolveInTx(adapterInput);
                default:
                    return unsupportedHostReferenceKind(hostKind);
            }
        },
    });
}
