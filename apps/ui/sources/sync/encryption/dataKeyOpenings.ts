import type { CryptoWorkerWorkClass } from './nativeCryptoWorker/types';

type Opening = {
    value: string;
    envelope: Envelope;
    workClass: CryptoWorkerWorkClass;
    result: Promise<Uint8Array | null>;
    resolve: (key: Uint8Array | null) => void;
    reject: (error: unknown) => void;
};
type Envelope = { key?: Uint8Array; openings: Map<CryptoWorkerWorkClass, Opening> };
type Scope = { entries: Map<string, Envelope>; pending: Map<CryptoWorkerWorkClass, Opening[]>; abort: AbortController };

/**
 * The opening was stopped before it completed: the caller's signal or currentness,
 * or this Encryption's scope (generation, recipient, Account material) ended. It is
 * not a refusal and not a failure, so a reader publishes no new state for it.
 * `null` from an opening means only a completed cryptographic refusal.
 */
export class DataKeyOpeningCancelledError extends Error {
    constructor() {
        super('Data-key opening was cancelled before it completed');
        this.name = 'DataKeyOpeningCancelledError';
    }
}

export function isDataKeyOpeningCancelled(error: unknown): error is DataKeyOpeningCancelledError {
    return error instanceof DataKeyOpeningCancelledError;
}

/** Pure opening custody inside Encryption; row/access admission remains with each reader. */
export class DataKeyOpenings {
    private readonly scopes = new Map<string, Scope>();

    clear(): void {
        for (const key of this.scopes.keys()) this.delete(key);
    }

    delete(key: string): void {
        const scope = this.scopes.get(key);
        this.scopes.delete(key);
        scope?.abort.abort();
    }

    /** Each key, or null for a completed refusal; rejects with `DataKeyOpeningCancelledError` when stopped. */
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
        if (!isCurrent()) throw new DataKeyOpeningCancelledError();
        let scope = this.scopes.get(options.scopeKey);
        if (!scope) {
            scope = { entries: new Map(), pending: new Map(), abort: new AbortController() };
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
            if (material.key) return Promise.resolve().then(() => {
                if (!isCurrent()) throw new DataKeyOpeningCancelledError();
                return material.key!.slice();
            });
            // Same-key interactive demand may bypass held bulk work; completed pure openings are shared.
            let entry = material.openings.get(workClass);
            if (!entry) {
                let resolve!: Opening['resolve'];
                let reject!: Opening['reject'];
                const result = new Promise<Uint8Array | null>((accept, refuse) => { resolve = accept; reject = refuse; });
                entry = { value, envelope: material, workClass, result, resolve, reject };
                material.openings.set(workClass, entry);
                let pending = owner.pending.get(workClass);
                if (!pending) {
                    pending = [];
                    owner.pending.set(workClass, pending);
                    void Promise.resolve().then(async () => {
                        const entries = owner.pending.get(workClass)!;
                        owner.pending.delete(workClass);
                        try {
                            const keys = options.isScopeCurrent()
                                ? await options.open(entries.map(item => item.value), owner.abort.signal) : [];
                            entries.forEach((item, index) => {
                                const key = keys[index];
                                if (key && options.isScopeCurrent()) {
                                    item.envelope.key ??= key.slice();
                                    item.resolve(item.envelope.key);
                                } else item.resolve(null);
                            });
                        } catch (error) {
                            for (const item of entries) item.reject(error);
                        } finally {
                            for (const item of entries) {
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
            return new Promise<Uint8Array | null>((accept, reject) => {
                let finished = false;
                const leave = () => {
                    finished = true;
                    options.signal?.removeEventListener('abort', cancel);
                };
                const cancel = () => { if (!finished) { leave(); reject(new DataKeyOpeningCancelledError()); } };
                options.signal?.addEventListener('abort', cancel, { once: true });
                if (options.signal?.aborted) cancel();
                void opening.result.then(key => {
                    if (finished) return;
                    leave();
                    if (isCurrent()) accept(key?.slice() ?? null);
                    else reject(new DataKeyOpeningCancelledError());
                }, error => {
                    if (finished) return;
                    leave();
                    reject(isCurrent() ? error : new DataKeyOpeningCancelledError());
                });
            });
        });
        const keys = await Promise.all(reads);
        if (!isCurrent()) throw new DataKeyOpeningCancelledError();
        return keys;
    }
}
