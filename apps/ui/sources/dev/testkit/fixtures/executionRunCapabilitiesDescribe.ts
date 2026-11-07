import type { CapabilitiesDescribeResponse } from '@happier-dev/protocol/capabilities';

// Captured from createCapabilitiesService({ capabilities: [executionRunsCapability],
// checklists: {}, buildContext: async () => { throw new Error('Describe must not discover'); } }).describe()
// with HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED=1 on 2026-10-30. The CLI owns the
// descriptor; this capture avoids importing its runtime into UI tests.
export const EXECUTION_RUN_CAPABILITIES_DESCRIBE_FIXTURE = {
    protocolVersion: 1,
    capabilities: [{
        id: 'tool.executionRuns',
        kind: 'tool',
        title: 'Execution runs',
        protocol: {
            version: 2,
            features: {
                detachedScope: true,
                startAndWait: true,
                exactInputResults: true,
                runScopedAgentBindings: true,
                secretReferenceOverlay: true,
            },
            available: true,
        },
    }],
    checklists: {},
} satisfies CapabilitiesDescribeResponse;
