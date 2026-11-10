import { z } from '../../zodRuntimePolicy.js';

import { listSavedSecretReferenceCarrierPathsV1, parseSavedSecretRefV1 } from '../../account/settings/savedSecretReferenceV1.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { PluginAgentAcpStderrRulesV2Schema, type PluginAgentAcpStderrRulesV2 } from '../../plugins/contributions/agentAcpStderrRules.js';
import type { PluginContributionIdentityV1 } from '../../plugins/contributionIdentity.js';
import { AcpBackendAuthConfigV1Schema, AcpBackendDefinitionV1Schema, foldStoredAcpBackendLaunchV1, type AcpBackendDefinitionV1 } from './settingsV1.js';
import { AcpCatalogRecordV1Schema, listAcpCatalogSavedSecretRefsV1, type AcpCatalogDiagnosticV1, type AcpCatalogRecordV1 } from './catalogRowsV1.js';

// Observed predecessor 37a6541578749067b49d4579be8c752c9591b8c8. These selectors
// are read only at this ingress; current runtime authority is declarative rules.
const predecessorDefinition = (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform(foldStoredAcpBackendLaunchV1), createStoredReadSchema(lazyZodSchema(() => z.extend(AcpBackendDefinitionV1Schema, {
  auth: z.optional(z.extend(AcpBackendAuthConfigV1Schema, {
    statusCommand: z.optional(z.array(z.string())),
    parser: z.optional(z.enum(['unknown', 'exitCodeOnly', 'stdoutNonEmpty', 'kiroWhoamiJson'])),
  })),
  transportProfile: z._default(z.enum(['generic', 'kiro']), 'generic'),
}))));
const predecessorInventory = createStoredReadSchema(lazyZodSchema(() => z.object({
  v: z.literal(2), backends: z.array(z.unknown()),
})));

export type AcpCatalogTransferV2Result = Readonly<{ status: 'ready'; record: AcpCatalogRecordV1; sourceSettingsVersion: number }>
  | Readonly<{ status: 'partial'; record: AcpCatalogRecordV1; sourceSettingsVersion: number; reason: 'incomplete-inventory'; diagnostics: readonly AcpCatalogDiagnosticV1[] }>
  | Readonly<{ status: 'not-required' }>
  | Readonly<{ status: 'unavailable'; reason: 'invalid-stored-content' | 'unsupported-source-version' | 'saved-secret-unavailable' | 'transport-contribution-unavailable' }>;

export type AcpCatalogTransferSourceDefinitionV2 = z.infer<typeof predecessorDefinition>;
type AcpCatalogTransferSourceInventoryV2 = Readonly<{
  sourceSettingsVersion: number;
  definitions: readonly AcpCatalogTransferSourceDefinitionV2[];
  references: readonly Readonly<{ path: string; secretId: string }>[];
}>;
export type AcpCatalogTransferSourceV2Result = (AcpCatalogTransferSourceInventoryV2 & Readonly<{ status: 'ready' }>)
  | (AcpCatalogTransferSourceInventoryV2 & Readonly<{ status: 'partial'; reason: 'incomplete-inventory'; diagnostics: readonly AcpCatalogDiagnosticV1[] }>)
  | Readonly<{ status: 'not-required' }>
  | Readonly<{ status: 'unavailable'; reason: 'invalid-stored-content' | 'unsupported-source-version' | 'saved-secret-unavailable' }>;

/** Cold admitted facts consumed by retained transport-profile translation, never activation authority. */
export type AcpCatalogTransferAgentDeclarationV2 = Readonly<{
  identity: PluginContributionIdentityV1;
  acpStderrRules?: PluginAgentAcpStderrRulesV2 | null;
}>;

