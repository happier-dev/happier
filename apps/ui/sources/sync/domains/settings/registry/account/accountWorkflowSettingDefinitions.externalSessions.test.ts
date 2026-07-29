import { describe, expect, it } from 'vitest';

import { serializeTrackedSettingEntries } from '../../../../../track/settingsAnalytics/serializeTrackedSettingEntries';
import { applySettings, settingsParse } from '../../settings';
import { ACCOUNT_WORKFLOW_SETTING_DEFINITIONS } from './accountWorkflowSettingDefinitions';

const POLICY = {
    machineId: 'machine-1',
    qualifiedIdentity: {
        v: 1 as const,
        agent: {
            pluginId: 'com.example.external-agent',
            localId: 'assistant',
        },
        source: {
            kind: 'claudeConfig',
            contractVersion: 1 as const,
        },
    },
    sourcePolicyId: `es-source-policy:v1:${'a'.repeat(64)}`,
    enabledAtMs: 1_000,
};

describe('externalSessionsSettingsV1 account persistence', () => {
    it('migrates absent intent to default-off and preserves current policies through rehydration', () => {
        const migrated = settingsParse({
            schemaVersion: 7,
        });

        expect(migrated.externalSessionsSettingsV1).toEqual({
            v: 1,
            keepPassivelyFollowingAfterRestart: false,
            autoLinkSourcePolicies: [],
        });

        const enabled = applySettings(migrated, {
            externalSessionsSettingsV1: {
                v: 1,
                keepPassivelyFollowingAfterRestart: true,
                autoLinkSourcePolicies: [POLICY],
                futureField: { revision: 2 },
            },
        });
        const rehydrated = settingsParse(JSON.parse(JSON.stringify(enabled)));

        expect(rehydrated.externalSessionsSettingsV1).toEqual({
            v: 1,
            keepPassivelyFollowingAfterRestart: true,
            autoLinkSourcePolicies: [POLICY],
            futureField: { revision: 2 },
        });
    });

    it('rehydrates malformed policy data as disabled without clearing passive follow', () => {
        const rehydrated = settingsParse({
            schemaVersion: 7,
            externalSessionsSettingsV1: {
                v: 1,
                keepPassivelyFollowingAfterRestart: true,
                autoLinkSourcePolicies: [
                    POLICY,
                    { ...POLICY, enabledAtMs: 2_000 },
                ],
            },
        });

        expect(rehydrated.externalSessionsSettingsV1).toEqual({
            v: 1,
            keepPassivelyFollowingAfterRestart: true,
            autoLinkSourcePolicies: [],
        });
    });

    it('serializes only passive intent and the aggregate enabled policy count', () => {
        const analytics = ACCOUNT_WORKFLOW_SETTING_DEFINITIONS
            .externalSessionsSettingsV1
            .analytics;
        expect(analytics?.currentPropertyValueKinds).toEqual({
            keepPassivelyFollowingAfterRestart: 'boolean',
            autoLinkSourcePolicyEnabledCount: 'count',
        });
        const serialize = analytics?.serializeCurrentProperties;
        const serialized = serialize?.({
            v: 1,
            keepPassivelyFollowingAfterRestart: true,
            autoLinkSourcePolicies: [POLICY],
        });

        expect(serialized).toEqual({
            keepPassivelyFollowingAfterRestart: true,
            autoLinkSourcePolicyEnabledCount: 1,
        });
        expect(JSON.stringify(serialized)).not.toContain('machine-1');
        expect(JSON.stringify(serialized)).not.toContain('com.example.external-agent');
        expect(JSON.stringify(serialized)).not.toContain(POLICY.sourcePolicyId);

        const tracked = serializeTrackedSettingEntries(
            ACCOUNT_WORKFLOW_SETTING_DEFINITIONS.externalSessionsSettingsV1,
            {
                v: 1,
                keepPassivelyFollowingAfterRestart: true,
                autoLinkSourcePolicies: [POLICY],
            },
            'settings__externalSessionsSettingsV1',
        );
        expect(tracked).toEqual({
            settings__externalSessionsSettingsV1__keepPassivelyFollowingAfterRestart: true,
            settings__externalSessionsSettingsV1__autoLinkSourcePolicyEnabledCount: 1,
        });
        expect(JSON.stringify(tracked)).not.toContain('machine-1');
        expect(JSON.stringify(tracked)).not.toContain('com.example.external-agent');
        expect(JSON.stringify(tracked)).not.toContain(POLICY.sourcePolicyId);
    });
});
