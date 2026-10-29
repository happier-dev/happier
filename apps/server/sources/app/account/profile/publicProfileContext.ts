import { PublicProfileContextV1Schema, type PublicProfileContextV1 } from '@happier-dev/protocol/account/publicProfilePublication';
import { resolveAccountDisplayLabelV1 } from '@happier-dev/protocol/account/accountDisplayProfileV1';
import { SERVER_CONFIG } from '@happier-dev/protocol/serverConfig/registry';
import { readServerConfig } from '@happier-dev/protocol/serverConfig/serverConfigCodec';
import { resolveAuthPolicyFromEnv } from '@/app/auth/authPolicy';
import { resolveConfiguredPublicServerUrl } from '@/app/serverUrls/effectiveServerUrls';
import type { Tx } from '@/storage/inTx';

export function resolvePublicProfilePrerequisite(env: NodeJS.ProcessEnv): null | 'report_contact_unconfigured' | 'public_ingress_unconfigured' {
    if (!resolveConfiguredPublicServerUrl(env)) return 'public_ingress_unconfigured';
    if (!readServerConfig(env, SERVER_CONFIG.HAPPIER_PUBLIC_PROFILE_REPORT_URL)) return 'report_contact_unconfigured';
    return null;
}

function publicProfilePageUrl(publicBaseUrl: string, handle: string): string {
    return `${publicBaseUrl}/@${encodeURIComponent(handle)}`;
}

/** Read the service's admitted contact; mailto can carry the public page without private diagnostics. */
export function readPublicProfileReportUrl(env: NodeJS.ProcessEnv, handle?: string): string | null {
    const destination = readServerConfig(env, SERVER_CONFIG.HAPPIER_PUBLIC_PROFILE_REPORT_URL);
    if (!destination) return null;
    const url = new URL(destination);
    const publicBaseUrl = resolveConfiguredPublicServerUrl(env);
    if (url.protocol === 'mailto:' && handle && publicBaseUrl) {
        const body = url.searchParams.get('body');
        url.searchParams.set('body', [body, publicProfilePageUrl(publicBaseUrl, handle)].filter(Boolean).join('\n\n'));
    }
    return url.toString();
}

/** The service's name on its public pages: its configured presentation, else its public host; none without ingress. */
export function resolvePublicProfileServiceName(env: NodeJS.ProcessEnv): string | undefined {
    const publicBaseUrl = resolveConfiguredPublicServerUrl(env);
    return publicBaseUrl ? resolveAuthPolicyFromEnv(env).accountServicePresentation?.displayName ?? new URL(publicBaseUrl).hostname : undefined;
}

/** Canonical Account identity and request-effective service configuration, independent of publication state. */
export async function readPublicProfileContextInTx(tx: Tx, accountId: string, env: NodeJS.ProcessEnv): Promise<PublicProfileContextV1> {
    const account = await tx.account.findUniqueOrThrow({ where: { id: accountId }, select: { username: true, name: true, createdAt: true } });
    const publicBaseUrl = resolveConfiguredPublicServerUrl(env);
    const displayName = resolvePublicProfileServiceName(env);
    const report = readPublicProfileReportUrl(env, account.username ?? undefined);
    const name = resolveAccountDisplayLabelV1(account);
    const page = publicBaseUrl && account.username ? publicProfilePageUrl(publicBaseUrl, account.username) : null;
    return PublicProfileContextV1Schema.parse({
        handle: account.username,
        // Account avatars have no admitted public-profile URL yet; never expose a private storage/provider URL.
        identity: { ...(name ? { name } : {}), sinceMs: account.createdAt.getTime() },
        service: publicBaseUrl && displayName ? { displayName, publicBaseUrl } : null,
        urls: page && publicBaseUrl && account.username && report ? {
            page,
            json: `${publicBaseUrl}/v1/public/profiles/${encodeURIComponent(account.username)}`,
            badgeBase: `${page}/badge`,
            card: `${page}/card.svg`,
            og: `${page}/og.png`,
            report,
        } : null,
    });
}
