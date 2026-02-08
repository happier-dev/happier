import { vi } from "vitest";

type RouteMethod = "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
type RouteHandler = (request: any, reply: any) => unknown | Promise<unknown>;

export type FakeRouteApp = {
    authenticate: ReturnType<typeof vi.fn>;
    routes: Map<string, RouteHandler>;
    get: (path: string, opts: any, handler: RouteHandler) => void;
    post: (path: string, opts: any, handler: RouteHandler) => void;
    patch: (path: string, opts: any, handler: RouteHandler) => void;
    delete: (path: string, opts: any, handler: RouteHandler) => void;
    put: (path: string, opts: any, handler: RouteHandler) => void;
};

export function createFakeRouteApp(): FakeRouteApp {
    const routes = new Map<string, RouteHandler>();
    const register = (method: RouteMethod, path: string, handler: RouteHandler) => {
        routes.set(`${method} ${path}`, handler);
    };

    return {
        authenticate: vi.fn(),
        routes,
        get(path: string, _opts: any, handler: RouteHandler) {
            register("GET", path, handler);
        },
        post(path: string, _opts: any, handler: RouteHandler) {
            register("POST", path, handler);
        },
        patch(path: string, _opts: any, handler: RouteHandler) {
            register("PATCH", path, handler);
        },
        delete(path: string, _opts: any, handler: RouteHandler) {
            register("DELETE", path, handler);
        },
        put(path: string, _opts: any, handler: RouteHandler) {
            register("PUT", path, handler);
        },
    };
}

export function getRouteHandler(
    app: FakeRouteApp,
    method: RouteMethod,
    path: string,
): RouteHandler {
    const handler = app.routes.get(`${method} ${path}`);
    if (!handler) {
        throw new Error(`Missing route handler for ${method} ${path}`);
    }
    return handler;
}

export function createReplyStub() {
    const reply: any = {
        send: vi.fn((payload: any) => payload),
        code: vi.fn(() => reply),
    };
    return reply;
}
