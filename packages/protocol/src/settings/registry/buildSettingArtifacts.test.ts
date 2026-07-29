import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import { buildSettingArtifacts } from './buildSettingArtifacts.js';
import { defineSettingDefinitions, type SettingDefinitionMap } from './settingDefinition.js';

describe('buildSettingArtifacts', () => {
  it('derives schema shape, defaults, and tracked definitions from one definition map', () => {
    const definitions = {
      analyticsOptOut: {
        schema: z.boolean(),
        default: false,
        description: 'Opt out of analytics',
        storageScope: 'account',
        analytics: {
          trackCurrentState: true,
          trackChanges: true,
          valueKind: 'boolean',
          privacy: 'safe',
          identityScope: 'person',
        },
      },
      sessionListDensity: {
        schema: z.enum(['detailed', 'cozy', 'narrow']),
        default: 'cozy',
        description: 'Session list density',
        storageScope: 'account',
        analytics: {
          trackCurrentState: true,
          trackChanges: true,
          valueKind: 'enum',
          privacy: 'safe',
          identityScope: 'person',
          serializeDerivedProperties: (value) => ({
            compact: value === 'cozy' || value === 'narrow',
          }),
        },
      },
      debugNotes: {
        schema: z.string(),
        default: '',
        description: 'Internal notes',
        storageScope: 'account',
      },
    } satisfies SettingDefinitionMap;

    const artifacts = buildSettingArtifacts(definitions);

    expect(Object.keys(artifacts.shape)).toEqual(['analyticsOptOut', 'sessionListDensity', 'debugNotes']);
    expect(artifacts.defaults).toEqual({
      analyticsOptOut: false,
      sessionListDensity: 'cozy',
      debugNotes: '',
    });
    expect(Object.keys(artifacts.trackedCurrentStateDefinitions)).toEqual(['analyticsOptOut', 'sessionListDensity']);
    expect(Object.keys(artifacts.trackedChangeDefinitions)).toEqual(['analyticsOptOut', 'sessionListDensity']);
    expect(Object.keys(artifacts.trackedDerivedDefinitions)).toEqual(['sessionListDensity']);
  });

  it('rejects defaults that do not satisfy the declared schema', () => {
    expect(() =>
      buildSettingArtifacts({
        badSetting: {
          schema: z.number().int(),
          default: 'not-a-number',
          description: 'Invalid default',
          storageScope: 'account',
        },
      } as unknown as SettingDefinitionMap),
    ).toThrow(/badSetting/);
  });

  it('preserves analytics definitions with structured property serializers', () => {
    const definitions = {
      backendEnabledById: {
        schema: z.record(z.string(), z.boolean()),
        default: { claude: true, codex: false },
        description: 'Per-backend enablement state',
        storageScope: 'account',
        analytics: {
          trackCurrentState: true,
          trackChanges: true,
          valueKind: 'boolean',
          privacy: 'safe',
          identityScope: 'person',
          serializeCurrentProperties: (value) => ({
            claude: value.claude,
            codex: value.codex,
          }),
        },
      },
    } satisfies SettingDefinitionMap;

    const artifacts = buildSettingArtifacts(definitions);

    expect(artifacts.trackedCurrentStateDefinitions.backendEnabledById?.analytics?.serializeCurrentProperties?.({
      claude: false,
      codex: true,
    })).toEqual({
      claude: false,
      codex: true,
    });
  });

  it('rejects tracked analytics definitions marked as forbidden privacy', () => {
    expect(() =>
      buildSettingArtifacts({
        secretApiKey: {
          schema: z.string(),
          default: '',
          description: 'Secret API key',
          storageScope: 'account',
          analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'presence',
            privacy: 'forbidden',
            identityScope: 'person',
          },
        },
      } satisfies SettingDefinitionMap),
    ).toThrow(/secretApiKey/);
  });

  it('rejects analytics metadata that is missing required fields', () => {
    const definitions = defineSettingDefinitions({
      missingPrivacy: {
        schema: z.boolean(),
        default: false,
        description: 'Missing privacy',
        storageScope: 'account',
        analytics: {
          trackCurrentState: true,
          trackChanges: true,
          valueKind: 'boolean',
          identityScope: 'person',
        },
      },
      missingValueKind: {
        schema: z.boolean(),
        default: false,
        description: 'Missing valueKind',
        storageScope: 'account',
        analytics: {
          trackCurrentState: true,
          trackChanges: true,
          privacy: 'safe',
          identityScope: 'person',
        },
      },
      missingIdentityScope: {
        schema: z.boolean(),
        default: false,
        description: 'Missing identityScope',
        storageScope: 'account',
        analytics: {
          trackCurrentState: true,
          trackChanges: true,
          valueKind: 'boolean',
          privacy: 'safe',
        },
      },
    });

    expect(() => buildSettingArtifacts({ missingPrivacy: definitions.missingPrivacy } as unknown as SettingDefinitionMap))
      .toThrow(/missingPrivacy/);
    expect(() => buildSettingArtifacts({ missingValueKind: definitions.missingValueKind } as unknown as SettingDefinitionMap))
      .toThrow(/missingValueKind/);
    expect(() => buildSettingArtifacts({ missingIdentityScope: definitions.missingIdentityScope } as unknown as SettingDefinitionMap))
      .toThrow(/missingIdentityScope/);
  });

  it('rejects non-safe analytics privacy when no serializer is provided', () => {
    expect(() =>
      buildSettingArtifacts({
        bucketedCount: {
          schema: z.number().int().nonnegative(),
          default: 0,
          description: 'Count bucketed by privacy policy',
          storageScope: 'account',
          analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'bucket',
            privacy: 'bucketed',
            identityScope: 'person',
          },
        },
      } satisfies SettingDefinitionMap),
    ).toThrow(/bucketedCount/);

    expect(() =>
      buildSettingArtifacts({
        countOnly: {
          schema: z.number().int().nonnegative(),
          default: 0,
          description: 'Count-only privacy policy',
          storageScope: 'account',
          analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'count',
            privacy: 'count_only',
            identityScope: 'person',
          },
        },
      } satisfies SettingDefinitionMap),
    ).toThrow(/countOnly/);

    expect(() =>
      buildSettingArtifacts({
        presenceOnly: {
          schema: z.string(),
          default: '',
          description: 'Presence-only privacy policy',
          storageScope: 'account',
          analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'presence',
            privacy: 'presence_only',
            identityScope: 'person',
          },
        },
      } satisfies SettingDefinitionMap),
    ).toThrow(/presenceOnly/);
  });

  it('preserves schema-derived value types when merging already-normalized definition maps', () => {
    const profileDefinitions = defineSettingDefinitions({
      profiles: {
        schema: z.array(z.object({ id: z.string(), name: z.string() })),
        default: [],
        description: 'Profiles',
        storageScope: 'account',
      },
    });
    const serverSelectionDefinitions = defineSettingDefinitions({
      serverSelectionGroups: {
        schema: z.array(z.object({
          id: z.string(),
          name: z.string(),
          serverIds: z.array(z.string()),
          presentation: z.enum(['grouped', 'flat-with-badge']),
        })),
        default: [],
        description: 'Saved server selection groups',
        storageScope: 'account',
      },
    });

    const mergedDefinitions = defineSettingDefinitions({
      ...profileDefinitions,
      ...serverSelectionDefinitions,
    });
    const artifacts = buildSettingArtifacts(mergedDefinitions);

    expectTypeOf(artifacts.defaults.profiles).toEqualTypeOf<Array<{ id: string; name: string }>>();
    expectTypeOf(artifacts.defaults.serverSelectionGroups).toEqualTypeOf<Array<{
      id: string;
      name: string;
      serverIds: string[];
      presentation: 'grouped' | 'flat-with-badge';
    }>>();
    expect(artifacts.defaults.profiles).toEqual([]);
    expect(artifacts.defaults.serverSelectionGroups).toEqual([]);
  });
});
