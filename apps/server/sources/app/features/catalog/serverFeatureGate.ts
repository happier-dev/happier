import type { FeaturesResponse } from "@/app/features/types";
import { readServerEnabledBit, type FeatureId } from "@happier-dev/protocol";

import { resolveServerFeaturePayload } from "./resolveServerFeaturePayload";

export function resolveServerFeaturesForGating(env: NodeJS.ProcessEnv): FeaturesResponse {
    return resolveServerFeaturePayload(env);
}

export function isServerFeatureEnabledForRequest(featureId: FeatureId, env: NodeJS.ProcessEnv): boolean {
    const payload = resolveServerFeaturesForGating(env);
    return readServerEnabledBit(payload, featureId) === true;
}

type RouteHandler = (request: any, reply: any) => unknown | Promise<unknown>;
type RoutePreHandler = (request: any, reply: any) => unknown | Promise<unknown>;

export function createServerFeatureGatePreHandler(
    featureId: FeatureId,
    env: NodeJS.ProcessEnv = process.env,
): RoutePreHandler {
    return async (_request, reply) => {
        if (!isServerFeatureEnabledForRequest(featureId, env)) {
            return reply.code(404).send({ error: "not_found" });
        }
        return undefined;
    };
}

type RouteMethod = {
    (path: string, handler: RouteHandler): void;
    (path: string, opts: any, handler: RouteHandler): void;
};

type RouteApp = {
    get: RouteMethod;
    post: RouteMethod;
    patch: RouteMethod;
    delete: RouteMethod;
    put: RouteMethod;
};

function resolvePreHandlers(existing: unknown): RoutePreHandler[] {
    if (typeof existing === "function") return [existing as RoutePreHandler];
    if (Array.isArray(existing)) {
        return existing.filter((h): h is RoutePreHandler => typeof h === "function");
    }
    return [];
}

function withLeadingPreHandler(opts: any, preHandler: RoutePreHandler): any {
    const base = opts && typeof opts === "object" ? opts : {};
    const existing = resolvePreHandlers(base.preHandler);
    const next = { ...base };
    next.preHandler = [preHandler, ...existing];
    return next;
}

function resolveOptsAndHandler(
    path: string,
    optsOrHandler: unknown,
    maybeHandler: unknown,
): Readonly<{ path: string; opts: any; handler: RouteHandler }> {
    if (typeof optsOrHandler === "function") {
        return { path, opts: {}, handler: optsOrHandler as RouteHandler };
    }
    if (typeof maybeHandler === "function") {
        return { path, opts: optsOrHandler ?? {}, handler: maybeHandler as RouteHandler };
    }
    throw new Error(`Invalid route registration for "${path}": missing handler function`);
}

export function createServerFeatureGatedRouteApp<TApp extends RouteApp>(
    app: TApp,
    featureId: FeatureId,
    env: NodeJS.ProcessEnv = process.env,
): TApp {
    const gate = createServerFeatureGatePreHandler(featureId, env);
    const gated = Object.create(app) as TApp;

    gated.get = (path: string, optsOrHandler: unknown, maybeHandler?: unknown) => {
        const { opts, handler } = resolveOptsAndHandler(path, optsOrHandler, maybeHandler);
        return app.get(path, withLeadingPreHandler(opts, gate), handler);
    };
    gated.post = (path: string, optsOrHandler: unknown, maybeHandler?: unknown) => {
        const { opts, handler } = resolveOptsAndHandler(path, optsOrHandler, maybeHandler);
        return app.post(path, withLeadingPreHandler(opts, gate), handler);
    };
    gated.patch = (path: string, optsOrHandler: unknown, maybeHandler?: unknown) => {
        const { opts, handler } = resolveOptsAndHandler(path, optsOrHandler, maybeHandler);
        return app.patch(path, withLeadingPreHandler(opts, gate), handler);
    };
    gated.delete = (path: string, optsOrHandler: unknown, maybeHandler?: unknown) => {
        const { opts, handler } = resolveOptsAndHandler(path, optsOrHandler, maybeHandler);
        return app.delete(path, withLeadingPreHandler(opts, gate), handler);
    };
    gated.put = (path: string, optsOrHandler: unknown, maybeHandler?: unknown) => {
        const { opts, handler } = resolveOptsAndHandler(path, optsOrHandler, maybeHandler);
        return app.put(path, withLeadingPreHandler(opts, gate), handler);
    };

    return gated;
}
