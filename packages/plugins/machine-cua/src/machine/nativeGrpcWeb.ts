import type { PluginProcessResult } from '@happier-dev/plugin-sdk/exec';

// Native cua.env.v1 at trycua/cua@2bce4442c107fc34c45b374b29a35d09f630fd83:
// libs/cua/proto/cua/env/v1/{process,filesystem}.proto. Only the consumed
// buffered process and gRPC-Web unary-upload messages are encoded here.
const utf8 = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
function invalid(): never { throw new Error('cua_native_response_invalid'); }
function integer(value: number | bigint) {
    let remaining = BigInt(value);
    if (remaining < 0n) invalid();
    const bytes: number[] = [];
    do {
        bytes.push(Number(remaining & 127n) | (remaining > 127n ? 128 : 0));
        remaining >>= 7n;
    } while (remaining);
    return Buffer.from(bytes);
}
function numberField(id: number, value: number) {
    return Buffer.concat([integer(id * 8), integer(value)]);
}
function bytesField(id: number, value: Uint8Array | string) {
    const bytes = typeof value === 'string' ? utf8.encode(value) : value;
    return Buffer.concat([integer(id * 8 + 2), integer(bytes.length), bytes]);
}
type Fields = Map<number, bigint | Uint8Array>;
function fields(bytes: Uint8Array): Fields {
    let offset = 0;
    const readInteger = () => {
        let value = 0n;
        // Protobuf varints encode at most 64 bits in ten bytes.
        for (let index = 0; index < 10; index++) {
            const byte = bytes[offset++];
            if (byte === undefined || (index === 9 && byte > 1)) invalid();
            value |= BigInt(byte & 127) << BigInt(index * 7);
            if (!(byte & 128)) return value;
        }
        return invalid();
    };
    const result: Fields = new Map();
    while (offset < bytes.length) {
        const tag = Number(readInteger());
        const id = Math.floor(tag / 8);
        if (!id || id > 536_870_911) invalid();
        const wire = tag % 8;
        if (wire === 0) result.set(id, readInteger());
        else {
            const length = wire === 2 ? Number(readInteger()) : wire === 1 ? 8 : wire === 5 ? 4 : invalid();
            if (!Number.isSafeInteger(length) || length > bytes.length - offset) invalid();
            if (wire === 2) result.set(id, bytes.subarray(offset, offset + length));
            offset += length;
        }
    }
    return result;
}
function raw(message: Fields, id: number, required = false) {
    const value = message.get(id);
    if (value === undefined && !required) return new Uint8Array();
    if (!(value instanceof Uint8Array)) return invalid();
    return value;
}
function numeric(message: Fields, id: number) {
    const value = message.get(id) ?? 0n;
    if (typeof value !== 'bigint' || value > BigInt(Number.MAX_SAFE_INTEGER)) return invalid();
    return Number(value);
}
function string(message: Fields, id: number, required = false) {
    return decoder.decode(raw(message, id, required));
}

export function frameCuaGrpcWeb(message: Uint8Array) {
    const header = Buffer.alloc(5);
    header.writeUInt32BE(message.length, 1);
    return Buffer.concat([header, message]);
}
export function decodeCuaGrpcWeb(body: Uint8Array) {
    const messages: Uint8Array[] = [];
    let offset = 0;
    let complete = false;
    while (offset < body.length) {
        if (complete || body.length - offset < 5) invalid();
        const flag = body[offset];
        const length = new DataView(body.buffer, body.byteOffset + offset + 1, 4).getUint32(0);
        offset += 5;
        if (length > body.length - offset) invalid();
        const payload = body.subarray(offset, offset + length);
        offset += length;
        if (flag === 0) messages.push(payload);
        else if (flag === 128) {
            const statuses = decoder.decode(payload).split('\r\n')
                .filter(line => line.slice(0, line.indexOf(':')).toLowerCase() === 'grpc-status')
                .map(line => line.slice(line.indexOf(':') + 1).trim());
            if (statuses.length !== 1 || statuses[0] !== '0') invalid();
            complete = true;
        } else invalid(); // Compression was not requested by this native client.
    }
    if (!complete) invalid();
    return messages;
}
export function encodeCuaStartProcess(argv: readonly string[]) {
    const config = Buffer.concat([bytesField(1, argv[0]), ...argv.slice(1).map(arg => bytesField(2, arg))]);
    // Native stdin=false is /dev/null. Private bytes arrive in a guest file.
    // The server terminates this process when the cancelled HTTP stream closes.
    return Buffer.concat([bytesField(1, config), numberField(7, 1)]);
}
const signals: Readonly<Record<number, string>> = { 1: 'SIGHUP', 2: 'SIGINT', 3: 'SIGQUIT', 9: 'SIGKILL',
    10: 'SIGUSR1', 12: 'SIGUSR2', 15: 'SIGTERM', 18: 'SIGCONT', 19: 'SIGSTOP', 20: 'SIGTSTP', 28: 'SIGWINCH' };
