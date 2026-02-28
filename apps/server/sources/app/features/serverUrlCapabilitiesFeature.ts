import type { FeaturesPayloadDelta } from "./types";

function normalizeHttpUrl(raw: string): string | null {
    const value = String(raw ?? "").trim();
    if (!value) return null;
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password) {
        parsed.username = "";
        parsed.password = "";
    }
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
}

export function resolveServerUrlCapabilitiesFeature(
    env: NodeJS.ProcessEnv,
): FeaturesPayloadDelta {
    const canonicalServerUrl =
        normalizeHttpUrl(String(env.HAPPIER_PUBLIC_SERVER_URL ?? "")) ?? undefined;
    const webappUrl =
        normalizeHttpUrl(String(env.HAPPIER_WEBAPP_URL ?? "")) ?? undefined;

    if (!canonicalServerUrl && !webappUrl) {
        return {};
    }

    return {
        capabilities: {
            server: {
                ...(canonicalServerUrl ? { canonicalServerUrl } : null),
                ...(webappUrl ? { webappUrl } : null),
            },
        },
    };
}
