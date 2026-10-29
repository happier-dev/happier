/**
 * Full request controllers belong to mounted views and admitted operations. Once both leave, only the
 * acknowledged retry/Undo receipt remains for a later transcript or Details view. Nothing is allocated
 * for an abandoned render, and retiring a view immediately drops its callbacks even during a save.
 */
export function createRequestOwnedControllerStore<Controller, View, Receipt>(options: Readonly<{
    create(readView: () => View | null, receipt: Receipt | null): Controller;
    subscribe(controller: Controller, listener: () => void): () => void;
    checkpoint(controller: Controller): Receipt | null;
}>) {
    type Entry = { controller: Controller; views: Set<View>; operations: number };
    const controllers = new Map<string, Entry>();
    const receipts = new Map<string, Receipt>();
    const retire = (key: string, entry: Entry) => {
        if (entry.views.size || entry.operations || controllers.get(key) !== entry) return;
        const receipt = options.checkpoint(entry.controller);
        controllers.delete(key);
        if (receipt === null) receipts.delete(key);
        else receipts.set(key, receipt);
    };
    return {
        get: (key: string) => controllers.get(key)?.controller ?? null,
        getReceipt: (key: string) => receipts.get(key) ?? null,
        subscribe(key: string, view: View, listener: () => void) {
            let entry = controllers.get(key);
            if (!entry) {
                const views = new Set([view]);
                const readView = () => {
                    let latest: View | null = null;
                    for (const mounted of views) latest = mounted;
                    return latest;
                };
                entry = { controller: options.create(readView, receipts.get(key) ?? null), views, operations: 0 };
                controllers.set(key, entry);
            } else entry.views.add(view);
            const retained = entry;
            const unsubscribe = options.subscribe(retained.controller, listener);
            return () => {
                unsubscribe();
                retained.views.delete(view);
                retire(key, retained);
            };
        },
        run<Result>(key: string, operation: (controller: Controller) => Promise<Result>): Promise<Result> | undefined {
            const entry = controllers.get(key);
            if (!entry) return undefined;
            entry.operations++;
            return (async () => {
                try { return await operation(entry.controller); }
                finally { entry.operations--; retire(key, entry); }
            })();
        },
    };
}
