// Worker/structured cloning are the system boundary. The real production worker
// handler and canonical envelope crypto execute beneath this transport.
export class TestWebCryptoWorker {
    static instances: TestWebCryptoWorker[] = [];
    static failure: Error | null = null;
    static constructorFailure: Error | null = null;
    static transportFault: 'post' | 'message' | 'response' | 'runtime' | null = null;
    static failNextDispatch = false;
    static holdStartup = false;
    static hold = false;
    static responseDelayMs = 0;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    onmessageerror: (() => void) | null = null;
    terminated = false;
    requestBuffers: ArrayBuffer[] = [];
    replyBuffers: ArrayBuffer[] = [];
    pendingReplies: Array<() => Promise<void>> = [];

    constructor(readonly url: string | URL) {
        if (TestWebCryptoWorker.constructorFailure) throw TestWebCryptoWorker.constructorFailure;
        TestWebCryptoWorker.instances.push(this);
        if (!TestWebCryptoWorker.holdStartup) {
            queueMicrotask(() => {
                if (!this.terminated) this.onmessage?.({ data: { status: 'ready' } } as MessageEvent);
            });
        }
    }

    postMessage(message: unknown, transfer: ArrayBuffer[]) {
        if (TestWebCryptoWorker.transportFault === 'post') throw new Error('Cannot clone Worker request');
        this.requestBuffers = transfer;
        const data: unknown = structuredClone(message, { transfer });
        const failThisDispatch = TestWebCryptoWorker.failNextDispatch;
        TestWebCryptoWorker.failNextDispatch = false;
        const reply = async () => {
            if (TestWebCryptoWorker.transportFault === 'message') { this.onmessageerror?.(); return; }
            if (TestWebCryptoWorker.transportFault === 'response') {
                this.onmessage?.({ data: null } as MessageEvent);
                return;
            }
            if (TestWebCryptoWorker.transportFault === 'runtime') {
                this.onmessage?.({ data: { status: 'error', error: { name: 'Error', message: 'Worker runtime failed' } } } as MessageEvent);
                return;
            }
            if (failThisDispatch || TestWebCryptoWorker.failure) {
                this.onerror?.({ error: TestWebCryptoWorker.failure ?? new Error('First dispatch failed'), preventDefault() {} } as ErrorEvent);
                return;
            }
            const { installWebCryptoWorker } = await import('@/sync/encryption/nativeCryptoWorker/webCryptoWorkerRuntime');
            const port = {
                onmessage: null as ((event: MessageEvent) => void) | null,
                postMessage: (response: unknown, transfers: ArrayBuffer[]) => {
                    if ((response as { status?: unknown })?.status === 'ready') return;
                    this.replyBuffers = transfers;
                    const cloned: unknown = structuredClone(response, { transfer: transfers });
                    if (!this.terminated) this.onmessage?.({ data: cloned } as MessageEvent);
                },
            };
            installWebCryptoWorker(port);
            port.onmessage?.({ data } as MessageEvent);
        };
        if (TestWebCryptoWorker.hold) this.pendingReplies.push(reply);
        else if (TestWebCryptoWorker.responseDelayMs > 0) setTimeout(reply, TestWebCryptoWorker.responseDelayMs);
        else queueMicrotask(reply);
    }

    terminate() { this.terminated = true; }
}
