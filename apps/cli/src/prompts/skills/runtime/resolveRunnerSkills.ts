import type { AgentSessionSkillDelivery } from '@happier-dev/plugin-sdk/agents/runtime';
import type { SessionSkillPlanV1 } from '@happier-dev/protocol/prompts/library/skills/resolveSessionSkillPlanV1';
import { PromptStackPreparationError } from '@happier-dev/protocol/prompts/library/resolvePromptStackSystemAppendBlocksV1';
import { isPluginSkillIdV1, type SkillLibraryItemV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import type { ReachContextV1 } from '@happier-dev/protocol/reach/resolveReachV1';
import type { SkillRuleV1 } from '@happier-dev/protocol/reach/reachRuleV1';
import type { StoredCredentials } from '@/persistence';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { SkillArtifactStore } from '../library/readSkillLibraryContent';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { resolveAgentSkillsCapability, resolveAgentNativeSkillDirectories } from '@/agent/skills/resolveAgentSkillsCapability';
import { readPromptLibraryCatalogRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { resolveSessionCapabilitiesV1 } from '@happier-dev/protocol/reach/resolveSessionCapabilitiesV1';
import { readSessionCapabilitySelectionFromMetadataV1 } from '@happier-dev/protocol/reach/sessionCapabilityMetadataV1';
import { resolveSkillPlanKindV1 } from '@happier-dev/protocol/prompts/library/skills/resolveSessionSkillPlanV1';
import { FIRST_PARTY_SKILLS_V1, type ReadOnlySkillV1 } from '@happier-dev/protocol/prompts/library/skills/firstPartySkillsV1';
import { prepareSessionSkillPlan } from './prepareSessionSkillPlan';
import { readAccountPluginSkills } from '../library/readAccountPluginSkills';
import { ensureSkillSessionDirHttp } from '@/daemon/controlClient';
import { SkillOwnerKeySchema, type EnsureSkillSessionDirResult } from '../store/skillStore';
import { SkillSessionStartupIdentitySchema } from '../store/controlRoutes';
import { createRealpathNormalizer, realpathReachRules } from '@/mcp/servers/createRealpathNormalizer';
import { resolveSessionProjectPromptStack } from '@/agent/prompting/coding/sessionProjectPromptStack';
import { prepareActivePromptLibraryRecord } from '@/settings/prompts/hydratePromptLibraryCatalog';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { runWithServerHttpBaseUrl, resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveFirstPartySkillFeatures } from './resolveFirstPartySkillFeatures';
import type { FeatureId } from '@happier-dev/protocol/features/catalog';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { projectPromptBundleActionEntriesV1 } from '@happier-dev/protocol/prompts/library/promptBundleSchemas';
import { prepareSessionStackSkillMigration } from '@/agent/runtime/startupMetadataUpdate';
import { resolveSessionStackSkillSelectionForMigration } from '@/agent/runtime/mergeSessionMetadataForStartup';
import { traceSkillPreparationPhase } from './traceSkillPreparationPhase';

export type ResolveRunnerSkillsInput = Readonly<{
  ownerKey: string; agentId: string; machineId: string; directory: string;
  sessionMetadata: unknown; credentials: StoredCredentials | null;
  accountSnapshot: ActiveAccountSettingsSnapshot | null;
  contributes?: Parameters<typeof resolveAgentSkillsCapability>[1];
  pluginSkills?: readonly ReadOnlySkillV1[];
  agentHasActionChannel: boolean;
  reachContext?: ReachContextV1;
  home?: string;
  lifecycle?: 'start' | 'reapply';
  isCurrent?: () => boolean | Promise<boolean>;
  operationContext?: SavedSecretOperationContextV1;
}>;
export type RunnerSkillsResult = Readonly<{
  reach?: Readonly<{ context: ReachContextV1; rules: readonly SkillRuleV1[];
    featureEnabled?: Readonly<Partial<Record<FeatureId, boolean>>>;
    catalog?: Readonly<{ revision: number | 'absent'; authority: 'active' | 'inactive' }> }>;
  delivery?: AgentSessionSkillDelivery; plan: SessionSkillPlanV1;
  indexItems: readonly SkillLibraryItemV1[]; unavailable?: true;
  unavailableReason?: string;
  failureDetails?: readonly Readonly<{ skillId: string; detail: string }>[];
}>;
export type RunnerSkillsTransports = Readonly<{
  artifacts?: SkillArtifactStore;
  ensureSessionDir?: (input: Readonly<{
    materialization?: 'copy';
    ownerKey: string; items: readonly Readonly<{ skillId: string; name: string; sourceFolderName?: string; digest: string; files: import('@happier-dev/protocol/prompts/library/promptBundleSchemas').PromptBundleEntryV1[] }>[];
    nativeDisables: readonly Readonly<{ name: string; path: string }>[];
  }>) => Promise<EnsureSkillSessionDirResult>;
}>;

/** Preserve the captured Account authority across asynchronous resolution and native acknowledgement. */
export function createRunnerSkillsCurrentnessCheck(input: ResolveRunnerSkillsInput): () => Promise<void> {
  const lifetime = getActiveAccountSettingsSnapshotLifetimeToken();
  const scopeKey = input.accountSnapshot?.scopeKey;
  return async () => {
    if (input.isCurrent && !await input.isCurrent()) throw new Error('scope-retired');
    if (input.operationContext && (input.operationContext.credentials.token !== input.credentials?.token
      || !await input.operationContext.isCurrent())) throw new Error('scope-retired');
    if (scopeKey && (!input.credentials || resolveAccountSettingsScopeKey(input.credentials) !== scopeKey)) throw new Error('scope-retired');
    if (scopeKey && !input.operationContext && !input.isCurrent && (getActiveAccountSettingsSnapshot()?.scopeKey !== scopeKey
      || getActiveAccountSettingsSnapshotLifetimeToken() !== lifetime)) throw new Error('scope-retired');
  };
}

export async function resolveRunnerSkills(input: ResolveRunnerSkillsInput, transports: RunnerSkillsTransports = {}): Promise<RunnerSkillsResult> {
  return input.operationContext
    ? runWithServerHttpBaseUrl(input.operationContext.serverHttpBaseUrl, () => resolveRunnerSkillsForHome(input, transports))
    : resolveRunnerSkillsForHome(input, transports);
}

async function resolveRunnerSkillsForHome(input: ResolveRunnerSkillsInput, transports: RunnerSkillsTransports): Promise<RunnerSkillsResult> {
  const credentials = input.credentials;
  if (!credentials) return { plan: { plan: 'none', items: [], nativeDisables: [], diagnostics: [] }, indexItems: [] };
  const agentSkills = resolveAgentSkillsCapability(input.agentId, input.contributes);
  const kind = resolveSkillPlanKindV1({ agentSkills, agentHasActionChannel: input.agentHasActionChannel });
  const emptyPlan: SessionSkillPlanV1 = { plan: kind, items: [], nativeDisables: [], diagnostics: [] };
  if (kind === 'none') return { plan: emptyPlan, indexItems: [] };
  const lifetime = getActiveAccountSettingsSnapshotLifetimeToken();
  const scopeKey = input.accountSnapshot?.scopeKey;
  const current = createRunnerSkillsCurrentnessCheck(input);
  let unavailableReason = 'project_context_unavailable';
  let reach: RunnerSkillsResult['reach'];
  try {
    await current();
    let snapshot = input.accountSnapshot;
    // Project legacy context is a current producer of rules, including for a first Session with no Project rule yet.
    // Keep identity, shared/personal context and the migration receipt on that single preparation path.
    const project = await traceSkillPreparationPhase('project_context', () => resolveSessionProjectPromptStack({ credentials, metadata: input.sessionMetadata,
      machineId: input.machineId, directory: input.directory, operationContext: input.operationContext }));
    await current();
    if (project.skillMigration.status !== 'ready') return { plan: emptyPlan, indexItems: [], unavailable: true,
      unavailableReason: 'project_skill_migration_unavailable' };
    if (project.projectKey !== null) snapshot = input.operationContext
      ? input.operationContext.readSnapshot() : getActiveAccountSettingsSnapshot();
    // A Session's own Account wakes can start hydration before skills admission.
    // Loading is outstanding demand, not a completed unavailable rules read.
    if ((!snapshot?.promptLibraryCatalog || snapshot.promptLibraryCatalog.status === 'loading') && scopeKey) {
      unavailableReason = 'skill_rules_unavailable';
      await traceSkillPreparationPhase('skill_rules', () => prepareActivePromptLibraryRecord({ credentials, key: 'skill-rules', scopeKey,
        lifetimeToken: lifetime, ...(input.operationContext ? { operationContext: input.operationContext } : {}) }));
      await current(); snapshot = input.operationContext ? input.operationContext.readSnapshot() : getActiveAccountSettingsSnapshot();
    }
    if (!snapshot?.promptLibraryCatalog) return { plan: emptyPlan, indexItems: [], unavailable: true, unavailableReason: 'catalog-unobserved' };
    const rulesRead = readPromptLibraryCatalogRecordV1({ catalog: snapshot.promptLibraryCatalog, key: 'skill-rules',
      rawSettings: snapshot.source === 'none' ? undefined : snapshot.rawSettings });
    if (rulesRead.status !== 'ready' || rulesRead.record.key !== 'skill-rules') return { plan: emptyPlan, indexItems: [], unavailable: true,
      unavailableReason: rulesRead.status === 'unavailable' ? rulesRead.reason : 'invalid-stored-content' };
    const rules = rulesRead.record.value.rules;
    unavailableReason = 'session_skill_selection_unavailable';
    const retained = await traceSkillPreparationPhase('session_selection', () => prepareSessionStackSkillMigration(input.sessionMetadata, { credentials,
      accountSnapshot: snapshot, operationContext: input.operationContext, projectEntries: project.entries }));
    await current();
    if (retained.status !== 'ready') return { plan: emptyPlan, indexItems: [], unavailable: true, unavailableReason };
    let selection = readSessionCapabilitySelectionFromMetadataV1(input.sessionMetadata);
    if (retained.migration) {
      const migrated = resolveSessionStackSkillSelectionForMigration(input.sessionMetadata, retained.migration);
      if (migrated.status === 'unavailable') return { plan: emptyPlan, indexItems: [], unavailable: true, unavailableReason };
      if (migrated.status === 'updated') selection = { ...selection, skills: migrated.selection };
    }
    const artifacts = transports.artifacts ?? createCredentialedAccountArtifactStore(credentials);
    const normalizePath = createRealpathNormalizer();
    let context: ReachContextV1 = input.reachContext ?? {
      machineId: input.machineId, machinePlatform: process.platform === 'win32' ? 'win32' : 'posix',
      directory: normalizePath(input.directory), projectKey: null, agentId: input.agentId,
    };
    if (!input.reachContext) context = { ...context, projectKey: project.projectKey };
    const normalizedRules = realpathReachRules(rules, normalizePath);
    // Reach and Session overrides name every possible delivery candidate.
    // Full Account inventory belongs to library/preview reads, not launch.
    const candidates = [...new Set([...rules.map(rule => rule.skillId),
      ...(selection.skills?.forceIncludeSkillIds ?? []), ...(selection.skills?.forceExcludeSkillIds ?? []),
      ...FIRST_PARTY_SKILLS_V1.map(skill => skill.skillId)])];
    const featureEnabled = await resolveFirstPartySkillFeatures({ serverUrl: resolveServerHttpBaseUrl(),
      env: process.env, settings: snapshot.settings });
    await current();
    const selected = resolveSessionCapabilitiesV1({ context, mcp: null,
      isFeatureEnabled: featureId => featureEnabled[featureId] === true,
      skills: { items: candidates.map(skillId => ({ skillId, name: skillId })), rules: normalizedRules },
      selection, agentAcceptsUserMcp: false }).skills;
    const requiredPluginIds = selected.items.filter(item => item.selected && isPluginSkillIdV1(item.id)).map(item => item.id);
    const settings = snapshot.settings;
    const pluginSkills = input.pluginSkills?.filter(skill => requiredPluginIds.includes(skill.skillId)) ?? await traceSkillPreparationPhase('plugin_content', () => readAccountPluginSkills({ credentials,
      settings, skillIds: requiredPluginIds, serverHttpBaseUrl: input.operationContext?.serverHttpBaseUrl,
      isCurrent: async () => { await current(); return true; } }));
    await current();
    reach = { context, rules, featureEnabled, catalog: { revision: rulesRead.revision, authority: rulesRead.authority } };
    unavailableReason = 'skill_plan_unavailable';
    const additionalProjectDirectories = await resolveAgentNativeSkillDirectories(input.agentId, {
      catalog: input.contributes, sessionMetadata: input.sessionMetadata,
    });
    await current();
    const { plan, contents, nativeSkills } = await traceSkillPreparationPhase('plan', () => prepareSessionSkillPlan({ artifacts, selected, agentSkills, pluginSkills,
      purpose: input.lifecycle ?? 'start', agentHasActionChannel: input.agentHasActionChannel, directory: input.directory,
      additionalProjectDirectories, home: input.home, assertCurrent: current }));
    if (nativeSkills === null) return { reach, plan, indexItems: [] };
    // Startup can deliver readable items, but a failed live read cannot withdraw the retained folder's content.
    if (input.lifecycle === 'reapply' && plan.items.some(item => item.reason === 'content_unreadable')) {
      return { reach, plan, indexItems: [], unavailable: true, unavailableReason: 'content_unreadable' };
    }
    const delivered = () => plan.items.filter(item => item.state === 'delivered');
    if (plan.plan === 'index') return { reach, plan, indexItems: delivered().flatMap(item => contents.has(item.skillId) ? [contents.get(item.skillId)!.item] : []) };
    // Unknown native state cannot change a retained folder, including on a later live reapply.
    if (nativeSkills.status === 'failed') return { reach, plan, indexItems: [], unavailable: true, unavailableReason: 'native_scan_failed' };
    const nativeDisables = plan.nativeDisables.filter(item => item.state === 'applied').map(({ name, path }) => ({ name, path }));
    try {
      const result = await traceSkillPreparationPhase('materialization', () => (transports.ensureSessionDir ?? (content => {
        const isRun = SkillOwnerKeySchema.parse(content.ownerKey).includes('/');
        const metadata = input.sessionMetadata;
        const identity = SkillSessionStartupIdentitySchema.safeParse({
          pid: isRun ? (metadata && typeof metadata === 'object' ? Reflect.get(metadata, 'hostPid') : undefined) : process.pid,
          metadata,
        });
        if (!identity.success) throw Object.assign(new Error('Skill parent identity is unavailable'), { code: 'skills_unavailable' });
        return ensureSkillSessionDirHttp(content, {}, identity.data);
      }))({ ownerKey: input.ownerKey,
        ...(agentSkills.materialization ? { materialization: agentSkills.materialization } : {}),
        items: delivered().map(item => ({ skillId: item.skillId, name: item.name, digest: item.digest,
          ...(contents.get(item.skillId)!.item.sourceFolderName ? { sourceFolderName: contents.get(item.skillId)!.item.sourceFolderName } : {}),
          files: projectPromptBundleActionEntriesV1(contents.get(item.skillId)!.body.entries) })), nativeDisables }));
      await current();
      const failures = new Set(result.failed.map(item => item.skillId));
      for (const item of plan.items) if (failures.has(item.skillId)) { item.state = 'unavailable'; item.reason = 'materialize_failed'; }
      return { reach, plan, indexItems: [], failureDetails: result.failed.flatMap(item => item.detail ? [{ skillId: item.skillId, detail: item.detail }] : []),
        delivery: { pluginRoot: result.pluginRoot, skillsRoot: result.skillsRoot,
        items: result.items, nativeDisables } };
    } catch (error) {
      const code: unknown = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
      const failureDetails = typeof code === 'string' ? delivered().map(item => ({ skillId: item.skillId, detail: code })) : undefined;
      for (const item of plan.items) if (item.state === 'delivered') { item.state = 'unavailable'; item.reason = 'materialize_failed'; }
      return { reach, plan, indexItems: [], unavailable: true, unavailableReason: 'materialize_failed', ...(failureDetails ? { failureDetails } : {}) };
    }
  } catch (error) {
    // Required Project context shares prompt preparation's failure and recovery
    // owner; an unavailable optional skill plan cannot replace that disposition.
    if (error instanceof PromptStackPreparationError) throw error;
    return { ...(reach ? { reach } : {}), plan: emptyPlan, indexItems: [], unavailable: true,
      unavailableReason: error instanceof Error && error.message === 'scope-retired' ? 'scope-retired' : unavailableReason };
  }
}
