import {
  PluginBackendExternalSessionSourceDeclarationV1Schema,
  ExternalSessionsSourceSchema,
  parseExternalSessionsSourceForDeclaration,
  resolveExternalSessionsSourceKeysForPersistedTagLookup,
  resolveExternalSessionsSourceKeyForDeclaration,
  type ExternalSessionsSource,
  type PluginBackendExternalSessionSourceDeclarationV1,
} from '@happier-dev/protocol';

import type { ResolvedAgentContribution } from './types';

type ExternalSessionSourceProjection = Readonly<{
  agents: readonly Pick<ResolvedAgentContribution, 'id' | 'richDefinition'>[];
}>;
type ExternalSessionSourceDeclaration = Pick<
  PluginBackendExternalSessionSourceDeclarationV1,
  'sourceKind' | 'schema' | 'key' | 'instances'
>;

export type ResolvedExternalSessionSourceProjection =
  | Readonly<{
      ok: true;
      source: ExternalSessionsSource;
      sourceKey: string;
      declaration: ExternalSessionSourceDeclaration;
    }>
  | Readonly<{
      ok: false;
      code:
        | 'agent_unavailable'
        | 'source_undeclared'
        | 'agent_source_mismatch'
        | 'source_invalid';
    }>;

export type ExternalSessionSourceKeyOwner = Readonly<{
  sourceKey: string;
  resolveSourceKey(candidate: ExternalSessionsSource): string | null;
  resolvePersistedSourceKeys(candidate: ExternalSessionsSource): readonly [string, ...string[]] | null;
}>;

export type ExternalSessionSourceConnectedServiceProfile = Readonly<{
  serviceId: string;
  profileId: string;
}>;

export type ExternalSessionSourceConnectedServiceProfileResolution =
  | Readonly<{ kind: 'not_applicable' }>
  | Readonly<{ kind: 'invalid' }>
  | Readonly<{
      kind: 'resolved';
      profile: ExternalSessionSourceConnectedServiceProfile;
    }>;

/**
 * Resolves the Connected Account profile named by a source through its
 * declaration-owned `connectedServiceProfiles` instance. Field names remain
 * plugin data; the host does not branch on an Agent id or source kind.
 */
export function resolveExternalSessionSourceConnectedServiceProfile(params: Readonly<{
  declaration: ExternalSessionSourceDeclaration;
  source: ExternalSessionsSource;
}>): ExternalSessionSourceConnectedServiceProfileResolution {
  let applicable = false;
  for (const instance of params.declaration.instances ?? []) {
    if (instance.kind !== 'connectedServiceProfiles') continue;
    if (
      Object.entries(instance.constants).some(
        ([field, expected]) => params.source[field] !== expected,
      )
    ) {
      continue;
    }
    applicable = true;
    if (params.source[instance.fields.serviceId] !== instance.serviceId) {
      continue;
    }
    const profileId = params.source[instance.fields.profileId];
    if (typeof profileId !== 'string' || profileId.trim().length === 0) {
      continue;
    }
    return Object.freeze({
      kind: 'resolved',
      profile: Object.freeze({
        serviceId: instance.serviceId,
        profileId: profileId.trim(),
      }),
    });
  }
  return Object.freeze({
    kind: applicable ? 'invalid' : 'not_applicable',
  });
}

function readSourceDeclarations(
  projection: ExternalSessionSourceProjection,
  agentId: string,
): readonly ExternalSessionSourceDeclaration[] | null {
  const contribution = projection.agents.find((candidate) => candidate.id === agentId);
  if (!contribution) return null;
  const declarations =
    contribution.richDefinition?.definition.surfaces?.externalSession.sources ?? [];
  const parsed: ExternalSessionSourceDeclaration[] = [];
  for (const declaration of declarations) {
    const result =
      PluginBackendExternalSessionSourceDeclarationV1Schema.safeParse(declaration);
    if (!result.success) return null;
    parsed.push(result.data);
  }
  return parsed;
}

export function resolveExternalSessionSourceFromAgentProjection(
  projection: ExternalSessionSourceProjection,
  agentId: string,
  source: unknown,
): ResolvedExternalSessionSourceProjection {
  const declarations = readSourceDeclarations(projection, agentId);
  if (!declarations) return { ok: false, code: 'agent_unavailable' };

  const envelope = ExternalSessionsSourceSchema.safeParse(source);
  if (!envelope.success) return { ok: false, code: 'source_invalid' };

  const declaration = declarations.find(
    (candidate) => candidate.sourceKind === envelope.data.kind,
  );
  if (!declaration) {
    const ownedByAnotherAgent = projection.agents.some(
      (candidate) => candidate.id !== agentId
        && (candidate.richDefinition?.definition.surfaces?.externalSession.sources ?? [])
          .some((candidateDeclaration) => candidateDeclaration.sourceKind === envelope.data.kind),
    );
    return {
      ok: false,
      code: ownedByAnotherAgent ? 'agent_source_mismatch' : 'source_undeclared',
    };
  }

  const parsed = parseExternalSessionsSourceForDeclaration(declaration, envelope.data);
  if (!parsed) return { ok: false, code: 'source_invalid' };
  return Object.freeze({
    ok: true,
    declaration,
    source: parsed,
    sourceKey: resolveExternalSessionsSourceKeyForDeclaration(declaration, parsed),
  });
}

export function createExternalSessionSourceKeyOwnerFromAgentProjection(
  projection: ExternalSessionSourceProjection,
  agentId: string,
  source: ExternalSessionsSource,
): ExternalSessionSourceKeyOwner | null {
  const projected = resolveExternalSessionSourceFromAgentProjection(projection, agentId, source);
  if (!projected.ok) return null;
  const declaration = projected.declaration;
  const resolveSourceKey = (candidate: ExternalSessionsSource): string | null => {
    const parsed = parseExternalSessionsSourceForDeclaration(declaration, candidate);
    return parsed
      ? resolveExternalSessionsSourceKeyForDeclaration(declaration, parsed)
      : null;
  };
  return Object.freeze({
    sourceKey: projected.sourceKey,
    resolveSourceKey,
    resolvePersistedSourceKeys: (candidate: ExternalSessionsSource): readonly [string, ...string[]] | null => {
      const sourceKey = resolveSourceKey(candidate);
      if (!sourceKey) return null;
      try {
        return resolveExternalSessionsSourceKeysForPersistedTagLookup(candidate);
      } catch {
        return [sourceKey];
      }
    },
  });
}
