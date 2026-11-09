import {
    ACCOUNT_IDENTITY_PROVIDER_LOGIN_MAX_CODE_UNITS,
    ACCOUNT_IDENTITY_PROVIDER_USER_ID_MAX_CODE_UNITS,
} from "@/app/auth/providers/accountIdentityBounds";
import { readAuthMtlsFeatureEnv, type AuthMtlsIdentitySource } from "@/app/features/catalog/readFeatureEnv";
import { resolveKeylessAccountsEnabled } from "@/app/features/e2ee/resolveKeylessAccountsEnabled";
import type { IncomingMessage } from 'node:http';
import { isIrohIngressRequest } from '@/app/net/requestIngress';

/** Forwarded certificate identity is meaningful only behind its trusted ingress. */
export function isMtlsLoginEnabled(env: NodeJS.ProcessEnv): boolean {
    const mtlsEnv = readAuthMtlsFeatureEnv(env);
    if (!mtlsEnv.enabled) return false;
    if (mtlsEnv.mode !== "forwarded") return false;
    if (!mtlsEnv.trustForwardedHeaders) return false;
    if (!resolveKeylessAccountsEnabled(env)) return false;
    return true;
}

function readSingleHeader(headers: Record<string, unknown>, headerNameLower: string): string | null {
    const raw = headers[headerNameLower];
    if (typeof raw === "string") return raw.trim() || null;
    if (Array.isArray(raw)) {
        const first = raw.find((v) => typeof v === "string" && v.trim());
        return typeof first === "string" ? first.trim() : null;
    }
    return null;
}

function normalizeEmailLikeIdentity(raw: string | null): string | null {
    if (!raw) return null;
    const trimmed = raw.trim();
    return trimmed ? trimmed.toLowerCase() : null;
}

function normalizeIssuer(raw: string | null): string | null {
    if (!raw) return null;
    const trimmed = raw.trim().replace(/\s+/g, " ");
    return trimmed ? trimmed : null;
}

function extractSubjectCommonName(subject: string | null): string | null {
    if (!subject) return null;
    // Best-effort extraction for forwarded X.509 subject strings like:
    // "CN=Alice Example,OU=Users,O=Example Corp"
    const match = subject.match(/(?:^|,)\s*CN\s*=\s*([^,]+)\s*(?:,|$)/i);
    const cn = match?.[1]?.trim() ?? "";
    return cn || null;
}

function pickIdentityValue(params: {
    identitySource: AuthMtlsIdentitySource;
    email: string | null;
    upn: string | null;
    subject: string | null;
    fingerprint: string | null;
}): string | null {
    switch (params.identitySource) {
        case "san_email":
            return params.email;
        case "san_upn":
            return params.upn;
        case "subject_cn":
            return extractSubjectCommonName(params.subject);
        case "fingerprint":
            return params.fingerprint;
    }
}

export type MtlsIdentity = Readonly<{
    providerUserId: string;
    providerLogin: string | null;
    profile: Readonly<{
        email: string | null;
        upn: string | null;
        subject: string | null;
        fingerprint: string | null;
        issuer: string | null;
    }>;
}>;

export function resolveMtlsIdentityFromForwardedHeaders(params: {
    env: NodeJS.ProcessEnv;
    headers: Record<string, unknown>;
    request: Pick<IncomingMessage, 'socket'>;
}): MtlsIdentity | null {
    if (isIrohIngressRequest(params.request)) return null;
    const mtlsEnv = readAuthMtlsFeatureEnv(params.env);
    if (!mtlsEnv.trustForwardedHeaders) {
        return null;
    }

    const email = normalizeEmailLikeIdentity(readSingleHeader(params.headers, mtlsEnv.forwardedEmailHeader));
    const upn = normalizeEmailLikeIdentity(readSingleHeader(params.headers, mtlsEnv.forwardedUpnHeader));
    const subject = readSingleHeader(params.headers, mtlsEnv.forwardedSubjectHeader);
    const fingerprintRaw = readSingleHeader(params.headers, mtlsEnv.forwardedFingerprintHeader);
    const fingerprint = fingerprintRaw ? fingerprintRaw.replace(/^sha256:/i, "").trim() : null;
    const issuer = normalizeIssuer(readSingleHeader(params.headers, mtlsEnv.forwardedIssuerHeader));

    const providerUserId = pickIdentityValue({
        identitySource: mtlsEnv.identitySource,
        email,
        upn,
        subject,
        fingerprint,
    });
    if (!providerUserId) return null;
    // Forwarded certificate values reach AccountIdentity unchanged, so they must satisfy the same
    // semantic ceilings the other provider leaves enforce. Refusing an over-long value here keeps
    // two distinct certificate subjects from being rejected by, or truncated into, one stored row.
    const publishesLogin = mtlsEnv.identitySource === "san_email";
    if (providerUserId.length > (publishesLogin
        ? ACCOUNT_IDENTITY_PROVIDER_LOGIN_MAX_CODE_UNITS
        : ACCOUNT_IDENTITY_PROVIDER_USER_ID_MAX_CODE_UNITS)) return null;

    return {
        providerUserId,
        providerLogin: publishesLogin ? providerUserId : null,
        profile: {
            email,
            upn,
            subject,
            fingerprint,
            issuer,
        },
    };
}