/** Original source inventory for the Secret owner, not executable catalog authority or a promotion. */
export function readAcpCatalogTransferSourceV2(input: Readonly<{
  rawSettings: unknown; sourceSettingsVersion: number;
}>): AcpCatalogTransferSourceV2Result {
  if (!input.rawSettings || typeof input.rawSettings !== 'object' || Array.isArray(input.rawSettings)) {
    return { status: 'unavailable', reason: 'invalid-stored-content' };
  }
  if (!Object.hasOwn(input.rawSettings, 'acpCatalogSettingsV1')) return { status: 'not-required' };
  const raw = Reflect.get(input.rawSettings, 'acpCatalogSettingsV1');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { status: 'unavailable', reason: 'invalid-stored-content' };
  const version: unknown = Reflect.get(raw, 'v');
  if (version !== undefined && version !== 2) return { status: 'unavailable', reason: 'unsupported-source-version' };
  const inventory = predecessorInventory.safeParse(raw);
  if (!inventory.success) return { status: 'unavailable', reason: 'invalid-stored-content' };

  const diagnostics: AcpCatalogDiagnosticV1[] = [];
  const definitions = inventory.data.backends.flatMap((candidate, index) => {
    const parsed = predecessorDefinition.safeParse(candidate);
    if (parsed.success) return [{ index, definition: parsed.data }];
    diagnostics.push({ path: `backends[${index}]`, reason: 'invalid_definition' });
    return [];
  });
  const admittedPaths = new Set(definitions.flatMap(({ index, definition }) =>
    listAcpCatalogSavedSecretRefsV1({ v: 1, definitions: [definition] }).map(reference =>
      reference.path.replace(/^definitions\[0\]/u, `backends[${index}]`))));
  const unclassifiedPaths = listSavedSecretReferenceCarrierPathsV1(raw).filter(path => !admittedPaths.has(path));
  diagnostics.push(...unclassifiedPaths.map(path => ({ path, reason: 'unclassified_reference' as const })));

  const idCounts = new Map<string, number>();
  const nameCounts = new Map<string, number>();
  for (const { definition } of definitions) {
    idCounts.set(definition.id, (idCounts.get(definition.id) ?? 0) + 1);
    nameCounts.set(definition.name, (nameCounts.get(definition.name) ?? 0) + 1);
  }
  const safeDefinitions = definitions.filter(({ index, definition }) => {
    const path = `backends[${index}]`;
    if ((idCounts.get(definition.id) ?? 0) > 1 || (nameCounts.get(definition.name) ?? 0) > 1) {
      diagnostics.push({ path, reason: 'invalid_definition' });
      return false;
    }
    return !unclassifiedPaths.some(reference => reference === path || reference.startsWith(`${path}.`) || reference.startsWith(`${path}[`));
  });
  const references: { path: string; secretId: string }[] = [];
  for (const { index, definition } of safeDefinitions) {
    for (const reference of listAcpCatalogSavedSecretRefsV1({ v: 1, definitions: [definition] })) {
      try {
        if (parseSavedSecretRefV1(reference.secretId).kind === 'personal') {
          references.push({ ...reference, path: reference.path.replace(/^definitions\[0\]/u, `backends[${index}]`) });
        }
      } catch { return { status: 'unavailable', reason: 'saved-secret-unavailable' }; }
    }
  }
  const inventoryResult = { sourceSettingsVersion: input.sourceSettingsVersion,
    definitions: safeDefinitions.map(({ definition }) => definition), references };
  return diagnostics.length > 0 ? { status: 'partial', reason: 'incomplete-inventory', ...inventoryResult, diagnostics }
    : { status: 'ready', ...inventoryResult };
}

/** Read-only projection. Only complete ready results may transfer authority; mappings come from the Secret owner. */
export function prepareAcpCatalogTransferV2(input: Readonly<{
  rawSettings: unknown; sourceSettingsVersion: number; savedSecretRefs?: ReadonlyMap<string, string>;
  agentDeclarations?: readonly AcpCatalogTransferAgentDeclarationV2[];
}>): AcpCatalogTransferV2Result {
  const source = readAcpCatalogTransferSourceV2(input);
  if (source.status !== 'ready' && source.status !== 'partial') return source;
  const transferred: AcpBackendDefinitionV1[] = [];
  for (const definition of source.definitions) {
    const { transportProfile, auth, ...current } = definition;
    const env: AcpBackendDefinitionV1['env'] = {};
    for (const [name, value] of Object.entries(definition.env)) {
      if (value.t !== 'savedSecret') { env[name] = value; continue; }
      try {
        const ref = parseSavedSecretRefV1(value.secretId);
        const secretId = ref.kind === 'shared_resource' ? value.secretId : input.savedSecretRefs?.get(value.secretId);
        if (!secretId || parseSavedSecretRefV1(secretId).kind !== 'shared_resource') {
          return { status: 'unavailable', reason: 'saved-secret-unavailable' };
        }
        env[name] = { t: 'savedSecret', secretId };
      } catch { return { status: 'unavailable', reason: 'saved-secret-unavailable' }; }
    }
    let runtime = current.runtime;
    if (transportProfile === 'kiro') {
      const declaration = input.agentDeclarations?.find(candidate =>
        candidate.identity.pluginId === 'happier.agent.kiro' && candidate.identity.localId === 'kiro');
      const rules = PluginAgentAcpStderrRulesV2Schema.safeParse(declaration?.acpStderrRules);
      if (!rules.success) return { status: 'unavailable', reason: 'transport-contribution-unavailable' };
      runtime = { ...runtime, stderrRules: rules.data };
    }
    let currentAuth: AcpBackendDefinitionV1['auth'];
    let compatibility = current.compatibility;
    if (auth) {
      const { statusCommand, parser, ...retainedAuth } = auth;
      currentAuth = retainedAuth;
      if (statusCommand !== undefined || parser !== undefined) compatibility = {
        source: 'acp-catalog-v2', authStatus: { ...(statusCommand !== undefined ? { statusCommand } : {}), ...(parser !== undefined ? { parser } : {}) },
      };
    }
    transferred.push({ ...current, env, ...(currentAuth ? { auth: currentAuth } : {}),
      ...(runtime ? { runtime } : {}), ...(compatibility ? { compatibility } : {}),
    });
  }
  const record = AcpCatalogRecordV1Schema.safeParse({ v: 1, definitions: transferred });
  if (!record.success) return { status: 'unavailable', reason: 'invalid-stored-content' };
  return source.status === 'partial' ? { status: 'partial', reason: 'incomplete-inventory', record: record.data,
    sourceSettingsVersion: source.sourceSettingsVersion, diagnostics: source.diagnostics }
    : { status: 'ready', sourceSettingsVersion: input.sourceSettingsVersion, record: record.data };
}
