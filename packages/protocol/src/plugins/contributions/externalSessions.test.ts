import { describe, expect, it } from 'vitest';

import { MAX_PLUGIN_TRANSCRIPT_SOURCES_PER_CONTRIBUTION } from '../contributionLimits.js';
import { PluginBackendExternalSessionSourceDeclarationV1Schema } from '../backendDefinitionV1.js';
import { PluginAgentContributionV2Schema } from './v2.js';
import {
  MAX_PLUGIN_AGENT_EXTERNAL_SESSION_LINK_DATA_BYTES,
  MAX_PLUGIN_AGENT_EXTERNAL_SESSION_LINK_DATA_DEPTH,
  MAX_PLUGIN_AGENT_EXTERNAL_SESSION_LINK_DATA_ENTRIES,
  PluginAgentExternalSessionLinkDataSchema,
} from './agentExternalSessions.js';

function nestedLinkData(depth: number): unknown {
  let value: unknown = true;
  for (let index = 0; index < depth; index += 1) {
    value = { nested: value };
  }
  return value;
}

function serializedUtf8Bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function source(index: number) {
  const sourceKind = `source-${index}`;
  return {
    sourceKind,
    schema: {
      fields: [{ name: 'kind', kind: 'literal', value: sourceKind }],
    },
    key: { segments: [{ kind: 'literal', value: sourceKind }] },
    instances: [{ kind: 'default', constants: {} }],
  } as const;
}

function agentWithSources(count: number) {
  return {
    id: 'external-agent',
    title: 'External Agent',
    runtime: { kind: 'custom' },
    primary: 'sessions',
    capabilities: {
      surfaces: ['externalSessions'],
      sessions: { open: ['create'], delivery: ['newTurn'], cancel: true },
    },
    surfaces: {
      externalSession: {
        sources: Array.from({ length: count }, (_, index) => source(index)),
      },
    },
  } as const;
}

function agentWithInstances(count: number) {
  const declaration = source(0);
  return {
    ...agentWithSources(1),
    surfaces: {
      externalSession: {
        sources: [{
          ...declaration,
          instances: Array.from({ length: count }, (_, index) => ({
            kind: 'connectedServiceProfiles' as const,
            serviceId: `service-${index}`,
            constants: {},
            fields: { serviceId: 'serviceId', profileId: 'profileId' },
          })),
          schema: {
            fields: [
              ...declaration.schema.fields,
              { name: 'serviceId', kind: 'string' as const },
              { name: 'profileId', kind: 'string' as const },
            ],
          },
        }],
      },
    },
  } as const;
}

