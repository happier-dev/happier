import { PublicProfileContextV1Schema, type PublicProfileContextV1 } from '@happier-dev/protocol/account/publicProfilePublication';
import { resolveAccountDisplayLabelV1 } from '@happier-dev/protocol/account/accountDisplayProfileV1';
import { countSupporterMonths } from '@happier-dev/protocol/plans/supporterV1';
import { SERVER_CONFIG } from '@happier-dev/protocol/serverConfig/registry';
import { readServerConfig } from '@happier-dev/protocol/serverConfig/serverConfigCodec';
import { resolveAuthPolicyFromEnv } from '@/app/auth/authPolicy';
import { isActiveSupporterRecord } from '@/app/billing/supporterRecords';
import { isServerFeatureEnabledForRequest } from '@/app/features/catalog/serverFeatureGate';
import { resolveConfiguredPublicServerUrl } from '@/app/serverUrls/effectiveServerUrls';
import { getDbProviderFromEnv, getActivePrismaRuntime } from '@/storage/db';
import type { Tx } from '@/storage/inTx';

export function resolvePublicProfilePrerequisite(env: NodeJS.ProcessEnv): null | 'report_contact_unconfigured' | 'public_ingress_unconfigured' {
    if (!resolveConfiguredPublicServerUrl(env)) return 'public_ingress_unconfigured';
    if (!readServerConfig(env, SERVER_CONFIG.HAPPIER_PUBLIC_PROFILE_REPORT_URL)) return 'report_contact_unconfigured';
    return null;
}

function publicProfilePageUrl(publicBaseUrl: string, handle: string): string {
    return `${publicBaseUrl}/@${encodeURIComponent(handle)}`;
}

type ProfileTimestamp = Date | string | number | bigint;

function dateFromProfileTimestamp(value: ProfileTimestamp): Date {
    return new Date(typeof value === 'bigint' ? Number(value) : value);
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
    const { raw, sql } = getActivePrismaRuntime();
    const quote = getDbProviderFromEnv(process.env, 'postgres') === 'mysql' ? '`' : '"';
    const identifier = (name: string) => raw(`${quote}${name}${quote}`);
    const showSupporter = isServerFeatureEnabledForRequest('supporter', env);
    // A nested Prisma relation would issue an additional query on SQLite. Read the
    // existing Account and its optional, uniquely keyed SupporterRecord together.
    const [account] = await tx.$queryRaw<Array<{ username: string | null; name: string | null; createdAt: ProfileTimestamp;
        number: number | null; revokedAt: ProfileTimestamp | null; grantedAt: ProfileTimestamp | null; recurringSince: ProfileTimestamp | null }>>(sql`
        SELECT a.username, a.name, a.${identifier('createdAt')},
            s.number, s.${identifier('revokedAt')}, s.${identifier('grantedAt')}, s.${identifier('recurringSince')}
        FROM ${identifier('Account')} a
        LEFT JOIN ${identifier('SupporterRecord')} s ON s.${identifier('accountId')} = a.id
            AND a.${identifier('supporterRing')} = TRUE AND ${showSupporter} = TRUE
        WHERE a.id = ${accountId}
    `);
    if (!account) throw new Error('public_profile_account_unavailable');
    const grantedAt = account.grantedAt === null ? null : dateFromProfileTimestamp(account.grantedAt);
    const recurringSince = account.recurringSince === null ? null : dateFromProfileTimestamp(account.recurringSince);
    const supporter = isActiveSupporterRecord({ number: account.number,
        revokedAt: account.revokedAt === null ? null : dateFromProfileTimestamp(account.revokedAt) }) ? {
        ...(grantedAt ? { sinceYear: grantedAt.getUTCFullYear() } : {}),
        ...(recurringSince ? { recurring: {
            sinceMonthMs: Date.UTC(recurringSince.getUTCFullYear(), recurringSince.getUTCMonth(), 1),
            months: countSupporterMonths(recurringSince.getTime(), Date.now()),
        } } : {}),
    } : undefined;
    const publicBaseUrl = resolveConfiguredPublicServerUrl(env);
    const displayName = resolvePublicProfileServiceName(env);
    const report = readPublicProfileReportUrl(env, account.username ?? undefined);
    const name = resolveAccountDisplayLabelV1(account);
    const page = publicBaseUrl && account.username ? publicProfilePageUrl(publicBaseUrl, account.username) : null;
    return PublicProfileContextV1Schema.parse({
        handle: account.username,
        // Missing, unsafe and revoked Account images share the explained fallback; no private source is disclosed.
        identity: { ...(name ? { name } : {}), sinceMs: dateFromProfileTimestamp(account.createdAt).getTime(), ...(supporter ? { supporter } : {}),
            avatar: { kind: 'planet', reason: 'account_image_unavailable' } },
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
