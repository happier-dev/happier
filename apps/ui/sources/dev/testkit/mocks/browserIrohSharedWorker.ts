import { vi } from 'vitest';
import type { BrowserIrohClientCommand, BrowserIrohWorkerReply } from '@/sync/runtime/browserIroh/protocol';

/** SharedWorker/wasm transport only: the production endpoint client, carrier and HTTP codec stay real. */
export function installBrowserIrohSharedWorkerBoundary(options: Readonly<{
    respond?: (requestText: string) => Response | Promise<Response>;
    localEndpointId?: string;
    acquireFailures?: number;
}> = {}) {
    const commands: BrowserIrohClientCommand[] = [];
    const streams = new Map<string, { written: number[]; response: Uint8Array | null }>();
    let leaseSequence = 0;
    let streamSequence = 0;
    let remainingAcquireFailures = options.acquireFailures ?? 0;
    class SharedWorkerBoundary {
        onerror: ((event: unknown) => void) | null = null;
        readonly port: {
            postMessage: (message: BrowserIrohClientCommand) => void;
            addEventListener: (type: string, listener: (event: { data: BrowserIrohWorkerReply }) => void) => void;
        };
        constructor() {
            let receive: ((event: { data: BrowserIrohWorkerReply }) => void) | undefined;
            const answer = async (command: BrowserIrohClientCommand): Promise<BrowserIrohWorkerReply> => {
                const common = { v: 1 as const, requestId: command.requestId };
                switch (command.kind) {
                    case 'acquireLease':
                        if (remainingAcquireFailures > 0) {
                            remainingAcquireFailures -= 1;
                            return { ...common, kind: 'error', code: 'endpoint_unavailable', message: 'Endpoint temporarily unavailable' };
                        }
                        return { ...common, kind: 'leaseAcquired', leaseId: `lease-${++leaseSequence}`,
                            endpointId: options.localEndpointId ?? 'b'.repeat(64), appliedRelayUrls: command.relayUrls };
                    case 'releaseLease': case 'releaseClient': return { ...common, kind: 'released' };
                    case 'cancelRequest': return { ...common, kind: 'requestCancelled' };
                    case 'openStream': {
                        const streamId = `stream-${++streamSequence}`;
                        streams.set(streamId, { written: [], response: null });
                        return { ...common, kind: 'streamOpened', streamId, remoteEndpointId: command.endpointId, observedPath: 'relay' };
                    }
                    case 'status': return { ...common, kind: 'status', status: { state: 'ready',
                        endpointId: options.localEndpointId ?? 'b'.repeat(64), appliedRelayUrls: [], leaseCount: leaseSequence } };
                    case 'writeStream':
                        streams.get(command.streamId)!.written.push(...command.bytes);
                        return { ...common, kind: 'streamWritten' };
                    case 'finishStreamWrite': return { ...common, kind: 'streamWriteFinished' };
                    case 'cancelStream': return { ...common, kind: 'streamCancelled' };
                    case 'closeStream': return { ...common, kind: 'streamClosed' };
                    case 'readStream': {
                        const stream = streams.get(command.streamId)!;
                        if (stream.response === null) {
                            const response = await (options.respond?.(new TextDecoder().decode(Uint8Array.from(stream.written))) ?? Response.json({}));
                            const body = new Uint8Array(await response.arrayBuffer());
                            const headers = new Headers(response.headers);
                            headers.delete('transfer-encoding');
                            headers.set('content-length', String(body.length));
                            const head = new TextEncoder().encode(`HTTP/1.1 ${response.status} ${response.statusText}\r\n`
                                + [...headers].map(([name, value]) => `${name}: ${value}\r\n`).join('') + '\r\n');
                            stream.response = new Uint8Array(head.length + body.length);
                            stream.response.set(head); stream.response.set(body, head.length);
                        }
                        const bytes = stream.response.slice(0, command.maxBytes);
                        stream.response = stream.response.slice(bytes.length);
                        return { ...common, kind: 'streamRead', bytes, done: bytes.length === 0 };
                    }
                }
            };
            this.port = {
                addEventListener: (_type, listener) => { receive = listener; },
                postMessage: command => {
                    commands.push(command);
                    void answer(command).then(data => receive?.({ data }), () => receive?.({ data: {
                        v: 1, kind: 'error', requestId: command.requestId, code: 'endpoint_unavailable', message: 'Worker transport failed',
                    } }));
                },
            };
        }
    }
    vi.stubGlobal('SharedWorker', SharedWorkerBoundary);
    return { commands, writtenRequests: () => [...streams.values()].map(stream => new TextDecoder().decode(Uint8Array.from(stream.written))) };
}
