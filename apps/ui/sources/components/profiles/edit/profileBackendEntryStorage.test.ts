import { describe, expect, it } from 'vitest';

import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { projectHistoricalBuiltInAiLaunchProfileV1 } from '@happier-dev/protocol';
import { AIBackendProfileSchema } from '@/sync/domains/profiles/profileCompatibility';

import {
    isProfileCompatibleWithResolvedBackendEntry,
    readProfileTargetKeyValueForEntry,
    resolveProfileBackendTargetKeyForEntry,
    stripLegacyProviderSentinelTargetKeys,
} from './profileBackendEntryStorage';
import { buildLegacyProfileSave } from './legacy/buildLegacyProfileSave';

const pluginBackendEntry: ResolvedBackendCatalogEntry = {
    backendTarget: { kind: 'backend', backendId: 'acme.review.backend' },
    backendTargetKey: resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'acme.review.backend' }),
    kind: 'pluginBackend',
    backendId: 'acme.review.backend',
    agentId: 'acme.review.provider',
    catalogAgentId: 'claude',
    builtInAgentId: null,
    iconAgentId: 'claude',
    title: 'Acme Review Backend',
    subtitle: 'Plugin-backed review engine',
};
const ohMyPiEntry: ResolvedBackendCatalogEntry = {
    backendTarget: { kind: 'backend', backendId: 'ohMyPi', sourceKind: 'built_in' },
    backendTargetKey: 'agent:happier.agent.ohmypi/ohmypi',
    kind: 'builtInAgent',
    backendId: 'ohMyPi',
    agentId: 'ohMyPi',
    catalogAgentId: 'ohMyPi',
    builtInAgentId: 'ohMyPi',
    iconAgentId: 'ohMyPi',
    title: 'Oh My Pi',
    subtitle: 'Oh My Pi',
};

describe('profileBackendEntryStorage', () => {
    it('reads explicit compatibility by backend target key', () => {
        const profileTargetKey = resolveProfileBackendTargetKeyForEntry(pluginBackendEntry);
        expect(readProfileTargetKeyValueForEntry(
            {
                [profileTargetKey]: true,
            },
            pluginBackendEntry,
        )).toBe(true);
    });

    it('treats explicit compatibility as authoritative for plugin backends', () => {
        const profileTargetKey = resolveProfileBackendTargetKeyForEntry(pluginBackendEntry);
        expect(isProfileCompatibleWithResolvedBackendEntry(
            {
                compatibility: {},
                compatibilityByTargetKey: { [profileTargetKey]: true },
                isBuiltIn: false,
            },
            pluginBackendEntry,
        )).toBe(true);
    });

    it('returns a shallow copy when asked to strip legacy target-key sentinels', () => {
        const profileTargetKey = resolveProfileBackendTargetKeyForEntry(pluginBackendEntry);
        expect(stripLegacyProviderSentinelTargetKeys(
            {
                [pluginBackendEntry.backendTargetKey]: true,
                [profileTargetKey]: true,
                'backend:unused': undefined,
            },
            [pluginBackendEntry],
        )).toEqual({
            [profileTargetKey]: true,
        });
    });

    it('reads a flat Oh My Pi profile once and saves only the qualified Agent key', () => {
        const seeded = AIBackendProfileSchema.parse({
            id: 'omp-profile',
            name: 'Oh My Pi profile',
            environmentVariables: [],
            authMode: 'machineLogin',
            requiresMachineLoginTargetKey: 'agent:ohMyPi',
            defaultPermissionModeByTargetKey: { 'agent:ohMyPi': 'acceptEdits' },
            defaultPersistenceModeByTargetKey: { 'agent:ohMyPi': 'direct' },
            compatibilityByTargetKey: { 'agent:ohMyPi': true },
            compatibility: {},
            isBuiltIn: false,
            createdAt: 1,
            updatedAt: 1,
        });
        const qualifiedKey = 'agent:happier.agent.ohmypi/ohmypi';

        const saved = buildLegacyProfileSave({
            profile: seeded,
            name: seeded.name,
            environmentVariables: seeded.environmentVariables,
            envVarRequirements: seeded.envVarRequirements,
            authMode: seeded.authMode,
            machineLoginTargetKey: qualifiedKey,
            resolvedBackendEntries: [ohMyPiEntry],
            supportedDirectBackendEntries: [ohMyPiEntry],
            defaultPermissionModesByTargetKey: { [qualifiedKey]: 'acceptEdits' },
            defaultTranscriptStorageModesByTargetKey: { [qualifiedKey]: 'direct' },
            compatibilityByTargetKey: { [qualifiedKey]: true },
            updatedAt: 2,
        });
        expect(saved).toMatchObject({
            requiresMachineLoginTargetKey: qualifiedKey,
            defaultPermissionModeByTargetKey: { [qualifiedKey]: 'acceptEdits' },
            defaultPersistenceModeByTargetKey: { [qualifiedKey]: 'direct' },
            compatibilityByTargetKey: { [qualifiedKey]: true },
        });
        expect(AIBackendProfileSchema.parse(saved)).toMatchObject(saved);
        expect(JSON.stringify(saved)).not.toContain('ohMyPi');
    });

    it('retains a predecessor coding-prompt field across a legacy-form save without emitting the V2 projection on a legacy row', () => {
        const seeded = projectHistoricalBuiltInAiLaunchProfileV1(AIBackendProfileSchema.parse({
            id: 'remote-dev-profile',
            name: 'Remote Dev Profile',
            environmentVariables: [],
            defaultPermissionModeByTargetKey: {},
            defaultPersistenceModeByTargetKey: {},
            compatibilityByTargetKey: {},
            compatibility: {},
            isBuiltIn: false,
            createdAt: 1,
            updatedAt: 1,
            codingPromptBehaviorV1: {
                v: 1,
                sessionTitleUpdates: 'initial',
                responseOptions: 'disabled',
            },
        }));

        const saved = buildLegacyProfileSave({
            profile: seeded,
            name: seeded.name,
            environmentVariables: seeded.environmentVariables,
            envVarRequirements: seeded.envVarRequirements,
            authMode: seeded.authMode,
            machineLoginTargetKey: null,
            resolvedBackendEntries: [],
            supportedDirectBackendEntries: [],
            defaultPermissionModesByTargetKey: {},
            defaultTranscriptStorageModesByTargetKey: {},
            compatibilityByTargetKey: {},
            updatedAt: 2,
        });

        expect(saved.codingPromptBehaviorV1).toEqual({
            v: 1,
            sessionTitleUpdates: 'initial',
            responseOptions: 'disabled',
        });
        expect(saved).not.toHaveProperty('codingPromptBehaviorOverrides');
        expect(projectHistoricalBuiltInAiLaunchProfileV1(AIBackendProfileSchema.parse(saved)))
            .toMatchObject({
                codingPromptBehaviorOverrides: {
                    sessionTitleUpdates: 'initial',
                    responseOptions: 'disabled',
                },
            });
    });
});
