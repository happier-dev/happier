import { isAnonymousSignupExplicitlyDisabled } from '@/app/auth/authPolicy';
import type { BoundServerListener } from '@/app/runtime/startupReceipt';
import { isLoopbackHostname } from '@happier-dev/protocol/server/urls/loopbackHostname';
import { resolveConfiguredCanonicalServerUrl, resolveConfiguredPublicServerUrl } from '@/app/serverUrls/effectiveServerUrls';

/**
 * Admission for the optional Home carrier, independent of server flavor/purpose.
 * Canonical identity is not an ingress fact. A loopback-only bootstrap must close
 * anonymous signup before Iroh exposes it; an already exposed API keeps its own
 * signup policy. No synthetic signup request may create an Account during startup.
 */
export function verifyPersonalHomeExposureProof(params: Readonly<{
    env: NodeJS.ProcessEnv;
    listener: BoundServerListener | null;
}>): boolean {
    const { listener, env } = params;
    if (!listener || !Number.isInteger(listener.port) || listener.port < 1 || listener.port > 65535) return false;
    if (!resolveConfiguredCanonicalServerUrl(env)) return false;
    if (!isLoopbackHostname(listener.host)) return true;
    const publicUrl = resolveConfiguredPublicServerUrl(env);
    if (publicUrl && !isLoopbackHostname(new URL(publicUrl).hostname)) return true;
    return isAnonymousSignupExplicitlyDisabled(env);
}
