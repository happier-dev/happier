import { vi } from "vitest";

type RouteMethod = "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
type RouteHandler = (request: any, reply: any) => unknown | Promise<unknown>;
type RouteOpts = Readonly<{ preHandler?: unknown }> & Record<string, unknown>;
type RouteEntry = Readonly<{ opts: RouteOpts; handler: RouteHandler }>;

export type FakeRouteApp = {
    authenticate: ReturnType<typeof vi.fn>;
    routes: Map<string, RouteEntry>;
    get: {
        (path: string, handler: RouteHandler): void;
        (path: string, opts: any, handler: RouteHandler): void;
    };
    post: {
        (path: string, handler: RouteHandler): void;
        (path: string, opts: any, handler: RouteHandler): void;
    };
    patch: {
        (path: string, handler: RouteHandler): void;
        (path: string, opts: any, handler: RouteHandler): void;
    };
    delete: {
        (path: string, handler: RouteHandler): void;
        (path: string, opts: any, handler: RouteHandler): void;
    };
    put: {
        (path: string, handler: RouteHandler): void;
        (path: string, opts: any, handler: RouteHandler): void;
    };
};

function resolveOptsAndHandler(
    path: string,
    optsOrHandler: unknown,
    maybeHandler: unknown,
): Readonly<{ opts: RouteOpts; handler: RouteHandler }> {
    if (typeof optsOrHandler === "function") {
        return { opts: {}, handler: optsOrHandler as RouteHandler };
    }
    if (typeof maybeHandler === "function") {
        return { opts: (optsOrHandler ?? {}) as RouteOpts, handler: maybeHandler as RouteHandler };
    }
    throw new Error(`Invalid route registration for "${path}": missing handler function`);
}

export function createFakeRouteApp(): FakeRouteApp {
    const routes = new Map<string, RouteEntry>();
    const register = (method: RouteMethod, path: string, opts: RouteOpts, handler: RouteHandler) => {
        routes.set(`${method} ${path}`, { opts, handler });
    };

    return {
        authenticate: vi.fn(),
        routes,
        get(path: string, optsOrHandler: unknown, maybeHandler?: unknown) {
            const { opts, handler } = resolveOptsAndHandler(path, optsOrHandler, maybeHandler);
            register("GET", path, opts ?? {}, handler);
        },
        post(path: string, optsOrHandler: unknown, maybeHandler?: unknown) {
            const { opts, handler } = resolveOptsAndHandler(path, optsOrHandler, maybeHandler);
            register("POST", path, opts ?? {}, handler);
        },
        patch(path: string, optsOrHandler: unknown, maybeHandler?: unknown) {
            const { opts, handler } = resolveOptsAndHandler(path, optsOrHandler, maybeHandler);
            register("PATCH", path, opts ?? {}, handler);
        },
        delete(path: string, optsOrHandler: unknown, maybeHandler?: unknown) {
            const { opts, handler } = resolveOptsAndHandler(path, optsOrHandler, maybeHandler);
            register("DELETE", path, opts ?? {}, handler);
        },
        put(path: string, optsOrHandler: unknown, maybeHandler?: unknown) {
            const { opts, handler } = resolveOptsAndHandler(path, optsOrHandler, maybeHandler);
            register("PUT", path, opts ?? {}, handler);
        },
    };
}

export function getRouteHandler(
    app: FakeRouteApp,
    method: RouteMethod,
    path: string,
): RouteHandler {
    const entry = app.routes.get(`${method} ${path}`);
    if (!entry) {
        throw new Error(`Missing route handler for ${method} ${path}`);
    }

    const resolvePreHandlers = (raw: unknown): Array<(request: any, reply: any) => unknown | Promise<unknown>> => {
        if (typeof raw === "function") return [raw as any];
        if (Array.isArray(raw)) return raw.filter((h): h is any => typeof h === "function");
        return [];
    };

    const preHandlers = resolvePreHandlers(entry.opts.preHandler);

    return async (request, reply) => {
        for (const preHandler of preHandlers) {
            const result = await preHandler(request, reply);
            if (reply?.sent === true) {
                return undefined;
            }
            if (typeof result !== "undefined") {
                return result;
            }
        }
        return await entry.handler(request, reply);
    };
}

export function createReplyStub() {
    const reply: any = {
        sent: false,
        send: vi.fn((payload: any) => {
            reply.sent = true;
            return payload;
        }),
        code: vi.fn(() => reply),
    };
    return reply;
}
