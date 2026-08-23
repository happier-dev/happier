export const PRESENT_USER_REQUIRED_ERROR = "present_user_required" as const;

type AuthenticatedRouteRequest = Readonly<{
    authTokenKind?: unknown;
    routeOptions?: Readonly<{
        config?: Readonly<{
            allowApiToken?: unknown;
        }>;
    }>;
}>;

/**
 * API tokens are opt-in at the HTTP route boundary. Legacy authenticated
 * routes therefore retain their existing account/terminal behavior without
 * becoming implicit PAT capabilities.
 */
export function isApiTokenDeniedForRoute(request: AuthenticatedRouteRequest): boolean {
    return request.authTokenKind === "api_token"
        && request.routeOptions?.config?.allowApiToken !== true;
}
