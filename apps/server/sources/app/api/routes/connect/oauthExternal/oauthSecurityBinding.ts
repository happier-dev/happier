import {
    resolveOAuthRuntimeByIdInTx,
    resolveRuntimeInTx,
} from "@/app/auth/providers/identityProviderCatalog";
import type { OAuthFlowProvider } from "@/app/oauth/providers/types";
import { inTx, type Tx } from "@/storage/inTx";
import type { OAuthSecurityBinding } from "./oauthExternalSchemas";
import { OAuthProviderConfigurationChangedError } from "./oauthExternalErrors";
import { readTeamIdentityConnectionInTx } from "@/app/teams/identity/teamIdentityConnectionLifecycle";

/**
 * Whether a pending's Team admission replaces this Home's own method decision.
 *
 * A Team-OWNED identity connection is not one of the Home's authentication
 * methods, so `resolveEffectiveHomeAuthMethods` can never answer for it: the
 * Team owner (`finalizeTeamOAuthAdmissionInTx`) and the Home's Team-provider
 * ceiling (`identityProviderCatalog`) decide it instead. A Team admission that
 * runs on a HOME-owned provider (`providerOrigin: "home"`, with or without a Home connection) is
 * still one of this Home's own methods, so it keeps the ordinary gate and a
 * Home that disabled the method refuses the finalize.
 */
export function isTeamOwnedConnectionAdmission(binding: OAuthSecurityBinding | undefined): boolean {
    return binding?.purpose === "team_admission" && binding.provider.context.kind === "team" && binding.connection !== null;
}

/** Resolves only the runtime bound by the server-held attempt/pending, never a newer replacement. */
export async function resolveOAuthSecurityBinding(input: Readonly<{
    env: NodeJS.ProcessEnv;
    providerId: string;
    binding: OAuthSecurityBinding | undefined;
    purpose: OAuthSecurityBinding["purpose"];
    stage: "oauth_start" | "oauth_callback" | "oauth_finalize";
}>): Promise<Readonly<{ provider: OAuthFlowProvider; securityBinding: OAuthSecurityBinding }> | null> {
    return await inTx(async (tx) => await resolveOAuthSecurityBindingInTx(tx, input));
}

export async function resolveOAuthSecurityBindingInTx(tx: Tx, input: Readonly<{
    env: NodeJS.ProcessEnv;
    providerId: string;
    binding: OAuthSecurityBinding | undefined;
    purpose: OAuthSecurityBinding["purpose"];
    stage: "oauth_start" | "oauth_callback" | "oauth_finalize";
}>): Promise<Readonly<{ provider: OAuthFlowProvider; securityBinding: OAuthSecurityBinding }> | null> {
    if (!input.binding) {
        // Released server-v0.2.11 / preview.2 (98ea8fb76733b1dd785d38c31360179cafa84824)
        // and the current ../0.2 predecessor authored ordinary Home records without a reference.
        // Remove after legacy writers are drained plus the maximum attempt/pending TTL. Keep this
        // lookup inside the caller transaction so finalization observes one atomic current state.
        if (input.purpose !== null) return null;
        const current = await resolveOAuthRuntimeByIdInTx(tx, input.env, input.providerId);
        if (!current || current.reference.source === "managed" || current.reference.context.kind !== "home") return null;
        return {
            provider: current.provider,
            securityBinding: { provider: current.reference, connection: null, admission: null, purpose: null },
        };
    }
    if (input.binding.provider.id !== input.providerId || input.binding.purpose !== input.purpose) return null;
    const runtime = await resolveRuntimeInTx(tx, {
        env: input.env,
        reference: input.binding.provider,
        purpose: input.purpose === "identity_connection_test"
            ? "identity_connection_test"
            : input.stage,
    });
    if (!runtime.ok || !runtime.module.oauth) return null;
    const runtimeConnection = runtime.module.oauth.connectionBinding;
    if (runtimeConnection && (
        input.binding.connection?.id !== runtimeConnection.id
        || input.binding.connection.revision !== runtimeConnection.revision
    )) return null;
    if (input.binding.connection) {
        const connection = await readTeamIdentityConnectionInTx(tx, {
            id: input.binding.connection.id,
            teamId: input.binding.provider.context.kind === "team" ? input.binding.provider.context.teamId : null,
        });
        if (connection.status !== "ready"
            || connection.connection.providerInstanceId !== input.providerId
            || connection.connection.revision !== input.binding.connection.revision) return null;
    }
    const status = runtime.module.oauth.resolveStatus(input.env);
    if (!status.configured || (!status.enabled && input.purpose !== "identity_connection_test")) return null;
    return { provider: runtime.module.oauth, securityBinding: input.binding };
}

/** Rechecks at each final mutation boundary; the route consumes stale pending state after rollback. */
export async function requireCurrentOAuthPendingRuntime(input: Readonly<{
    env: NodeJS.ProcessEnv;
    providerId: string;
    pendingKey: string;
    binding: OAuthSecurityBinding | undefined;
    purpose: OAuthSecurityBinding["purpose"];
}>): Promise<OAuthFlowProvider> {
    const resolved = await resolveOAuthSecurityBinding({
        ...input, stage: "oauth_finalize",
    });
    if (!resolved) throw new OAuthProviderConfigurationChangedError(input.pendingKey);
    return resolved.provider;
}

export async function requireCurrentOAuthPendingRuntimeInTx(tx: Tx, input: Readonly<{
    env: NodeJS.ProcessEnv;
    providerId: string;
    pendingKey: string;
    binding: OAuthSecurityBinding | undefined;
    purpose: OAuthSecurityBinding["purpose"];
}>): Promise<OAuthFlowProvider> {
    const resolved = await resolveOAuthSecurityBindingInTx(tx, {
        ...input,
        stage: "oauth_finalize",
    });
    if (!resolved) throw new OAuthProviderConfigurationChangedError(input.pendingKey);
    return resolved.provider;
}
