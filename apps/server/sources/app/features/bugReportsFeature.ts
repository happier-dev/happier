import { parseBooleanEnv, parseIntEnv } from "@/config/env";
import { BUG_REPORT_DEFAULT_ACCEPTED_ARTIFACT_KINDS, normalizeBugReportProviderUrl } from "@happier-dev/protocol";
import type { FeaturesResponse } from "./types";

const DEFAULT_PROVIDER_URL = "https://reports.happier.dev";
const DEFAULT_ACCEPTED_KINDS = [...BUG_REPORT_DEFAULT_ACCEPTED_ARTIFACT_KINDS];
const DEFAULT_CONTEXT_WINDOW_MS = 30 * 60 * 1000;

function parseAcceptedKinds(raw: string | undefined): string[] {
    const value = (raw ?? "").trim();
    if (!value) return DEFAULT_ACCEPTED_KINDS;
    const parts = Array.from(
        new Set(
            value
                .split(",")
                .map((part) => part.trim().toLowerCase())
                .filter(Boolean),
        ),
    );
    return parts.length > 0 ? parts : DEFAULT_ACCEPTED_KINDS;
}

export function resolveBugReportsFeature(env: NodeJS.ProcessEnv): Pick<FeaturesResponse["features"], "bugReports"> {
    const enabled = parseBooleanEnv(env.HAPPIER_BUG_REPORTS_ENABLED, true);
    const hasExplicitProviderUrl = typeof env.HAPPIER_BUG_REPORTS_PROVIDER_URL === "string";
    const providerUrlRaw = (hasExplicitProviderUrl ? (env.HAPPIER_BUG_REPORTS_PROVIDER_URL ?? "") : DEFAULT_PROVIDER_URL).trim();
    const providerUrl = normalizeBugReportProviderUrl(providerUrlRaw);

    const defaultIncludeDiagnostics = parseBooleanEnv(env.HAPPIER_BUG_REPORTS_DEFAULT_INCLUDE_DIAGNOSTICS, true);
    const maxArtifactBytes = parseIntEnv(env.HAPPIER_BUG_REPORTS_MAX_ARTIFACT_BYTES, 10 * 1024 * 1024, { min: 1024 });
    const uploadTimeoutMs = parseIntEnv(env.HAPPIER_BUG_REPORTS_UPLOAD_TIMEOUT_MS, 120000, { min: 5000 });
    const contextWindowMs = parseIntEnv(env.HAPPIER_BUG_REPORTS_CONTEXT_WINDOW_MS, DEFAULT_CONTEXT_WINDOW_MS, {
        min: 1000,
        max: 24 * 60 * 60 * 1000,
    });
    const acceptedArtifactKinds = parseAcceptedKinds(env.HAPPIER_BUG_REPORTS_ACCEPTED_ARTIFACT_KINDS);

    return {
        bugReports: {
            enabled,
            providerUrl,
            defaultIncludeDiagnostics,
            maxArtifactBytes,
            acceptedArtifactKinds,
            uploadTimeoutMs,
            contextWindowMs,
        },
    };
}
