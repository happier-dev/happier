import { db } from "@/storage/db";

type PrismaRequest = Readonly<{ modelName?: string; protocolQuery: { action: string }; args: unknown;
    transaction?: Readonly<{ kind: string; id?: string }> }>;
type ObservedPrismaRequest = Readonly<{ model?: string; action: string; args: unknown; client: unknown; transactionId?: string }>;
type RequestObserver = Readonly<{
    before?: (request: ObservedPrismaRequest) => Promise<void> | void;
    after?: (request: ObservedPrismaRequest, result: unknown) => Promise<void> | void;
}>;

/** Observe the actual selected provider, including its read-snapshot clients. */
export function observePrismaRequests(client: object, observer: RequestObserver): () => void {
    return observeRequestHandler(Reflect.get(client, "_requestHandler"), observer);
}

/**
 * Observe real Prisma SQLite IO of the initialized light-server database, including the
 * clients its read snapshots own: every client of one generated module shares the
 * request handler prototype patched below.
 */
export function observeSqliteRequests(observer: RequestObserver): () => void {
    return observePrismaRequests(db, observer);
}

function observeRequestHandler(handler: unknown, observer: RequestObserver): () => void {
    if (!handler || typeof handler !== "object") throw new Error("Missing Prisma request handler");
    const prototype: object = Object.getPrototypeOf(handler);
    const original: unknown = Reflect.get(prototype, "request");
    if (typeof original !== "function") throw new Error("Missing Prisma request adapter");
    Reflect.set(prototype, "request", async function (this: object, request: PrismaRequest) {
        const observed = {
            model: request.modelName, action: request.protocolQuery.action,
            args: request.args, client: Reflect.get(this, "client"),
            transactionId: request.transaction?.kind === 'itx' ? request.transaction.id : undefined,
        };
        await observer.before?.(observed);
        const result: unknown = await Reflect.apply(original, this, [request]);
        await observer.after?.(observed, result);
        return result;
    });
    return () => { Reflect.set(prototype, "request", original); };
}
