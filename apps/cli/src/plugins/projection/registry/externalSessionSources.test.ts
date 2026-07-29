import { describe, expect, it } from 'vitest';

import {
  PluginBackendExternalSessionSourceDeclarationV1Schema,
  type PluginAgentContributionV2,
} from '@happier-dev/protocol';

import type { ResolvedAgentContribution } from './types';
import {
  resolveExternalSessionSourceConnectedServiceProfile,
  resolveExternalSessionSourceFromAgentProjection,
} from './externalSessionSources';

function contribution(
  id: string,
  sourceKind: string,
  identityField: string,
): ResolvedAgentContribution {
  const definition = {
    id,
    displayName: id,
    description: id,
    runtime: { kind: 'cli' },
    surfaces: {
      externalSession: {
        sources: [{
          sourceKind,
          schema: {
            fields: [
              { name: 'kind', kind: 'literal', value: sourceKind },
              { name: identityField, kind: 'string', min: 1 },
            ],
          },
          key: {
            segments: [
              { kind: 'literal', value: sourceKind },
              { kind: 'field', field: identityField },
            ],
          },
        }],
      },
    },
  } as unknown as PluginAgentContributionV2;
  return {
    id,
    provenance: 'external',
    source: { kind: 'path' },
    definition: { id, displayName: id },
    richDefinition: { provenance: 'external', definition },
  } as unknown as ResolvedAgentContribution;
}

describe('resolved Agent external-session source projection', () => {
  it('derives a connected-profile owner only through the declaring source instance', () => {
    const declaration = PluginBackendExternalSessionSourceDeclarationV1Schema.parse({
      sourceKind: 'codexHome',
      schema: {
        fields: [
          { name: 'kind', kind: 'literal', value: 'codexHome' },
          { name: 'home', kind: 'enum', values: ['user', 'connectedService'] },
          { name: 'connectedServiceId', kind: 'string', optional: true },
          { name: 'connectedServiceProfileId', kind: 'string', optional: true },
        ],
      },
      key: {
        segments: [{ kind: 'literal', value: 'codexHome' }],
      },
      instances: [
        { kind: 'default', constants: { home: 'user' } },
        {
          kind: 'connectedServiceProfiles',
          serviceId: 'openai-codex',
          constants: { home: 'connectedService' },
          fields: {
            serviceId: 'connectedServiceId',
            profileId: 'connectedServiceProfileId',
          },
        },
      ],
    });

    expect(resolveExternalSessionSourceConnectedServiceProfile({
      declaration,
      source: {
        kind: 'codexHome',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
        connectedServiceProfileId: 'work',
      },
    })).toEqual({
      kind: 'resolved',
      profile: {
        serviceId: 'openai-codex',
        profileId: 'work',
      },
    });
    expect(resolveExternalSessionSourceConnectedServiceProfile({
      declaration,
      source: {
        kind: 'codexHome',
        home: 'connectedService',
        connectedServiceId: 'different-service',
        connectedServiceProfileId: 'work',
      },
    })).toEqual({ kind: 'invalid' });
    expect(resolveExternalSessionSourceConnectedServiceProfile({
      declaration,
      source: { kind: 'codexHome', home: 'user' },
    })).toEqual({ kind: 'not_applicable' });
  });

  it('validates and keys a dynamic source through its owning resolved Agent declaration', () => {
    const registry = {
      agents: [
        contribution('external-only-agent', 'sharedLocalKind', 'scope'),
        contribution('second-agent', 'sharedLocalKind', 'workspace'),
      ],
    };

    expect(resolveExternalSessionSourceFromAgentProjection(
      registry,
      'external-only-agent',
      { kind: 'sharedLocalKind', scope: 'team:one' },
    )).toMatchObject({
      ok: true,
      source: { kind: 'sharedLocalKind', scope: 'team:one' },
      sourceKey: 'sharedLocalKind:team%3Aone',
    });
    expect(resolveExternalSessionSourceFromAgentProjection(
      registry,
      'second-agent',
      { kind: 'sharedLocalKind', workspace: '/tmp/project' },
    )).toMatchObject({
      ok: true,
      source: { kind: 'sharedLocalKind', workspace: '/tmp/project' },
      sourceKey: 'sharedLocalKind:/tmp/project',
    });
  });

  it('fails typed for uninstalled, undeclared, mismatched, and malformed sources', () => {
    const registry = {
      agents: [
        contribution('first-agent', 'firstKind', 'scope'),
        contribution('second-agent', 'secondKind', 'workspace'),
      ],
    };

    expect(resolveExternalSessionSourceFromAgentProjection(
      registry,
      'missing-agent',
      { kind: 'firstKind', scope: 'team' },
    )).toEqual({ ok: false, code: 'agent_unavailable' });
    expect(resolveExternalSessionSourceFromAgentProjection(
      registry,
      'first-agent',
      { kind: 'unknownKind', scope: 'team' },
    )).toEqual({ ok: false, code: 'source_undeclared' });
    expect(resolveExternalSessionSourceFromAgentProjection(
      registry,
      'first-agent',
      { kind: 'secondKind', workspace: '/tmp/project' },
    )).toEqual({ ok: false, code: 'agent_source_mismatch' });
    expect(resolveExternalSessionSourceFromAgentProjection(
      registry,
      'first-agent',
      { kind: 'firstKind', scope: '' },
    )).toEqual({ ok: false, code: 'source_invalid' });
  });
});
