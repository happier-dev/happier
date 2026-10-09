import { RoleArtifactV1Schema, RoleEngineV1Schema, RoleRunsAsV1Schema, type RoleArtifactV1 } from '../../prompts/roles/roleArtifactV1.js';
import { BackendTargetRefV2InputSchema, buildBackendTargetKeyV2, readBackendTargetRefV2 } from '../../backends/targets/backendTargetRefV2.js';
import { computeCanonicalDomainSeparatedHexDigest } from '../../crypto/canonicalDigest.js';

export const LEGACY_ROLE_GUIDANCE_SETTINGS_ROOTS_V1 = ['executionRunsGuidanceEntries', 'executionRunsGuidanceEnabled'] as const;

export type LegacyRoleArtifactV1 = Readonly<{ artifactId: string; role: RoleArtifactV1 }>;

export type LegacyRoleInventoryDiagnosticV1 = Readonly<{
  index?: number;
  entryId?: string;
  reason: 'invalid_root' | 'invalid_entry' | 'duplicate_id';
}>;
export type LegacyRoleInventoryV1 = Readonly<{
  status: 'ready' | 'partial';
  entries: readonly LegacyRoleArtifactV1[];
  diagnostics: readonly LegacyRoleInventoryDiagnosticV1[];
  /** Known current source identities, even when their Role payload is malformed. */
  sourceArtifactIds: readonly string[];
  sourceIdentitiesComplete: boolean;
}>;

export class LegacyRolesInventoryIncompleteError extends Error {
  readonly code = 'legacy_roles_inventory_incomplete';
  constructor(readonly inventory: LegacyRoleInventoryV1) {
    super('legacy_roles_inventory_incomplete');
    this.name = 'LegacyRolesInventoryIncompleteError';
  }
}

