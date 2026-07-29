import { FeaturesResponseSchema, type FeaturesResponse } from '@happier-dev/protocol';

const KEEP_FOREVER_POLICY = { mode: 'keep_forever' } as const;

// `sessions.direct` is the deployed, fail-closed wire id selected by A12.
// It is client-represented, so the demo enables it through the canonical local
// feature-toggle owner rather than inventing a server payload bit.
export const DEMO_CLIENT_FEATURE_TOGGLES = {
    'sessions.direct': true,
} as const;

export function buildDemoServerFeatures(): FeaturesResponse {
    return FeaturesResponseSchema.parse({
        features: {
            sessions: {
                enabled: true,
                folders: { enabled: false },
                handoff: { enabled: false },
                usageLimitRecovery: { enabled: false },
            },
            // Connected accounts + pools power the A12 subscriptions/accounts dream
            // beat. With zero connected profiles seeded this only surfaces the real
            // service catalog (no quota badges leak into the session surfaces), so
            // the blast radius stays inside the connected-services screen.
            connectedServices: {
                enabled: true,
                quotas: { enabled: true },
                accountGroups: { enabled: true },
            },
        },
        capabilities: {
            server: {
                retention: {
                    policyVersion: 1,
                    enabled: false,
                    sessions: KEEP_FOREVER_POLICY,
                    accountChanges: KEEP_FOREVER_POLICY,
                    voiceSessionLeases: KEEP_FOREVER_POLICY,
                    userFeedItems: KEEP_FOREVER_POLICY,
                    sessionShareAccessLogs: KEEP_FOREVER_POLICY,
                    publicShareAccessLogs: KEEP_FOREVER_POLICY,
                    terminalAuthRequests: KEEP_FOREVER_POLICY,
                    accountAuthRequests: KEEP_FOREVER_POLICY,
                    authPairingSessions: KEEP_FOREVER_POLICY,
                    repeatKeys: KEEP_FOREVER_POLICY,
                    globalLocks: KEEP_FOREVER_POLICY,
                    automationRuns: KEEP_FOREVER_POLICY,
                    automationRunEvents: KEEP_FOREVER_POLICY,
                },
            },
        },
    });
}
