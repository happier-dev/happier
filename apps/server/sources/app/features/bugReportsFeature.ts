import { BUG_REPORT_DEFAULT_ACCEPTED_ARTIFACT_KINDS, normalizeBugReportProviderUrl } from "@happier-dev/protocol";
import type { FeaturesResponse } from "./types";
import { readBugReportsFeatureEnv } from "./catalog/readFeatureEnv";
import { isServerFeatureEnabledByBuildPolicy } from "./catalog/serverFeatureBuildPolicy";

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
    const config = readBugReportsFeatureEnv(env);
    const buildEnabled = isServerFeatureEnabledByBuildPolicy("bugReports", env);
    const hasExplicitProviderUrl = typeof config.providerUrlRaw === "string";
    const providerUrlRaw = (hasExplicitProviderUrl ? (config.providerUrlRaw ?? "") : DEFAULT_PROVIDER_URL).trim();
    const providerUrl = normalizeBugReportProviderUrl(providerUrlRaw);

    const defaultIncludeDiagnostics = config.defaultIncludeDiagnostics;
    const maxArtifactBytes = config.maxArtifactBytes;
    const uploadTimeoutMs = config.uploadTimeoutMs;
    const contextWindowMs = config.contextWindowMs;
    const acceptedArtifactKinds = parseAcceptedKinds(config.acceptedArtifactKindsRaw);

    return {
        bugReports: {
            enabled: buildEnabled && config.enabled,
            providerUrl,
            defaultIncludeDiagnostics,
            maxArtifactBytes,
            acceptedArtifactKinds,
            uploadTimeoutMs,
            contextWindowMs,
        },
    };
}
