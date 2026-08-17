import { Buffer } from "node:buffer";

import { SessionSystemRecordRevisionSchema } from "@happier-dev/protocol";

const MAX_RECORD_ID_UTF8_BYTES = 512;
const SESSION_SYSTEM_RECORD_VERSION_MAX = 2_147_483_647;

export type ParsedSessionSystemRecordRevision = Readonly<{ id: string; version: number }>;

export function encodeSessionSystemRecordRevision(input: ParsedSessionSystemRecordRevision): string {
    const idBytes = Buffer.from(input.id, "utf8");
    if (idBytes.byteLength === 0 || idBytes.byteLength > MAX_RECORD_ID_UTF8_BYTES) throw new Error("Invalid record id");
    if (!Number.isInteger(input.version) || input.version < 1 || input.version > SESSION_SYSTEM_RECORD_VERSION_MAX) {
        throw new Error("Invalid record version");
    }
    const bytes = Buffer.allocUnsafe(4 + idBytes.byteLength + 4);
    bytes.writeUInt32BE(idBytes.byteLength, 0);
    idBytes.copy(bytes, 4);
    bytes.writeUInt32BE(input.version, 4 + idBytes.byteLength);
    return `ssr1.${bytes.toString("base64url")}`;
}

export function parseSessionSystemRecordRevision(value: unknown): ParsedSessionSystemRecordRevision | null {
    const parsed = SessionSystemRecordRevisionSchema.safeParse(value);
    if (!parsed.success) return null;
    const encoded = parsed.data.slice("ssr1.".length);
    try {
        const bytes = Buffer.from(encoded, "base64url");
        if (bytes.toString("base64url") !== encoded || bytes.byteLength < 9) return null;
        const idLength = bytes.readUInt32BE(0);
        if (idLength < 1 || idLength > MAX_RECORD_ID_UTF8_BYTES || bytes.byteLength !== 4 + idLength + 4) return null;
        const idBytes = bytes.subarray(4, 4 + idLength);
        const id = idBytes.toString("utf8");
        if (Buffer.from(id, "utf8").compare(idBytes) !== 0) return null;
        const version = bytes.readUInt32BE(4 + idLength);
        if (version < 1 || version > SESSION_SYSTEM_RECORD_VERSION_MAX) return null;
        return { id, version };
    } catch {
        return null;
    }
}
