import type { CryptoWorkerWorkClass } from './nativeCryptoWorker/types';

type Opening = {
    value: string;
    envelope: Envelope;
    workClass: CryptoWorkerWorkClass;
    result: Promise<Uint8Array | null>;
    resolve: (key: Uint8Array | null) => void;
    reject: (error: unknown) => void;
    readers: number;
    batch?: Batch;
};
type Batch = { entries: Opening[]; abort: AbortController };
type Envelope = { key?: Uint8Array; openings: Map<CryptoWorkerWorkClass, Opening> };
type Scope = { entries: Map<string, Envelope>; pending: Map<CryptoWorkerWorkClass, Opening[]> };

/** Pure opening custody inside Encryption; row/access admission remains with each reader. */
export class DataKeyOpenings {
    private readonly scopes = new Map<string, Scope>();

    clear(): void {
        for (const key of this.scopes.keys()) this.delete(key);
    }

    delete(key: string): void {
        const scope = this.scopes.get(key);
        this.scopes.delete(key);
        for (const envelope of scope?.entries.values() ?? []) {
            for (const entry of envelope.openings.values()) entry.batch?.abort.abort();
        }
    }

    async open(values: readonly string[], options: Readonly<{
        scopeKey: string;
        isScopeCurrent: () => boolean;
        shouldContinue?: () => boolean;
        signal?: AbortSignal;
        workClass?: CryptoWorkerWorkClass;
        open: (values: readonly string[], signal: AbortSignal) => Promise<Array<Uint8Array | null>>;
    }>): Promise<Array<Uint8Array | null>> {
        const isCurrent = () => options.isScopeCurrent()
            && options.signal?.aborted !== true && options.shouldContinue?.() !== false;
        if (!isCurrent()) return values.map(() => null);
        let scope = this.scopes.get(options.scopeKey);
        if (!scope) {
            scope = { entries: new Map(), pending: new Map() };
            this.scopes.set(options.scopeKey, scope);
        }
        const owner = scope;
        const workClass = options.workClass ?? 'bulk';
        const reads = values.map(value => {
            let envelope = owner.entries.get(value);
            if (!envelope) {
                envelope = { openings: new Map() };
                owner.entries.set(value, envelope);
            }
            const material = envelope;
            if (material.key) return Promise.resolve().then(() => isCurrent() ? material.key!.slice() : null);
            // Same-key interactive demand may bypass held bulk work; completed pure openings are shared.
            let entry = material.openings.get(workClass);
            if (!entry) {
                let resolve!: Opening['resolve'];
                let reject!: Opening['reject'];
                const result = new Promise<Uint8Array | null>((accept, refuse) => { resolve = accept; reject = refuse; });
                entry = { value, envelope: material, workClass, result, resolve, reject, readers: 0 };
                material.openings.set(workClass, entry);
                let pending = owner.pending.get(workClass);
                if (!pending) {
                    pending = [];
                    owner.pending.set(workClass, pending);
                    void Promise.resolve().then(async () => {
                        const entries = owner.pending.get(workClass)!;
                        owner.pending.delete(workClass);
                        const active = entries.filter(item => item.readers > 0);
                        const batch: Batch = { entries: active, abort: new AbortController() };
                        for (const item of active) item.batch = batch;
                        try {
                            const keys = active.length > 0 && options.isScopeCurrent()
                                ? await options.open(active.map(item => item.value), batch.abort.signal) : [];
                            active.forEach((item, index) => {
                                const key = keys[index];
                                if (key && item.readers > 0 && options.isScopeCurrent()) {
                                    item.envelope.key ??= key.slice();
                                    item.resolve(item.envelope.key);
                                } else item.resolve(null);
                            });
                        } catch (error) {
                            for (const item of active) item.reject(error);
                        } finally {
                            for (const item of entries) {
                                item.batch = undefined;
                                if (item.envelope.openings.get(item.workClass) === item) item.envelope.openings.delete(item.workClass);
                                if (!item.envelope.key && item.envelope.openings.size === 0
                                    && owner.entries.get(item.value) === item.envelope) owner.entries.delete(item.value);
                            }
                            if (owner.entries.size === 0 && this.scopes.get(options.scopeKey) === owner) this.scopes.delete(options.scopeKey);
                        }
                    });
                }
                pending.push(entry);
            }
            const opening = entry;
            opening.readers += 1;
            return new Promise<Uint8Array | null>((accept, reject) => {
                let finished = false;
                const leave = () => {
                    finished = true;
                    options.signal?.removeEventListener('abort', cancel);
                    opening.readers -= 1;
                    if (opening.readers === 0) {
                        if (material.openings.get(workClass) === opening) material.openings.delete(workClass);
                        if (!material.key && material.openings.size === 0 && owner.entries.get(value) === material) owner.entries.delete(value);
                        if (opening.batch?.entries.every(item => item.readers === 0)) opening.batch.abort.abort();
                    }
                };
                const cancel = () => { if (!finished) { leave(); accept(null); } };
                options.signal?.addEventListener('abort', cancel, { once: true });
                if (options.signal?.aborted) cancel();
                void opening.result.then(key => {
                    if (finished) return;
                    leave();
                    accept(isCurrent() ? key?.slice() ?? null : null);
                }, error => {
                    if (finished) return;
                    leave();
                    if (isCurrent()) reject(error);
                    else accept(null);
                });
            });
        });
        return (await Promise.all(reads)).map(key => isCurrent() ? key : null);
    }
}
