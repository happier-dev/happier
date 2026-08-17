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
            // beat: the seeded accounts and pools render the real screen instead of
            // its empty state, and the blast radius stays inside it.
            //
            // Quota meters stay off. Their snapshots are fetched per credential
            // scope, and the pre-auth journey has no credentials, so an enabled
            // quota surface can only render an empty "no usage data" card directly
            // under a headline about usage — worse than not showing it at all.
            connectedServices: {
                enabled: true,
                quotas: { enabled: false },
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
