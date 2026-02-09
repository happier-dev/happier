import { readFileSync } from "node:fs";
import { isLoopbackHostname } from "@/utils/network/urlSafety";

export type OidcAuthProviderInstanceConfig = Readonly<{
    id: string;
    type: "oidc";
    displayName: string;
    issuer: string;
    clientId: string;
    clientSecret: string;
    redirectUrl: string;
    scopes: string;
    httpTimeoutSeconds: number;
    claims: Readonly<{
        login: string;
        email: string;
        groups: string;
    }>;
    allow: Readonly<{
        usersAllowlist: readonly string[];
        emailDomains: readonly string[];
        groupsAny: readonly string[];
        groupsAll: readonly string[];
    }>;
    fetchUserInfo: boolean;
    storeRefreshToken: boolean;
    ui: Readonly<{
        buttonColor: string | null;
        iconHint: string | null;
    }>;
}>;

export type ResolveAuthProviderInstancesResult = Readonly<{
    instances: readonly OidcAuthProviderInstanceConfig[];
    errors: readonly string[];
}>;

function readConfigFromPath(path: string): { raw: string } | { error: string } {
    try {
        const raw = readFileSync(path, "utf8");
        return { raw };
    } catch {
        return { error: `Invalid AUTH_PROVIDERS_CONFIG_PATH: cannot read file` };
    }
}

function normalizeProviderId(input: unknown): string | null {
    if (typeof input !== "string") return null;
    const normalized = input.trim().toLowerCase();
    if (!normalized) return null;
    return normalized;
}

function expectString(value: unknown, field: string, errors: string[]): string | null {
    if (typeof value !== "string" || value.trim() === "") {
        errors.push(`Invalid ${field}: expected non-empty string`);
        return null;
    }
    return value;
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
    if (typeof value === "boolean") return value;
    if (typeof value !== "string") return fallback;
    const normalized = value.trim().toLowerCase();
    if (!normalized) return fallback;
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
    return fallback;
}

function validateIssuerUrl(issuer: string, providerId: string, errors: string[]): boolean {
    let url: URL;
    try {
        url = new URL(issuer);
    } catch {
        errors.push(`Invalid issuer for ${providerId}: must be a valid URL`);
        return false;
    }

    const protocol = url.protocol.toLowerCase();
    if (protocol === "https:") return true;
    if (protocol === "http:" && isLoopbackHostname(url.hostname)) return true;

    errors.push(`Invalid issuer for ${providerId}: must be https:// (or http://localhost for local testing)`);
    return false;
}

function parseScopes(raw: unknown, errors: string[], providerId: string): string | null {
    const fallback = "openid profile email";
    const value = typeof raw === "string" && raw.trim() ? raw.trim() : fallback;
    const scopes = value
        .split(/\s+/g)
        .map((s) => s.trim())
        .filter(Boolean);
    const seen = new Set<string>();
    const normalized = scopes.filter((s) => {
        const v = s.toLowerCase();
        if (seen.has(v)) return false;
        seen.add(v);
        return true;
    });
    if (!normalized.some((s) => s.toLowerCase() === "openid")) {
        errors.push(`Invalid scopes for ${providerId}: must include "openid"`);
        return null;
    }
    return normalized.join(" ");
}

function parseClaimName(raw: unknown, fallback: string): string {
    if (typeof raw !== "string") return fallback;
    const trimmed = raw.trim();
    return trimmed ? trimmed : fallback;
}

function parseClaims(raw: unknown): OidcAuthProviderInstanceConfig["claims"] {
    const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    return Object.freeze({
        login: parseClaimName(record.login, "preferred_username"),
        email: parseClaimName(record.email, "email"),
        groups: parseClaimName(record.groups, "groups"),
    });
}

function parseStringList(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    for (const v of raw) {
        if (typeof v !== "string") continue;
        const trimmed = v.trim();
        if (!trimmed) continue;
        out.push(trimmed);
    }
    return out;
}

function parseLowercaseIdList(raw: unknown): string[] {
    return parseStringList(raw).map((v) => v.toLowerCase());
}

function parseEmailDomainList(raw: unknown): string[] {
    return parseStringList(raw)
        .map((v) => v.trim().toLowerCase())
        .map((v) => (v.startsWith("@") ? v.slice(1) : v))
        .filter(Boolean);
}