export function decodeCuaProcess(messages: readonly Uint8Array[]): PluginProcessResult {
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    let started = false;
    let termination: PluginProcessResult['termination'] | undefined;
    let offset = 0;
    for (const message of messages) {
        if (termination) invalid();
        const event = fields(raw(fields(message), 1, true));
        const kinds = [1, 2, 3, 4].filter(id => event.has(id));
        if (kinds.length !== 1) invalid();
        if (kinds[0] === 1) {
            if (started || numeric(fields(raw(event, 1)), 4) !== 0) invalid();
            started = true;
        } else if (!started) invalid();
        else if (kinds[0] === 2) {
            const data = fields(raw(event, 2));
            const outputs = [2, 3, 4].filter(id => data.has(id));
            if (outputs.length !== 1 || outputs[0] === 4 || numeric(data, 1) !== offset) invalid();
            const bytes = raw(data, outputs[0], true);
            (outputs[0] === 2 ? stdout : stderr).push(bytes);
            offset += bytes.length;
        } else if (kinds[0] === 3) {
            const end = fields(raw(event, 3));
            const timedOut = numeric(end, 3) !== 0;
            const signal = numeric(end, 2);
            const exit = end.get(1);
            const error = string(end, 4);
            if (error) termination = { observed: { kind: 'failed', diagnostic: {
                code: 'cua_guest_process_failed', severity: 'error',
            } }, requestedBy: { kind: 'none' } };
            else if (typeof exit === 'bigint' && !signal) termination = {
                observed: { kind: 'exit', exitCode: Number(BigInt.asIntN(32, exit)) },
                requestedBy: { kind: timedOut ? 'timeout' : 'none' },
            };
            else if (signal && signals[signal] && exit === undefined) termination = {
                observed: { kind: 'signal', signal: signals[signal] }, requestedBy: { kind: timedOut ? 'timeout' : 'none' },
            };
            else invalid();
        }
    }
    if (!started || !termination) return invalid();
    return { termination, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), stdoutTruncated: false, stderrTruncated: false };
}
function unary(messages: readonly Uint8Array[]) {
    if (messages.length !== 1) return invalid();
    return fields(messages[0]);
}
export function encodeCuaBeginUpload(path: string, size: number, sha256: string, uploadId: string) {
    const header = Buffer.concat([bytesField(1, path), numberField(2, 1), numberField(3, 0o600),
        numberField(5, size), bytesField(6, sha256)]);
    return Buffer.concat([bytesField(1, header), bytesField(2, uploadId)]);
}
export function decodeCuaBeginUpload(messages: readonly Uint8Array[]) {
    const message = unary(messages);
    const uploadId = string(message, 1, true);
    const received = numeric(message, 2);
    const maxChunkBytes = numeric(message, 3);
    if (!uploadId || maxChunkBytes <= 0 || maxChunkBytes > 4_294_967_295) return invalid();
    return { uploadId, received, maxChunkBytes };
}
export function encodeCuaUploadChunk(uploadId: string, offset: number, bytes: Uint8Array) {
    return Buffer.concat([bytesField(1, uploadId), numberField(2, offset), bytesField(3, bytes)]);
}
export function decodeCuaUploadChunk(messages: readonly Uint8Array[]) { return numeric(unary(messages), 1); }
export function encodeCuaCommitUpload(uploadId: string, sha256: string) {
    return Buffer.concat([bytesField(1, uploadId), bytesField(2, sha256)]);
}
export function decodeCuaUploadSha256(messages: readonly Uint8Array[]) { return string(unary(messages), 2, true); }
export function encodeCuaAbortUpload(uploadId: string) { return bytesField(1, uploadId); }
export function decodeCuaAbortUpload(messages: readonly Uint8Array[]) { unary(messages); }
