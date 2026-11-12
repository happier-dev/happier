import { InvalidateSync } from '@/utils/sessions/sync';

export type PeripheralFeed = 'friends' | 'feed' | 'todos' | 'accountPets' | 'purchases' | 'nativeUpdate';

/** The existing queue owns recovery; mounted readers own whether its data is needed. */
export class ViewDemandSync extends InvalidateSync {
    private readonly consumers = new Set<symbol>();

    constructor(command: () => Promise<void>, options?: ConstructorParameters<typeof InvalidateSync>[1]) {
        super(async () => {
            if (this.hasDemand()) await command();
        }, options);
    }

    hasDemand(): boolean { return this.consumers.size > 0; }

    acquire(): () => void {
        const consumer = Symbol();
        const first = !this.hasDemand();
        this.consumers.add(consumer);
        if (first) this.invalidateCoalesced();
        return () => { this.consumers.delete(consumer); };
    }

    /** An explicit operation borrows the same demand and queue as a view. */
    async read(): Promise<void> {
        const consumer = Symbol();
        this.consumers.add(consumer);
        try { await this.invalidateAndAwait({ settleOnFirstAttempt: true }); }
        finally { this.consumers.delete(consumer); }
    }
}
