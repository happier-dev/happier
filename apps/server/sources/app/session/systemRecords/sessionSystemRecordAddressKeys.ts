import { createHash } from "node:crypto";

const encoder = new TextEncoder();
const NAMESPACE_DOMAIN = "happier.session-system-record.namespace.v1";
const RECORD_DOMAIN = "happier.session-system-record.record.v1";

export type PersistedSessionSystemRecordAddress = Readonly<{
    ownerKind: "host" | "plugin";
    pluginId: string | null;
    namespace: string;
    localId: string;
}>;

function u32be(value: number): Uint8Array<ArrayBuffer> {
    const output = new Uint8Array(new ArrayBuffer(4));
    new DataView(output.buffer).setUint32(0, value, false);
    return output;
}

function tupleBytes(fields: readonly string[]): Uint8Array[] {
    return fields.flatMap((field) => {
        const bytes = encoder.encode(field);
        return [u32be(bytes.byteLength), bytes];
    });
}

function digest(domain: string, fields: readonly string[]): Uint8Array<ArrayBuffer> {
    const hash = createHash("sha256");
    hash.update(encoder.encode(domain));
    hash.update(Uint8Array.of(0));
    for (const part of tupleBytes(fields)) hash.update(part);
    const output = new Uint8Array(new ArrayBuffer(32));
    output.set(hash.digest());
    return output;
}

export function deriveSessionSystemRecordAddressKeys(address: PersistedSessionSystemRecordAddress): Readonly<{
    namespaceAddressKey: Uint8Array<ArrayBuffer>;
    recordAddressKey: Uint8Array<ArrayBuffer>;
}> {
    const common = [address.ownerKind, address.pluginId ?? "", address.namespace];
    return {
        namespaceAddressKey: digest(NAMESPACE_DOMAIN, common),
        recordAddressKey: digest(RECORD_DOMAIN, [...common, address.localId]),
    };
}

export function sessionSystemRecordRawAddressEquals(
    left: PersistedSessionSystemRecordAddress,
    right: PersistedSessionSystemRecordAddress,
): boolean {
    return left.ownerKind === right.ownerKind
        && left.pluginId === right.pluginId
        && left.namespace === right.namespace
        && left.localId === right.localId;
}
