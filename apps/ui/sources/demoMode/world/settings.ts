import type { Settings } from '@/sync/domains/settings/settings';
import { buildDemoConnectedServicesSettings } from './connectedAccounts';
import { DEMO_CLIENT_FEATURE_TOGGLES } from './serverFeatures';
import { buildDemoSubagentGuidanceEntries } from './subagentGuidance';

/**
 * Every account setting the demo world owns. `buildDemoSettings` is typed
 * against this list, and the seed snapshot restores exactly these keys, so a
 * new demo setting cannot be projected into the real store without also being
 * restored on teardown.
 */
const DEMO_WORLD_SETTINGS_KEYS = [
    'featureToggles',
    'hideInactiveSessions',
    'sessionListDensity',
    'sessionListSectionModeV1',
    'sessionListAttentionPromotionModeV1',
    'sessionListWorkingPlacementModeV1',
    'executionRunsGuidanceEnabled',
    'executionRunsGuidanceMaxChars',
    'executionRunsGuidanceEntries',
    'connectedServicesDefaultProfileByServiceId',
    'connectedServicesProfileLabelByKey',
    'connectedServicesDefaultAuthByAgentIdV1',
    'scmCommitStrategy',
    'scmRemoteConfirmPolicy',
    'scmPushRejectPolicy',
    'scmCommitMessageGeneratorEnabled',
    'scmCommitMessageGeneratorInstructions',
    'scmIncludeCoAuthoredBy',
] as const satisfies readonly (keyof Settings)[];

export type DemoWorldSettingKey = typeof DEMO_WORLD_SETTINGS_KEYS[number];

export type DemoWorldSettings = Pick<Settings, DemoWorldSettingKey>;

export function buildDemoSettings(): DemoWorldSettings {
    return {
        featureToggles: {
            // A5 subagents: `execution.runs` is the client-represented substrate the
            // sub-agent screen gates its whole delegation model on.
            'execution.runs': true,
            ...DEMO_CLIENT_FEATURE_TOGGLES,
        },
        hideInactiveSessions: false,
        sessionListDensity: 'narrow',
        sessionListSectionModeV1: 'single',
        sessionListAttentionPromotionModeV1: 'global',
        sessionListWorkingPlacementModeV1: 'global',
        executionRunsGuidanceEnabled: true,
        executionRunsGuidanceMaxChars: 4_000,
        executionRunsGuidanceEntries: buildDemoSubagentGuidanceEntries(),
        ...buildDemoConnectedServicesSettings(),
        // A9 source control: a workspace someone has actually configured — live Git
        // staging, a confirmation before anything leaves the machine, generated
        // commit messages, and agent attribution on.
        scmCommitStrategy: 'git_staging',
        scmRemoteConfirmPolicy: 'push_only',
        scmPushRejectPolicy: 'auto_fetch',
        scmCommitMessageGeneratorEnabled: true,
        scmCommitMessageGeneratorInstructions:
            'Conventional Commits. One line on what changed and why, then a short body when the reason is not obvious from the diff.',
        scmIncludeCoAuthoredBy: true,
    };
}
