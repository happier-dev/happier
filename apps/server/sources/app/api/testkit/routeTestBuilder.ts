import { createReplyStub, createFakeRouteApp, getRouteHandler, type FakeRouteApp } from "./routeHarness";
import {
    createAuthenticatedRouteRequest,
    createRouteRequest,
    mergeRouteRequestOverrides,
    type RouteRequestFixture,
    type RouteRequestOverrides,
} from "./requestFixtures";

type RouteMethod = "GET" | "POST" | "PATCH" | "DELETE" | "PUT";

export type RouteTestBuilderOptions = Readonly<{
    method: RouteMethod;
    path: string;
    defaultRequest?: RouteRequestOverrides;
    registerRoutes: (app: FakeRouteApp) => void;
}>;

export function createRouteTestBuilder(options: RouteTestBuilderOptions) {
    const app = createFakeRouteApp();
    options.registerRoutes(app);

    const routeKey = `${options.method} ${options.path}`;
    const routeExists = app.routes.has(routeKey);
    const handler = routeExists
        ? getRouteHandler(app, options.method, options.path)
        : ((() => {
            throw new Error(`Missing route handler for ${routeKey}`);
        }) as ReturnType<typeof getRouteHandler>);

    const createRequest = (overrides: RouteRequestOverrides = {}): RouteRequestFixture =>
        createRouteRequest(mergeRouteRequestOverrides(options.defaultRequest, overrides));

    const createAuthenticatedRequest = (
        overrides: RouteRequestOverrides & { userId?: string } = {},
    ): RouteRequestFixture & { userId: string } =>
        createAuthenticatedRouteRequest(mergeRouteRequestOverrides(options.defaultRequest, overrides));

    const invoke = async (overrides: RouteRequestOverrides = {}) => {
        const request = createRequest(overrides);
        const reply = createReplyStub();
        const response = await handler(request, reply);
        return { request, reply, response };
    };

    return {
        app,
        handler,
        routeExists,
        createReply: createReplyStub,
        createRequest,
        createAuthenticatedRequest,
        invoke,
    };
}