describe('Agent External Sessions contribution limits', () => {
  it('refuses an Agent contribution that declares an unimplemented source instance kind', () => {
    const agent = agentWithSources(1);
    const withUnknownKind = PluginAgentContributionV2Schema.safeParse({
      ...agent,
      surfaces: {
        externalSession: {
          sources: [{
            ...source(0),
            instances: [
              { kind: 'default', constants: {} },
              { kind: 'someFutureInstanceKind', constants: {}, futureField: 'value' },
            ],
          }],
        },
      },
    });
    const withKnownKinds = PluginAgentContributionV2Schema.safeParse({
      ...agent,
      surfaces: {
        externalSession: {
          sources: [{
            ...source(0),
            instances: [{ kind: 'default', constants: {} }],
          }],
        },
      },
    });

    expect(withUnknownKind.success).toBe(false);
    expect(withKnownKinds.success).toBe(true);
    expect(withKnownKinds.success
      ? withKnownKinds.data.surfaces?.externalSession.sources[0]?.instances
      : null).toEqual([{ kind: 'default', constants: {} }]);
  });

  it('accepts only native prevention or unsupported external-linked takeover writer safety', () => {
    const agent = agentWithSources(1);
    for (const writerSafety of ['native_prevention', 'unsupported'] as const) {
      expect(PluginAgentContributionV2Schema.parse({
        ...agent,
        surfaces: {
          externalSession: {
            ...agent.surfaces.externalSession,
            externalLinkedTakeover: {
              writerSafety,
            },
          },
        },
      }).surfaces?.externalSession.externalLinkedTakeover).toEqual({
        writerSafety,
      });
    }

    for (const writerSafety of [
      'writer_qualified_detection_and_fence',
      'path_change_detection',
    ] as const) {
      expect(PluginAgentContributionV2Schema.safeParse({
        ...agent,
        surfaces: {
          externalSession: {
            ...agent.surfaces.externalSession,
            externalLinkedTakeover: {
              writerSafety,
            },
          },
        },
      }).success).toBe(false);
    }
  });

  it('accepts an auxiliary-only Agent without a fake primary runtime', () => {
    const auxiliaryOnly = {
      id: 'external-agent',
      title: 'External Agent',
      capabilities: { surfaces: ['externalSessions'] },
      surfaces: { externalSession: { sources: [source(0)] } },
    } as const;

    expect(PluginAgentContributionV2Schema.parse(auxiliaryOnly)).toEqual(auxiliaryOnly);
    expect(PluginAgentContributionV2Schema.safeParse({
      ...auxiliaryOnly,
      capabilities: { surfaces: ['terminal'] },
    }).success).toBe(false);
  });

  it('uses one Agent identity when primary runtime and External Sessions coexist', () => {
    expect(PluginAgentContributionV2Schema.safeParse(agentWithSources(1)).success).toBe(true);
    expect(PluginAgentContributionV2Schema.safeParse({
      ...agentWithSources(1),
      capabilities: {
        ...agentWithSources(1).capabilities,
        surfaces: [],
      },
    }).success).toBe(false);
  });

  it('accepts only bounded JSON-object link data', () => {
    expect(PluginAgentExternalSessionLinkDataSchema.parse({
      workspace: 'demo',
      nested: { branch: 'main', sequence: 3 },
    })).toEqual({
      workspace: 'demo',
      nested: { branch: 'main', sequence: 3 },
    });
    expect(PluginAgentExternalSessionLinkDataSchema.safeParse([]).success).toBe(false);
    expect(PluginAgentExternalSessionLinkDataSchema.safeParse({ value: undefined }).success).toBe(false);
    expect(PluginAgentExternalSessionLinkDataSchema.safeParse({
      value: 'x'.repeat(MAX_PLUGIN_AGENT_EXTERNAL_SESSION_LINK_DATA_BYTES + 1),
    }).success).toBe(false);
  });

  it('enforces inclusive linkData depth, entry, and byte limits', () => {
    expect(PluginAgentExternalSessionLinkDataSchema.safeParse(
      nestedLinkData(MAX_PLUGIN_AGENT_EXTERNAL_SESSION_LINK_DATA_DEPTH),
    ).success).toBe(true);
    expect(PluginAgentExternalSessionLinkDataSchema.safeParse(
      nestedLinkData(MAX_PLUGIN_AGENT_EXTERNAL_SESSION_LINK_DATA_DEPTH + 1),
    ).success).toBe(false);

    const atEntryLimit = Object.fromEntries(Array.from(
      { length: MAX_PLUGIN_AGENT_EXTERNAL_SESSION_LINK_DATA_ENTRIES },
      (_, index) => [`key-${index}`, index],
    ));
    const overEntryLimit = Object.fromEntries(Array.from(
      { length: MAX_PLUGIN_AGENT_EXTERNAL_SESSION_LINK_DATA_ENTRIES + 1 },
      (_, index) => [`key-${index}`, index],
    ));
    expect(PluginAgentExternalSessionLinkDataSchema.safeParse(atEntryLimit).success).toBe(true);
    expect(PluginAgentExternalSessionLinkDataSchema.safeParse(overEntryLimit).success).toBe(false);

    const emptyValueBytes = serializedUtf8Bytes({ value: '' });
    expect(PluginAgentExternalSessionLinkDataSchema.safeParse({
      value: 'x'.repeat(MAX_PLUGIN_AGENT_EXTERNAL_SESSION_LINK_DATA_BYTES - emptyValueBytes),
    }).success).toBe(true);
    expect(PluginAgentExternalSessionLinkDataSchema.safeParse({
      value: 'x'.repeat(MAX_PLUGIN_AGENT_EXTERNAL_SESSION_LINK_DATA_BYTES - emptyValueBytes + 1),
    }).success).toBe(false);
  });

  it('rejects accessors, non-JSON members, and non-ordinary arrays without invoking getters', () => {
    let getterCalls = 0;
    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, 'workspace', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'demo';
      },
    });
    expect(PluginAgentExternalSessionLinkDataSchema.safeParse(accessor).success).toBe(false);
    expect(getterCalls).toBe(0);

    const toJson = { workspace: 'demo', toJSON: () => ({ workspace: 'changed' }) };
    expect(PluginAgentExternalSessionLinkDataSchema.safeParse(toJson).success).toBe(false);

    const decoratedArray = ['demo'] as unknown[] & Record<PropertyKey, unknown>;
    decoratedArray.extra = 'not-json-array-data';
    expect(PluginAgentExternalSessionLinkDataSchema.safeParse({ values: decoratedArray }).success).toBe(false);
    const symbolArray = ['demo'] as unknown[] & Record<PropertyKey, unknown>;
    symbolArray[Symbol('hidden')] = 'hidden';
    expect(PluginAgentExternalSessionLinkDataSchema.safeParse({ values: symbolArray }).success).toBe(false);

    class ExtendedArray extends Array<unknown> {}
    expect(PluginAgentExternalSessionLinkDataSchema.safeParse({ values: new ExtendedArray('demo') }).success)
      .toBe(false);
    class NonPlainObject {
      readonly workspace = 'demo';
    }
    expect(PluginAgentExternalSessionLinkDataSchema.safeParse(new NonPlainObject()).success).toBe(false);
    const sparse = new Array<unknown>(1);
    expect(PluginAgentExternalSessionLinkDataSchema.safeParse({ values: sparse }).success).toBe(false);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(PluginAgentExternalSessionLinkDataSchema.safeParse(cycle).success).toBe(false);
    expect(PluginAgentExternalSessionLinkDataSchema.safeParse({ value: '\uD800' }).success).toBe(true);
  });

  it('caps manifest-declared transcript-bearing sources at the canonical contribution ceiling', () => {
    expect(PluginAgentContributionV2Schema.safeParse(
      agentWithSources(MAX_PLUGIN_TRANSCRIPT_SOURCES_PER_CONTRIBUTION),
    ).success).toBe(true);
    expect(PluginAgentContributionV2Schema.safeParse(
      agentWithSources(MAX_PLUGIN_TRANSCRIPT_SOURCES_PER_CONTRIBUTION + 1),
    ).success).toBe(false);
  });

  it('caps manifest-declared source instances at the same canonical ceiling', () => {
    const atLimit = PluginBackendExternalSessionSourceDeclarationV1Schema.safeParse(
      agentWithInstances(MAX_PLUGIN_TRANSCRIPT_SOURCES_PER_CONTRIBUTION)
        .surfaces.externalSession.sources[0],
    );
    const overLimit = PluginBackendExternalSessionSourceDeclarationV1Schema.safeParse(
      agentWithInstances(MAX_PLUGIN_TRANSCRIPT_SOURCES_PER_CONTRIBUTION + 1)
        .surfaces.externalSession.sources[0],
    );
    const hasInstanceArrayLimitIssue = (result: typeof atLimit): boolean => (
      !result.success && result.error.issues.some(
        (issue) => issue.code === 'too_big' && issue.path.at(-1) === 'instances',
      )
    );
    expect(hasInstanceArrayLimitIssue(atLimit)).toBe(false);
    expect(hasInstanceArrayLimitIssue(overLimit)).toBe(true);
  });
});
