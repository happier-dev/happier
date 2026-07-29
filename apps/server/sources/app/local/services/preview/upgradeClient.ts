import type { LocalServicePreviewWebSocketClient } from "@/app/local/services/preview/websocketAdapter";
import { writeLocalServicePreviewDownstream } from "@/app/local/services/preview/downstream";

const textEncoder = new TextEncoder();

type UpgradeSocketEvent = "close" | "drain" | "error";

export type LocalServicePreviewUpgradeSocket = {
    write?: (chunk: Uint8Array) => unknown;
    end?: () => unknown;
    destroy?: (error?: Error) => unknown;
    once?: (event: UpgradeSocketEvent, listener: () => void) => unknown;
    on?: (event: UpgradeSocketEvent, listener: () => void) => unknown;
    off?: (event: UpgradeSocketEvent, listener: () => void) => unknown;
    removeListener?: (event: UpgradeSocketEvent, listener: () => void) => unknown;
    destroyed?: boolean;
    writableEnded?: boolean;
    [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
};

async function* socketChunks(socket: LocalServicePreviewUpgradeSocket): AsyncIterable<Uint8Array> {
    const iterator = socket[Symbol.asyncIterator]?.();
    if (!iterator) {
        return;
    }
    for (;;) {
        const next = await iterator.next();
        if (next.done) {
            return;
        }
        const chunk = next.value;
        yield chunk instanceof Uint8Array ? chunk : textEncoder.encode(String(chunk));
    }
}

export function createLocalServicePreviewUpgradeClient(
    socket: LocalServicePreviewUpgradeSocket,
): LocalServicePreviewWebSocketClient {
    return {
        read: () => socketChunks(socket),
        write(chunk) {
            return writeLocalServicePreviewDownstream(socket, chunk);
        },
        end() {
            socket.end?.();
        },
        destroy(error) {
            socket.destroy?.(error instanceof Error ? error : error === undefined ? undefined : new Error(String(error)));
        },
    };
}

export async function writeLocalServicePreviewUpgradeError(
    socket: LocalServicePreviewUpgradeSocket,
    statusCode: number,
    statusMessage: string,
): Promise<void> {
    try {
        await writeLocalServicePreviewDownstream(socket, textEncoder.encode([
            `HTTP/1.1 ${statusCode} ${statusMessage}`,
            "Connection: close",
            "Content-Length: 0",
            "",
            "",
        ].join("\r\n")));
    } catch {
        // Upgrade error responses are terminal best-effort writes; close/error before drain is expected.
    } finally {
        socket.destroy?.();
    }
}
