import { Duplex } from "node:stream";
import { connect as connectTls } from "node:tls";
import { isIP } from "node:net";
import type { LocalServicePreviewResourceV1 } from "@happier-dev/protocol";
import type { LocalServicePreviewTunnelStream } from "./httpAdapter.js";

/** Preserve occurrence refusal across socket/relay errors without classifying
 * arbitrary upstream errors or unknown observations as an ended preview. */
export function isPreviewOccurrenceEnded(error: unknown): boolean {
    return error instanceof Error && (error.message === 'preview_not_found'
        || 'reasonCode' in error && error.reasonCode === 'preview_not_found');
}

/** This closed policy refusal is safe to show to the admitted preview viewer. */
export function isPreviewPortNotAllowed(error: unknown): boolean {
    return error instanceof Error && 'reasonCode' in error && error.reasonCode === 'destination_port_not_allowed';
}

/** Native HTTP and TLS consume the same PMS byte stream; the daemon remains TCP-only. */
export function createPreviewUpstreamSocket(preview: LocalServicePreviewResourceV1, tunnel: LocalServicePreviewTunnelStream): Duplex {
    const iterator = tunnel.read()[Symbol.asyncIterator]();
    let reading = false;
    let eof = false;
    const socket = new Duplex({
        allowHalfOpen: true,
        read() {
            if (reading || eof) return;
            reading = true;
            void (async () => {
                try {
                    while (!socket.destroyed) {
                        const item = await iterator.next();
                        if (socket.destroyed) return;
                        if (item.done) { eof = true; socket.push(null); return; }
                        if (!socket.push(item.value)) return;
                    }
                } catch (error) { socket.destroy(error instanceof Error ? error : new Error(String(error))); }
                finally { reading = false; }
            })();
        },
        write(chunk: Buffer, _encoding, callback) {
            Promise.resolve().then(() => tunnel.write(chunk)).then(() => callback(), (error) => callback(error));
        },
        final(callback) {
            Promise.resolve().then(() => tunnel.endWrite()).then(() => callback(), (error) => callback(error));
        },
        destroy(error, callback) {
            // Releasing the consumer also settles a blocked read/write in the PMS owner.
            const reason = readPreviewUpstreamResponseFailure(error)
                ?? (error && ["client_aborted", "request_body_too_large", "response_body_too_large"].includes(error.message)
                    ? error.message : "preview_upstream_failed");
            Promise.resolve().then(() => error ? tunnel.abort(reason) : tunnel.close())
                .then(() => callback(error), (failure) => callback(error ?? failure));
        },
    });
    if (preview.target.scheme !== "https") return socket;
    return connectTls({ socket, host: preview.target.host,
        ...(isIP(preview.target.host) ? {} : { servername: preview.target.host }) });
}

export function readPreviewUpstreamResponseFailure(error: unknown): "response_header_too_large" | "upstream_response_invalid" | undefined {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "HPE_HEADER_OVERFLOW") return "response_header_too_large";
    if (typeof code === "string" && (code.startsWith("HPE_") || code === "ECONNRESET")) return "upstream_response_invalid";
    return undefined;
}