function parseAllow(raw: unknown): OidcAuthProviderInstanceConfig["allow"] {
    const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    return Object.freeze({
        usersAllowlist: Object.freeze(parseLowercaseIdList(record.usersAllowlist)),
        emailDomains: Object.freeze(parseEmailDomainList(record.emailDomains)),
        groupsAny: Object.freeze(parseLowercaseIdList(record.groupsAny)),
        groupsAll: Object.freeze(parseLowercaseIdList(record.groupsAll)),
    });
}

function parseUi(raw: unknown): OidcAuthProviderInstanceConfig["ui"] {
    const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    const buttonColor =
        typeof record.buttonColor === "string" && record.buttonColor.trim() ? record.buttonColor.trim() : null;
    const iconHint = typeof record.iconHint === "string" && record.iconHint.trim() ? record.iconHint.trim() : null;
    return Object.freeze({ buttonColor, iconHint });
}

function parseHttpTimeoutSeconds(raw: unknown): number {
    const fallback = 30;
    const max = 120;

    const num = typeof raw === "number" ? raw : typeof raw === "string" ? Number.parseInt(raw.trim(), 10) : Number.NaN;
    if (!Number.isFinite(num)) return fallback;
    const clamped = Math.max(1, Math.min(max, Math.floor(num)));
    return clamped;
}

export function resolveAuthProviderInstancesFromEnv(env: NodeJS.ProcessEnv): ResolveAuthProviderInstancesResult {
    const configPath = (env.AUTH_PROVIDERS_CONFIG_PATH ?? "").toString().trim();
    const rawFromPath = configPath ? readConfigFromPath(configPath) : null;
    const raw =
        rawFromPath && "raw" in rawFromPath
            ? rawFromPath.raw
            : (env.AUTH_PROVIDERS_CONFIG_JSON ?? "");

    if (rawFromPath && "error" in rawFromPath) {
        return { instances: [], errors: [rawFromPath.error] };
    }

    if (!raw) return { instances: [], errors: [] };

    const errors: string[] = [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return { instances: [], errors: ["Invalid AUTH_PROVIDERS_CONFIG_JSON: must be valid JSON"] };
    }

    if (!Array.isArray(parsed)) {
        return { instances: [], errors: ["Invalid AUTH_PROVIDERS_CONFIG_JSON: must be a JSON array"] };
    }

    const instances: OidcAuthProviderInstanceConfig[] = [];
    const seen = new Set<string>();

    for (const entry of parsed) {
        if (typeof entry !== "object" || entry === null) {
            errors.push("Invalid provider entry: expected object");
            continue;
        }
        const record = entry as Record<string, unknown>;

        const normalizedId = normalizeProviderId(record.id);
        if (!normalizedId) {
            errors.push("Invalid id: expected non-empty string");
            continue;
        }
        if (seen.has(normalizedId)) {
            errors.push(`Duplicate provider id: ${normalizedId}`);
            continue;
        }
        seen.add(normalizedId);

        const type = record.type;
        if (type !== "oidc") {
            errors.push(`Invalid type for ${normalizedId}: expected "oidc"`);
            continue;
        }

        const displayName = expectString(record.displayName, `displayName for ${normalizedId}`, errors);
        const issuer = expectString(record.issuer, `issuer for ${normalizedId}`, errors);
        const clientId = expectString(record.clientId, `clientId for ${normalizedId}`, errors);
        const clientSecret = expectString(record.clientSecret, `clientSecret for ${normalizedId}`, errors);
        const redirectUrl = expectString(record.redirectUrl, `redirectUrl for ${normalizedId}`, errors);

        if (!displayName || !issuer || !clientId || !clientSecret || !redirectUrl) continue;
        if (!validateIssuerUrl(issuer, normalizedId, errors)) continue;

        const scopes = parseScopes(record.scopes, errors, normalizedId);
        if (!scopes) continue;

        const httpTimeoutSeconds = parseHttpTimeoutSeconds(record.httpTimeoutSeconds);
        const claims = parseClaims(record.claims);
        const allow = parseAllow(record.allow);
        const fetchUserInfo = parseBoolean(record.fetchUserInfo, false);
        const storeRefreshToken = parseBoolean(record.storeRefreshToken, false);
        const ui = parseUi(record.ui);

        instances.push({
            id: normalizedId,
            type: "oidc",
            displayName,
            issuer,
            clientId,
            clientSecret,
            redirectUrl,
            scopes,
            httpTimeoutSeconds,
            claims,
            allow,
            fetchUserInfo,
            storeRefreshToken,
            ui,
        });
    }

    if (errors.length > 0) return { instances: [], errors };

    return { instances, errors: [] };
}
