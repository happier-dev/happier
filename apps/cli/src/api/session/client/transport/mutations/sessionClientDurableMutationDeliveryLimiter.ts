const DEFAULT_DELIVERY_CONCURRENCY = 4;
const MAX_DELIVERY_CONCURRENCY = 32;

let activeDeliveries = 0;
const pendingDeliverySlots: Array<() => void> = [];

function readBoundedDeliveryConcurrency(): number {
    const raw = String(process.env.HAPPIER_SESSION_MUTATION_OUTBOX_DELIVERY_CONCURRENCY ?? '').trim();
    if (!raw) return DEFAULT_DELIVERY_CONCURRENCY;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(parsed) || parsed < 1) return DEFAULT_DELIVERY_CONCURRENCY;
    return Math.min(parsed, MAX_DELIVERY_CONCURRENCY);
}

function drainPendingDeliverySlots(): void {
    const limit = readBoundedDeliveryConcurrency();
    while (activeDeliveries < limit) {
        const resolve = pendingDeliverySlots.shift();
        if (!resolve) return;
        activeDeliveries += 1;
        resolve();
    }
}

async function acquireDeliverySlot(): Promise<void> {
    if (activeDeliveries < readBoundedDeliveryConcurrency()) {
        activeDeliveries += 1;
        return;
    }
    await new Promise<void>((resolve) => {
        pendingDeliverySlots.push(resolve);
    });
}

export async function withSessionClientDurableMutationDeliverySlot<T>(fn: () => Promise<T>): Promise<T> {
    await acquireDeliverySlot();
    try {
        return await fn();
    } finally {
        activeDeliveries = Math.max(0, activeDeliveries - 1);
        drainPendingDeliverySlots();
    }
}
