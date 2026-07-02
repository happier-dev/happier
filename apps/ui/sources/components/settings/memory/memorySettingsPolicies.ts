import type {
    MemoryContentPolicyV1,
    MemoryCoveragePolicyV1,
    MemorySettingsV1,
} from '@happier-dev/protocol';

export const DEFAULT_MEMORY_COVERAGE_POLICY: MemoryCoveragePolicyV1 = { type: 'full' };

export const DEFAULT_MEMORY_CONTENT_POLICY: MemoryContentPolicyV1 = {
    includeUserMessages: true,
    includeAssistantMessages: true,
    includeReasoning: false,
    includeToolSummaries: false,
    includeToolOutputs: false,
};

export function readMemoryCoveragePolicy(settings: MemorySettingsV1): MemoryCoveragePolicyV1 {
    return settings.coveragePolicy ?? DEFAULT_MEMORY_COVERAGE_POLICY;
}

export function readMemoryContentPolicy(settings: MemorySettingsV1): MemoryContentPolicyV1 {
    return {
        ...DEFAULT_MEMORY_CONTENT_POLICY,
        ...(settings.contentPolicy ?? {}),
    };
}

export function withMemoryCoveragePolicy(
    settings: MemorySettingsV1,
    coveragePolicy: MemoryCoveragePolicyV1,
): MemorySettingsV1 {
    return {
        ...settings,
        coveragePolicy,
    };
}

export function withMemoryContentPolicy(
    settings: MemorySettingsV1,
    contentPolicy: MemoryContentPolicyV1,
): MemorySettingsV1 {
    return {
        ...settings,
        contentPolicy,
    };
}
