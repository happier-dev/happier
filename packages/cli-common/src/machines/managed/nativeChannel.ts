import { Duplex } from 'node:stream';
import type { ManagedEnrollmentCorrelationV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { MachineProvisionerNativeStreamResultV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import type { ManagedNativeInvocation } from './reconcile.js';

// Node-only: `managed/index.ts` (bundled for the web UI) must not re-export this module.
// Node callers import it through `@happier-dev/cli-common/machines/managed/nativeChannel`.

type ChannelSink = Readonly<{ write(data: Uint8Array): Promise<void>; closeStdin(): Promise<void> }>;
export type ManagedNativeChannelTermination = ReturnType<typeof MachineProvisionerNativeStreamResultV1Schema.parse>['termination'];

/**
 * A provider's optional `stream` role as one duplex byte channel: written bytes
 * reach the guest process's stdin, its stdout is readable, stderr is dropped.
 * The channel lives as long as the role's invocation; destroying it aborts the
 * invocation. Its end says only that the carrier ended (`carrierTermination`),
 * never that the guest process exited: callers treat it as "state unknown".
 */
export class ManagedNativeChannel extends Duplex {
    carrierTermination: ManagedNativeChannelTermination | null = null;
    private sink: ChannelSink | null = null;
    private readonly waiting: Array<() => void> = [];
    private readonly abort = new AbortController();

    constructor(invoke: ManagedNativeInvocation, body: Readonly<{ resource: unknown; argv: readonly string[] }>, signal?: AbortSignal) {
        super({ allowHalfOpen: true });
        signal?.addEventListener('abort', () => this.destroy(), { once: true });
        const settled = invoke('stream', body, {
            signal: signal ? AbortSignal.any([signal, this.abort.signal]) : this.abort.signal,
            channel: {
                onOutput: output => { if (output.stream === 'stdout' && !this.destroyed) this.push(Buffer.from(output.data)); },
                bindInput: process => {
                    this.sink = process;
                    for (const resume of this.waiting.splice(0)) resume();
                    return () => { if (this.sink === process) this.sink = null; };
                },
            },
        });
        settled.then(result => {
            this.carrierTermination = MachineProvisionerNativeStreamResultV1Schema.parse(result).termination;
            this.sink = null;
            // Output already delivered stays readable; the channel closes once it is consumed.
            this.once('end', () => this.destroy());
            this.push(null);
        }, (error: unknown) => {
            this.destroy(error instanceof Error ? error : new Error(String(error)));
        });
    }

    private bound(): Promise<ChannelSink | null> {
        if (this.sink || this.destroyed) return Promise.resolve(this.sink);
        return new Promise(resolve => this.waiting.push(() => resolve(this.sink)));
    }

    override _read(): void { /* Output is pushed as the provider delivers it. */ }

    override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        void this.bound().then(sink => sink ? sink.write(chunk) : Promise.reject(new Error('Native stream channel is closed')))
            .then(() => callback(), (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))));
    }

    override _final(callback: (error?: Error | null) => void): void {
        void this.bound().then(sink => sink?.closeStdin()).then(() => callback(), () => callback());
    }

    override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
        this.abort.abort();
        for (const resume of this.waiting.splice(0)) resume();
        callback(error);
    }
}

/** Opens the provider's `stream` role for one argv in the managed guest. */
export function openManagedNativeChannel(correlation: Pick<ManagedEnrollmentCorrelationV1, 'resource'>, invoke: ManagedNativeInvocation,
    request: Readonly<{ argv: readonly string[]; signal?: AbortSignal }>): ManagedNativeChannel {
    return new ManagedNativeChannel(invoke, { resource: correlation.resource.value, argv: [...request.argv] }, request.signal);
}
