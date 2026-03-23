export type RouteRequestFixture = {
    userId?: string;
    params: Record<string, unknown>;
    query: Record<string, unknown>;
    headers: Record<string, unknown>;
    body?: unknown;
} & Record<string, unknown>;

export type RouteRequestOverrides = Partial<Omit<RouteRequestFixture, "params" | "query" | "headers">> & {
    params?: Record<string, unknown>;
    query?: Record<string, unknown>;
    headers?: Record<string, unknown>;
};

export function mergeRouteRequestOverrides(
    base: RouteRequestOverrides = {},
    overrides: RouteRequestOverrides = {},
): RouteRequestOverrides {
    const { params: baseParams, query: baseQuery, headers: baseHeaders, ...baseRest } = base;
    const { params: overrideParams, query: overrideQuery, headers: overrideHeaders, ...overrideRest } = overrides;

    return {
        ...baseRest,
        ...overrideRest,
        params: {
            ...(baseParams ?? {}),
            ...(overrideParams ?? {}),
        },
        query: {
            ...(baseQuery ?? {}),
            ...(overrideQuery ?? {}),
        },
        headers: {
            ...(baseHeaders ?? {}),
            ...(overrideHeaders ?? {}),
        },
    };
}

export function createRouteRequest(overrides: RouteRequestOverrides = {}): RouteRequestFixture {
    const merged = mergeRouteRequestOverrides({}, overrides);
    const { params, query, headers, ...rest } = merged;

    return {
        params: params ?? {},
        query: query ?? {},
        headers: headers ?? {},
        ...rest,
    };
}

export function createAuthenticatedRouteRequest(
    overrides: RouteRequestOverrides & { userId?: string } = {},
): RouteRequestFixture & { userId: string } {
    const request = createRouteRequest({
        userId: "u1",
        ...overrides,
    });

    return {
        ...request,
        userId: typeof request.userId === "string" && request.userId.length > 0 ? request.userId : "u1",
    };
}