/** Valid neighbors remain readable, but only a complete inventory admits retention/cutover. */
export function readLegacyRoleInventoryV1(rawSettings: Readonly<Record<string, unknown>>, accountId: string): LegacyRoleInventoryV1 {
  const invalidEnabled = Object.hasOwn(rawSettings, 'executionRunsGuidanceEnabled') && typeof rawSettings.executionRunsGuidanceEnabled !== 'boolean';
  if (!Object.hasOwn(rawSettings, 'executionRunsGuidanceEntries')) {
    return invalidEnabled ? { status: 'partial', entries: [], diagnostics: [{ reason: 'invalid_root' }], sourceArtifactIds: [], sourceIdentitiesComplete: true }
      : { status: 'ready', entries: [], diagnostics: [], sourceArtifactIds: [], sourceIdentitiesComplete: true };
  }
  if (!Array.isArray(rawSettings.executionRunsGuidanceEntries)) {
    return { status: 'partial', entries: [], diagnostics: [{ reason: 'invalid_root' }], sourceArtifactIds: [], sourceIdentitiesComplete: false };
  }
  const result: LegacyRoleArtifactV1[] = [];
  const diagnostics: LegacyRoleInventoryDiagnosticV1[] = [];
  const ids = new Set<string>();
  const sourceArtifactIds = new Set<string>();
  let sourceIdentitiesUnknown = false;
  if (invalidEnabled) {
    diagnostics.push({ reason: 'invalid_root' });
  }
  for (const [index, candidate] of rawSettings.executionRunsGuidanceEntries.entries()) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      diagnostics.push({ index, reason: 'invalid_entry' });
      sourceIdentitiesUnknown = true;
      continue;
    }
    const entry: Record<string, unknown> = candidate;
    const entryId = typeof entry.id === 'string' ? entry.id : undefined;
    if (!entryId || !entryId.trim()) {
      diagnostics.push({ index, ...(entryId ? { entryId } : {}), reason: 'invalid_entry' });
      sourceIdentitiesUnknown = true;
      continue;
    }
    // UUIDv8: Account + the stable predecessor entry id, not mutable role content.
    const hex = computeCanonicalDomainSeparatedHexDigest('happier.role.v1.legacy', [accountId, entryId]);
    const artifactId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    sourceArtifactIds.add(artifactId);
    if (typeof entry.description !== 'string' || !entry.description.trim()
      || (entry.title !== undefined && typeof entry.title !== 'string')
      || (entry.enabled !== undefined && typeof entry.enabled !== 'boolean')
      || (entry.suggestedModelId !== undefined && typeof entry.suggestedModelId !== 'string')
      || (entry.suggestedIntent !== undefined && !RoleRunsAsV1Schema.safeParse({ kind: 'background_run', intent: entry.suggestedIntent }).success)
      || (entry.exampleToolCalls !== undefined && (!Array.isArray(entry.exampleToolCalls) || entry.exampleToolCalls.some((value) => typeof value !== 'string')))) {
      diagnostics.push({ index, ...(entryId ? { entryId } : {}), reason: 'invalid_entry' });
      continue;
    }
    if (ids.has(entryId)) {
      diagnostics.push({ index, entryId, reason: 'duplicate_id' });
      continue;
    }
    ids.add(entryId);
    const description = entry.description.trim();
    const name = typeof entry.title === 'string' && entry.title.trim()
      ? entry.title.trim() : description.match(/^.*?[.!?](?:\s|$)/)?.[0].trim() ?? description;
    const intent = RoleRunsAsV1Schema.safeParse({ kind: 'background_run', intent: entry.suggestedIntent });
    const target = BackendTargetRefV2InputSchema.safeParse(entry.suggestedBackendTarget);
    let engine: RoleArtifactV1['engine'];
    if (target.success) {
      try {
        const ref = typeof target.data === 'object' && target.data.kind === 'agent' && 'identity' in target.data
          ? target.data : readBackendTargetRefV2(target.data);
        const parsedEngine = RoleEngineV1Schema.safeParse({
          agentTargetKey: buildBackendTargetKeyV2(ref),
          ...(typeof entry.suggestedModelId === 'string' && entry.suggestedModelId.trim() ? { modelId: entry.suggestedModelId.trim() } : {}),
        });
        if (parsedEngine.success) engine = parsedEngine.data;
      } catch {
        // A legacy target that no longer resolves needs an explicit engine choice.
      }
    }
    const examples = Array.isArray(entry.exampleToolCalls) ? entry.exampleToolCalls.filter((value): value is string => typeof value === 'string') : [];
    const instructions = [description,
      ...(intent.success && intent.data.kind === 'background_run' ? [`Suggested intent: ${intent.data.intent}`] : []),
      ...(!engine ? ['Choose an engine before running this role.'] : []),
      ...(examples.length ? ['Examples', ...examples] : []),
    ].join('\n\n');
    result.push({ artifactId, role: RoleArtifactV1Schema.parse({
      name, instructions, ...(engine ? { engine } : {}),
      runsAs: intent.success ? intent.data : { kind: 'session' },
      workspaceWrites: 'allow', secondOpinion: 'off',
      enabled: rawSettings.executionRunsGuidanceEnabled !== false && entry.enabled !== false,
    }) });
  }
  return { status: diagnostics.length ? 'partial' : 'ready', entries: result, diagnostics,
    sourceArtifactIds: [...sourceArtifactIds], sourceIdentitiesComplete: !sourceIdentitiesUnknown };
}

/** Compatibility display projection; migration admission uses the complete inventory above. */
export function readLegacyRolesV1(rawSettings: Readonly<Record<string, unknown>>, accountId: string): readonly LegacyRoleArtifactV1[] {
  return readLegacyRoleInventoryV1(rawSettings, accountId).entries;
}

/** Retention is checked independently of overrides; their presence proves no Artifact was saved. */
export async function retainLegacyRolesV1(params: Readonly<{
  rawSettings: Readonly<Record<string, unknown>>;
  accountId: string;
  ensureRoleArtifact: (entry: LegacyRoleArtifactV1) => Promise<void>;
}>): Promise<void> {
  const inventory = readLegacyRoleInventoryV1(params.rawSettings, params.accountId);
  if (inventory.status !== 'ready') throw new LegacyRolesInventoryIncompleteError(inventory);
  for (const entry of inventory.entries) await params.ensureRoleArtifact(entry);
}
