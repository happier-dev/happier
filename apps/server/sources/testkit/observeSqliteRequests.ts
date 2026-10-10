import { createRequire } from "node:module";

type SqliteRequest = Readonly<{ modelName?: string; protocolQuery: { action: string }; args: unknown }>;
type ObservedSqliteRequest = Readonly<{ model?: string; action: string; args: unknown; client: unknown }>;

/** Observe real Prisma SQLite IO, including clients owned by read snapshots. */
export function observeSqliteRequests(observer: Readonly<{
    before?: (request: ObservedSqliteRequest) => Promise<void> | void;
    after?: (request: ObservedSqliteRequest) => Promise<void> | void;
}>): () => void {
    // Prisma 6's generated client has no public query hook across all client
    // instances. Isolate its untyped request adapter here; never replace IO.
    const require = createRequire(import.meta.url);
    const module: unknown = require("../../generated/sqlite-client/index.js");
    if (!module || typeof module !== "object" || !("PrismaClient" in module)) {
        throw new Error("Missing generated SQLite client");
    }
    const constructor = module.PrismaClient;
    if (typeof constructor !== "function") throw new Error("Invalid SQLite client constructor");
    // _request is copied onto each client at construction. The request handler
    // retains its prototype method, including on already-initialized clients.
    // Constructing this probe is lazy and opens no database connection.
    const probe: object = Reflect.construct(constructor, []);
    const handler: unknown = Reflect.get(probe, "_requestHandler");
    if (!handler || typeof handler !== "object") throw new Error("Missing Prisma 6 request handler");
    const prototype: object = Object.getPrototypeOf(handler);
    const original: unknown = Reflect.get(prototype, "request");
    if (typeof original !== "function") throw new Error("Missing Prisma 6 request adapter");
    Reflect.set(prototype, "request", async function (this: object, request: SqliteRequest) {
        const observed = {
            model: request.modelName, action: request.protocolQuery.action,
            args: request.args, client: Reflect.get(this, "client"),
        };
        await observer.before?.(observed);
        const result: unknown = await Reflect.apply(original, this, [request]);
        await observer.after?.(observed);
        return result;
    });
    return () => { Reflect.set(prototype, "request", original); };
}
