import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { buildSettingArtifacts, defineSettingDefinitions } from '@happier-dev/protocol';

import { buildSettingsPropertiesFromArtifacts } from './buildSettingsPropertiesFromArtifacts';
import { serializeTrackedSettingEntries } from './serializeTrackedSettingEntries';

describe('buildSettingsPropertiesFromArtifacts', () => {
    it('serializes tracked current-state and derived properties for the requested identity scope', () => {
        const artifacts = buildSettingArtifacts(defineSettingDefinitions({
            sessionListDensity: {
                schema: z.enum(['detailed', 'cozy', 'narrow']),
                default: 'detailed',
                description: 'Session list density',
                storageScope: 'account',
                analytics: {
                    trackCurrentState: true,
                    trackChanges: true,
                    valueKind: 'enum',
                    privacy: 'safe',
                    identityScope: 'person',
                    serializeDerivedProperties: (value: 'detailed' | 'cozy' | 'narrow') => ({
                        compact_session_view: value === 'cozy' || value === 'narrow',
                    }),
                },
            },
            themePreference: {
                schema: z.enum(['light', 'dark', 'system']),
                default: 'system',
                description: 'Theme preference',
                storageScope: 'local',
                analytics: {
                    trackCurrentState: true,
                    trackChanges: true,
                    valueKind: 'enum',
                    privacy: 'safe',
                    identityScope: 'device_user',
                },
            },
        } as const));

        const properties = buildSettingsPropertiesFromArtifacts({
            artifacts,
            record: {
                sessionListDensity: 'narrow',
                themePreference: 'dark',
            },
            currentPrefix: 'acct_setting__',
            derivedPrefix: 'derived__',
            identityScope: 'person',
        });

        expect(properties).toEqual({
            acct_setting__sessionListDensity: 'narrow',
            derived__compact_session_view: true,
        });
    });

    it('supports device-scoped current-state properties and derived properties from the same artifact map', () => {
        const artifacts = buildSettingArtifacts(defineSettingDefinitions({
            uiFontScale: {
                schema: z.number(),
                default: 1,
                description: 'UI font scale',
                storageScope: 'local',
                analytics: {
                    trackCurrentState: false,
                    trackChanges: false,
                    valueKind: 'bucket',
                    privacy: 'bucketed',
                    identityScope: 'device_user',
                    serializeDerivedProperties: (value: number) => ({
                        uiFontScaleBucket: typeof value === 'number' && value >= 1.2 ? 'large' : 'default',
                    }),
                },
            },
            themePreference: {
                schema: z.enum(['light', 'dark', 'system']),
                default: 'system',
                description: 'Theme preference',
                storageScope: 'local',
                analytics: {
                    trackCurrentState: true,
                    trackChanges: true,
                    valueKind: 'enum',
                    privacy: 'safe',
                    identityScope: 'device_user',
                },
            },
        } as const));

        const properties = buildSettingsPropertiesFromArtifacts({
            artifacts,
            record: {
                uiFontScale: 1.4,
                themePreference: 'dark',
            },
            currentPrefix: 'local_setting__',
            derivedPrefix: 'local_derived__',
            identityScope: 'device_user',
        });

        expect(properties).toEqual({
            local_setting__themePreference: 'dark',
            local_derived__uiFontScaleBucket: 'large',
        });
    });

    it('uses the explicit change-tracking contract instead of assuming current-state tracking', () => {
        const artifacts = buildSettingArtifacts(defineSettingDefinitions({
            sessionReplaySummaryRunnerV1: {
                schema: z.boolean(),
                default: false,
                description: 'Summary runner presence',
                storageScope: 'account',
                analytics: {
                    trackCurrentState: false,
                    trackChanges: true,
                    valueKind: 'presence',
                    privacy: 'presence_only',
                    identityScope: 'person',
                    serializeCurrent: (value: boolean) => value,
                    serializeDerivedProperties: (value: boolean) => ({
                        sessionReplaySummaryRunnerConfigured: value,
                    }),
                },
            },
        } as const));

        const currentProperties = buildSettingsPropertiesFromArtifacts({
            artifacts,
            record: {
                sessionReplaySummaryRunnerV1: true,
            },
            currentPrefix: 'acct_setting__',
            derivedPrefix: 'derived__',
            identityScope: 'person',
        });

        const changeProperties = buildSettingsPropertiesFromArtifacts({
            artifacts,
            record: {
                sessionReplaySummaryRunnerV1: true,
            },
            currentPrefix: 'acct_setting__',
            derivedPrefix: 'derived__',
            identityScope: 'person',
            trackingMode: 'change',
        });

        expect(currentProperties).toEqual({
            derived__sessionReplaySummaryRunnerConfigured: true,
        });
        expect(changeProperties).toEqual({
            acct_setting__sessionReplaySummaryRunnerV1: true,
            derived__sessionReplaySummaryRunnerConfigured: true,
        });
    });

    it('does not emit raw free-form scalar values without an explicit serializer', () => {
        const properties = serializeTrackedSettingEntries(
            {
                schema: z.string(),
                default: '',
                description: 'Free-form text',
                storageScope: 'account',
                analytics: {
                    trackCurrentState: true,
                    trackChanges: true,
                    valueKind: 'presence',
                    privacy: 'presence_only',
                    identityScope: 'person',
                },
            },
            'secret-ish value',
            'acct_setting__freeformText',
        );

        expect(properties).toEqual({});
    });
});
