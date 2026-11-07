import type { AuthTokenAuthority, AuthTokenKind } from '@happier-dev/protocol/auth/authToken';
import { resolveInvocationAuthority } from '@happier-dev/protocol/actions/invocationAuthority';
import type { ActionRequiredAuthority } from "@happier-dev/protocol/actions/metadata";

/** A caller can lower verified authority; no caller-supplied value can raise it. */
export function narrowCredentialAuthority(authority: ActionRequiredAuthority, ceiling: unknown): ActionRequiredAuthority;
export function narrowCredentialAuthority(authority: AuthTokenAuthority, ceiling: unknown): AuthTokenAuthority;
export function narrowCredentialAuthority(authority: AuthTokenAuthority, ceiling: unknown): AuthTokenAuthority {
    return authority === "present_user" && ceiling === "account_automation" ? "account_automation" : authority;
}

/**
 * The signed floor stays unchanged. A terminal (CLI login) is the person's own tool,
 * so its invocations are person-class; every other kind keeps its minted authority.
 */
export function effectiveCredentialAuthority(input: Readonly<{
    credentialKind: AuthTokenKind;
    mintedAuthority: AuthTokenAuthority;
}>): AuthTokenAuthority {
    if (input.credentialKind !== "terminal") return input.mintedAuthority;
    return resolveInvocationAuthority({ credential: "terminal", surface: "rpc" });
}
