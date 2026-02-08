export type LoginEligibilityResult =
    | { ok: true }
    | { ok: false; statusCode: 401; error: "invalid-token" }
    | { ok: false; statusCode: 403; error: "account-disabled" }
    | { ok: false; statusCode: 403; error: "provider-required"; provider: string }
    | { ok: false; statusCode: 403; error: "not-eligible" }
    | { ok: false; statusCode: 503; error: "upstream_error" };
