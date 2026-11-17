import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '../../actions/actionExecutor.js';
import { createActionExecuteFailureError } from '../../actions/actionExecutionResult.js';
import { createBotTemplateActionExecuteV1, type BotTemplateOperationPortV1 } from './botTemplateOperations.js';
import { type BotTemplateReleaseV1, projectBotTemplateArtifactHeaderV1, readBotTemplateReleaseV1 } from './botTemplateV1.js';
import { type BotTemplateInstanceV1 } from './templateInstanceV1.js';
import { createPromptDocInLibrary, readPromptDocInLibrary, updatePromptDocInLibrary, type PromptLibraryArtifactStore,
  type PromptLibraryStoredArtifact } from '../../prompts/library/promptLibraryActionOperations.js';
import { createWorkBoardArtifactBoundary } from '../../boards/workBoardArtifactV1.testkit.js';
import { BotTemplateUpdateFailureDetailsV1Schema, readBotTemplateUpdateOfferV1 } from './templateUpdateActionsV1.js';
import { computeActionInputApprovalDigestV1 } from '../../actions/decisionAuthority.js';
import { skillFileFromBytesV1 } from '../../prompts/library/skills/skillZipV1.js';
import type { ActionExecutorContext, ActionExecutorDeps } from '../../actions/executor/types.js';
import { API_TOKEN_FULL_GRANT_V1 } from '../../auth/apiTokenGrant.js';
import { readBuiltInLegacyConnectedAccountServiceKeyIngress } from '../../connect/connectedServiceBindings.js';
import { ActionsSettingsV1Schema } from '../../actions/actionSettings.js';
import { createMcpServerActionExecuteV1 } from '../../mcp/servers/serverActionsV1.js';
import { commitMcpServerCatalogMutationV1, loadMcpServerCatalogV1 } from '../../mcp/servers/serverCatalogV1.js';
import type { McpServerCatalogV1 } from '../../mcp/servers/serverRowsV1.js';
import { setSessionCapabilityV1, type SessionCapabilitiesActionPortV1 } from '../../actions/executor/sessionCapabilities.js';
import { readSessionCapabilitySelectionFromMetadataV1 } from '../../reach/sessionCapabilityMetadataV1.js';
import { readSessionCapabilityOverrideV1 } from '../../reach/sessionCapabilitySelectionV1.js';
import { createSkillActionExecuteV1 } from '../../prompts/library/skills/skillActionOperations.js';
import type { SkillRulesActionPortV1 } from '../../prompts/library/skillRulesActionsV1.js';
import { SKILL_ACTION_OUTPUT_SCHEMAS_V1 } from '../../prompts/library/skills/skillActionSchemasV1.js';
import type { SessionBotFaceV1 } from '../../sessions/identity/sessionBotFaceV1.js';
import { executeActionOperationActionV1 } from '../../actions/executor/actionOperationActions.js';
import { ActionOperationGetV1ResponseSchema, type ActionOperationSnapshotV1 } from '../../actions/operations/v1.js';

const sourceId = '80f7dabe-1f05-44b7-8e44-d98f2127f523';
const baseId = '70f7dabe-1f05-44b7-8e44-d98f2127f523';
const ref = { serverId: 'home', sessionId: 'recipient-bot' };
const base: BotTemplateReleaseV1 = { v: 1, version: '1.0.0', changelog: '', releasedAtMs: 1,
  content: { v: 1, identity: { name: 'Helper', description: '' }, instructions: { markdown: 'one\ntwo\nthree\n' },
    memoryRules: [{ key: 'learn', text: 'original rule' }], skills: [], needs: { software: [], connectedAccounts: [], mcpServers: [] } } };
const upstream: BotTemplateReleaseV1 = { ...base, version: '1.1.0', content: { ...base.content,
  instructions: { markdown: 'author\ntwo\nnew three\n' }, memoryRules: [] } };

async function fixture(options: Pick<ActionExecutorDeps, 'machineSetupPlan' | 'machineSetupApply' | 'actionOperationAction'> = {},
  pluginRelease?: BotTemplateOperationPortV1['resolvePluginRelease'], executionContext: Partial<ActionExecutorContext> = {}) {
  const boundary = createWorkBoardArtifactBoundary();
  for (const [artifactId, release] of [[sourceId, upstream], [baseId, base]] as const) {
    const envelope = { v: 1 as const, state: 'released' as const, release };
    boundary.rows.set(artifactId, { artifactId, header: projectBotTemplateArtifactHeaderV1(envelope), body: JSON.stringify(envelope),
      revision: { headerVersion: 1, bodyVersion: 1 }, access: 'owner', shared: false });
  }
  const docs = new Map<string, PromptLibraryStoredArtifact>();
  const writes: string[] = [];
  const contentReads: string[] = [];
  const store: PromptLibraryArtifactStore = {
    read: async id => { contentReads.push(id); return docs.get(id) ?? null; },
    create: async input => { const artifactId = `doc-${docs.size}`; const revision = { headerVersion: 1, bodyVersion: 1 };
      docs.set(artifactId, { id: artifactId, ...input, revision, owned: true, access: 'owner' }); return { artifactId, revision }; },
    update: async input => {
      const previous = docs.get(input.artifactId)!;
      if (JSON.stringify(previous.revision) !== JSON.stringify(input.expectedRevision)) throw Object.assign(new Error('revision_conflict'), { code: 'revision_conflict' });
      const revision = { headerVersion: previous.revision.headerVersion + 1, bodyVersion: previous.revision.bodyVersion + 1 };
      docs.set(input.artifactId, { ...previous, ...input, revision }); writes.push(input.artifactId); return { revision };
    },
  };
  const doc = await createPromptDocInLibrary({ store, request: { title: 'Local instructions', markdown: 'mine\ntwo\nthree\n' } });
  const memory = await createPromptDocInLibrary({ store, request: { title: 'Learned memory', markdown: 'learned private fact' } });
  let instance: BotTemplateInstanceV1 = { v: 1, source: pluginRelease
    ? { kind: 'plugin', registryItem: { sourceId: 'templates', itemId: '@acme/helper', version: '1.0.0' }, contributionId: 'helper' }
    : { kind: 'artifact', serverId: 'home', artifactId: sourceId }, acceptedVersion: '1.0.0',
    acceptedBase: { serverId: 'home', artifactId: baseId }, skillIds: {}, mcpServerIds: {}, follow: true };
  let revision = 4;
  let instanceWrites = 0;
  let sourceReads = 0;
  let failSettlement = false;
  let refuseReport = false;
  let failCapability: boolean | 'refused' = false;
  let failFace = false;
  let title = 'My helper';
  let face: SessionBotFaceV1 | null = { style: 'pixel', body: 'cat', seed: 'mine' };
  let capabilityMetadata: object = {};
  let catalog: McpServerCatalogV1 = { v: 1, servers: [], bindings: [] };
  let catalogRevision = 0;
  const reports: { acceptedVersion: string; copyId: string }[] = [];
  const accountWrites: Parameters<NonNullable<ActionExecutorDeps['sessionConnectedServicesAuthSet']>>[0][] = [];
  const incumbentService = readBuiltInLegacyConnectedAccountServiceKeyIngress('anthropic')!;
  const metadata = () => ({ ...capabilityMetadata, connectedServices: { v: 2, bindingsByServiceId: {
    [incumbentService]: { source: 'connected', selection: 'profile', profileId: 'incumbent' } } },
    work: { templateInstance: instance, promptStack: [{ id: 'session.instructions',
    ref: { kind: 'doc', serverId: 'home', artifactId: doc.artifactId }, enabled: true, placement: 'system_append' }] } });
  const capabilities: SessionCapabilitiesActionPortV1 = {
    readSession: async () => ({ metadata: metadata(), sessionRunning: false,
      agent: { vendorResume: 'supported', skillsLiveReload: 'supported' }, launchRestart: 'automatic' }),
    resolveItem: async ({ id }) => id,
    writeMetadata: async ({ update }) => {
      if (failCapability === 'refused') return 'conflict';
      if (failCapability) throw Object.assign(new Error('session_metadata_unavailable'), { code: 'session_metadata_unavailable' });
      capabilityMetadata = update(metadata()); revision++; return 'updated';
    },
  };
  const skillRules: SkillRulesActionPortV1 = { serverId: 'home', assertCurrent: () => {},
    ruleWriteContext: () => ({ nowMs: 1, newId: () => 'rule' }), listSkills: async () => [],
    readCatalog: async () => ({ catalog: { status: 'ready', rows: [{ record: { key: 'skill-rules', value: { v: 1, rules: [] } }, revision: 1 }], tombstones: [], diagnostics: [] } }),
    writeRecord: async () => { throw new Error('Template update skills never acquire global reach'); },
  };
  const skillAction: NonNullable<ActionExecutorDeps['skillActionExecute']> = ({ actionId, input, context }) => createSkillActionExecuteV1({
    store, skillRules, randomId: () => 'skill-rule',
    includeInSession: (sessionId, id) => setSessionCapabilityV1({ port: capabilities,
      request: { sessionId, kind: 'skill', id, state: 'on' }, context }),
  })(actionId, input, { surface: context.surface ?? null, invocationServices: context.invocationServices }, context.signal);
  const port: BotTemplateOperationPortV1 = { artifacts: { ...boundary.forAccount('recipient'), delete: boundary.transport.delete, read: async (id, options) => {
    sourceReads++; return boundary.forAccount('recipient').read(id, options);
  } }, randomId: () => '60f7dabe-1f05-44b7-8e44-d98f2127f523',
    readSourceDraftRef: async () => null, writeSourceDraftRef: async () => {}, grant: async () => {},
    ...(pluginRelease ? { resolvePluginRelease: pluginRelease } : {}),
    recipient: { readSession: async () => ({ metadata: metadata(), revision,
      executionTarget: { machineId: 'recipient-machine', agentId: 'codex' } }), writeInstance: async () => { throw new Error('birth only'); },
      updateInstance: async (_ref, next, expected) => {
        if (failSettlement) throw createActionExecuteFailureError({ ok: false, errorCode: 'session_metadata_unavailable', error: 'session_metadata_unavailable' });
        expect(instance).toEqual(expected); instance = next; instanceWrites++; revision++;
      }, reportAcceptedVersion: async input => { reports.push(input); if (refuseReport) throw new Error('offline'); },
      content: { promptDocGet: input => readPromptDocInLibrary({ store, ...input }), skillActionExecute: skillAction } },
  };
  const execute = createBotTemplateActionExecuteV1(port);
  const executor = createActionExecutor({ botTemplateAction: execute,
    skillActionExecute: skillAction, sessionCapabilities: capabilities,
    mcpServerAction: createMcpServerActionExecuteV1({
      readCatalog: () => loadMcpServerCatalogV1({ mode: 'plain', material: null,
        readRow: async () => ({ status: 'present', revision: catalogRevision, content: { t: 'plain', v: catalog } }) }),
      mutate: (change, expectedRevision) => commitMcpServerCatalogMutationV1({ catalog, revision: catalogRevision, change, scope: null,
        writeCatalog: async candidate => {
          if (candidate.expectedRevision !== catalogRevision || expectedRevision !== catalogRevision) return { status: 'conflict', revision: catalogRevision };
          catalog = candidate.catalog; return { status: 'updated', revision: ++catalogRevision, cursor: catalogRevision };
        } }),
      machine: async () => { throw new Error('Template MCP updates never start code'); },
    }),
    prepareBotTemplateUpdate: request => execute.prepareUpdate(request),
    promptDocUpdate: input => updatePromptDocInLibrary({ store, request: input }),
    // These are the native transport boundaries; the Action preparation and child dispatcher stay real.
    sessionStateFieldSet: async request => {
      if (request.fieldId === 'display.title') title = request.value;
      else if (request.fieldId === 'display.botFace') {
        if (failFace) return { ok: false, errorCode: 'session_metadata_unavailable', error: 'session_metadata_unavailable' };
        face = request.value;
      } else throw new Error(`Unexpected Session field: ${request.fieldId}`);
      revision++;
      return { ok: true };
    },
    sessionConnectedServicesAuthSet: async input => { accountWrites.push(input); return { ok: true }; },
    ...options,
  });
  const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId: 'home', serverIdentityId: 'home', runtimeAccountId: 'recipient',
    actionCaller: { kind: 'host' as const }, actionRequestId: 'update-request',
    actionsSettings: ActionsSettingsV1Schema.parse({ v: 1 }), ...executionContext };
  const diff = async () => {
    const result = await executor.execute('template.updates.diff', { sessionRef: ref }, context);
    if (!result.ok) throw new Error(JSON.stringify(result));
    return result.result as import('./templateUpdateActionsV1.js').BotTemplateUpdateDiffResultV1;
  };
  const applyInput = (review: Awaited<ReturnType<typeof diff>>, extra: object = {}) => ({
    sessionRef: ref, expectedVersion: review.upstream.release.version, expectedRevision: review.upstream.revision,
    instructions: { expectedRevision: review.instructions!.revision }, ...extra });
  const apply = (review: Awaited<ReturnType<typeof diff>>, extra: object = {}) => {
    const input = applyInput(review, extra);
    return executor.execute('template.updates.apply', input, { ...context,
      presentUserConfirmation: { actionId: 'template.updates.apply', inputDigest: computeActionInputApprovalDigestV1('template.updates.apply', input),
        accountId: 'recipient', serverId: context.serverIdentityId, requestId: 'update-request', target: null } });
  };
  return { diff, apply, prepareApply: (review: Awaited<ReturnType<typeof diff>>, extra: object = {}) => execute.prepareUpdate({
    input: applyInput(review, extra), context, invokeChild: child => {
      if (typeof child.action !== 'string') throw new Error('Unexpected contributed preparation');
      return executor.execute(child.action, child.input, context);
    } }), executor, context, docs, doc, memory, store, writes, contentReads, reports, accountWrites, incumbentService, boundary,
    metadata, catalog: () => catalog,
    seedMcp: (key: string, entry: McpServerCatalogV1['servers'][number]) => {
      instance = { ...instance, mcpServerIds: { ...instance.mcpServerIds, [key]: entry.id } };
      catalog = { ...catalog, servers: [...catalog.servers, entry] };
    },
    seedSkillReference: (key: string, skillId: string) => { instance = { ...instance, skillIds: { ...instance.skillIds, [key]: skillId } }; },
    seedSkill: async (key: string, files: Parameters<typeof skillAction>[0]['input']) => {
      const result = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.create'].parse(await skillAction({ actionId: 'skills.create', input: files,
        context: { ...context, invocationServices: { templateSkillSessionId: ref.sessionId } } }));
      instance = { ...instance, skillIds: { ...instance.skillIds, [key]: result.skillId } }; return result.skillId;
    },
    failCapability: (next: boolean | 'refused' = true) => { failCapability = next; },
    accepted: (release: BotTemplateReleaseV1) => { const row = boundary.rows.get(baseId)!; const envelope = { v: 1 as const, state: 'released' as const, release };
      boundary.rows.set(baseId, { ...row, body: JSON.stringify(envelope), header: projectBotTemplateArtifactHeaderV1(envelope) }); },
    release: (release: BotTemplateReleaseV1) => { const row = boundary.rows.get(sourceId)!; const envelope = { v: 1 as const, state: 'released' as const, release };
      boundary.rows.set(sourceId, { ...row, body: JSON.stringify(envelope), header: projectBotTemplateArtifactHeaderV1(envelope),
        revision: { headerVersion: row.revision.headerVersion + 1, bodyVersion: row.revision.bodyVersion + 1 } }); },
    state: () => ({ instance, instanceWrites, sourceReads, title, face }), failSettlement: (next = true) => { failSettlement = next; },
    failFace: (next = true) => { failFace = next; },
    refuseReport: () => { refuseReport = true; } };
}

describe('template update composition', () => {
  it('reconciles recovered skill bytes with a newly reviewed release before accepting its base', async () => {
    const f = await fixture();
    const entries = (text: string) => [skillFileFromBytesV1('SKILL.md', new TextEncoder().encode(`---\nname: guide\ndescription: Review\n---\n${text}\n`))];
    const release = (version: string, text: string): BotTemplateReleaseV1 => ({ ...upstream, version,
      content: { ...upstream.content, skills: [{ key: 'guide', title: 'Guide', bundleSchemaId: 'skills.skill_md_v1', entries: entries(text) }] } });
    f.release(release('1.1.0', 'Old guide'));
    f.failCapability('refused');
    const partial = await f.apply(await f.diff(), { skills: { guide: { choice: 'take' } } });
    expect(partial).toMatchObject({ ok: false, errorCode: 'conflict' });
    if (partial.ok) throw new Error('Expected inclusion refusal');
    const recovery = BotTemplateUpdateFailureDetailsV1Schema.parse(partial.details);
    expect(recovery.acceptedBaseId).toBeUndefined();
    f.release(release('1.2.0', 'New guide'));
    f.failCapability(false);
    expect(await f.apply(await f.diff(), { skills: { guide: { choice: 'take' } },
      recovery: { skillIds: recovery.skillIds, mcpServerIds: {} } })).toMatchObject({ ok: true, result: { acceptedVersion: '1.2.0' } });
    const skillId = f.state().instance.skillIds.guide;
    expect(skillId).toBe(recovery.skillIds?.guide);
    expect(f.docs.size).toBe(3);
    const stored = await f.executor.execute('skills.updates.diff', { skillId,
      candidate: { baseFiles: entries('New guide'), files: entries('New guide') } }, f.context);
    if (!stored.ok) throw new Error(JSON.stringify(stored));
    const diff = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.updates.diff'].parse(stored.result);
    expect(diff.files.every(file => !file.changed)).toBe(true);
    expect(JSON.parse(f.boundary.rows.get(f.state().instance.acceptedBase.artifactId)!.body!)).toMatchObject({ release: release('1.2.0', 'New guide') });
  });
  it.each([true, 'refused'] as const)('preserves the inclusion cause when taking a new skill (failure=%s)', async failure => {
    const f = await fixture();
    const entries = [skillFileFromBytesV1('SKILL.md', new TextEncoder().encode('---\nname: guide\ndescription: Review\n---\nGuide\n'))];
    f.release({ ...upstream, content: { ...upstream.content, skills: [{ key: 'guide', title: 'Guide', bundleSchemaId: 'skills.skill_md_v1', entries }] } });
    const review = await f.diff();
    f.failCapability(failure);
    const result = await f.apply(review, { skills: { guide: { choice: 'take' } } });
    expect(result).toMatchObject({ ok: false, errorCode: failure === 'refused' ? 'conflict' : 'session_metadata_unavailable' });
    expect(f.state().instance.acceptedVersion).toBe('1.0.0');
    expect(f.docs.size).toBe(3);
    if (failure === 'refused') {
      if (result.ok) throw new Error('Expected inclusion refusal');
      const retained = BotTemplateUpdateFailureDetailsV1Schema.parse(result.details);
      f.failCapability(false);
      expect(await f.apply(await f.diff(), { skills: { guide: { choice: 'take' } },
        recovery: { skillIds: retained.skillIds ?? {}, mcpServerIds: retained.mcpServerIds ?? {} } }))
        .toMatchObject({ ok: true, result: { acceptedVersion: '1.1.0' } });
      expect(f.docs.size).toBe(3);
    }
  });
  it.each(['machines.setup.plan', 'machines.setup.apply'] as const)('refuses software Update before content or identity changes when its token lacks %s', async missing => {
    let plans = 0;
    const f = await fixture({ machineSetupPlan: async ({ input }) => {
      plans++;
      return { desiredRevision: 0, sources: input.sources ?? [], exclusions: [], support: [], recipePlans: [] };
    } }, undefined, { externalActionCredential: { accountId: 'recipient', principalId: 'pat', credentialId: 'credential',
      grant: { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids:
        ['template.updates.diff', 'template.updates.apply', 'machines.setup.plan', 'machines.setup.apply'].filter(id => id !== missing) } } } });
    f.release({ ...upstream, content: { ...upstream.content, needs: { ...upstream.content.needs,
      software: [{ key: 'git', name: 'Git', requirement: 'required', purpose: 'Review changes', skipConsequence: '',
        recipe: { pluginId: 'test.tools', recipeId: 'git', revision: '1' } }] } } });
    expect(await f.apply(await f.diff(), { takeIdentity: true,
      setup: { software: [{ key: 'git', selection: { action: 'install', inputs: {} } }], accounts: [], mcpServers: [] } }))
      .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect(plans).toBe(missing === 'machines.setup.plan' ? 0 : 1);
    expect(f.writes).toEqual([]);
    expect(f.state().instanceWrites).toBe(0);
    expect(f.state().title).toBe('My helper');
  });
  it.each(['account', 'full-token', 'scoped-token'] as const)('retains software Update preparation for %s', async credential => {
    const f = await fixture({ machineSetupPlan: async ({ input }) => ({ desiredRevision: 0,
      sources: input.sources ?? [], exclusions: [], support: [], recipePlans: [] }) }, undefined, credential === 'account' ? {} : {
      externalActionCredential: { accountId: 'recipient', principalId: 'pat', credentialId: 'credential', grant: credential === 'full-token' ? API_TOKEN_FULL_GRANT_V1
          : { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['template.updates.diff', 'template.updates.apply', 'machines.setup.plan', 'machines.setup.apply'] } } },
    });
    f.release({ ...upstream, content: { ...upstream.content, needs: { ...upstream.content.needs,
      software: [{ key: 'git', name: 'Git', requirement: 'required', purpose: 'Review changes', skipConsequence: '',
        recipe: { pluginId: 'test.tools', recipeId: 'git', revision: '1' } }] } } });
    expect(await f.prepareApply(await f.diff(), { setup: { software: [{ key: 'git', selection: { action: 'install', inputs: {} } }],
      accounts: [], mcpServers: [] } })).toMatchObject({ approvalPreview: { softwarePlan: { recipePlans: [] } } });
    expect(f.writes).toEqual([]);
    expect(f.state().instanceWrites).toBe(0);
  });
  it('retains scoped Update preparation without software', async () => {
    const f = await fixture({}, undefined, { externalActionCredential: { accountId: 'recipient', principalId: 'pat', credentialId: 'credential',
      grant: { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['template.updates.diff', 'template.updates.apply'] } } } });
    expect(await f.prepareApply(await f.diff())).toMatchObject({ approvalPreview: { upstream: { release: { version: '1.1.0' } } } });
    expect(f.writes).toEqual([]);
  });
  it('applies the reviewed update after an unrelated Session title change', async () => {
    // OWNER-RULINGS 2026-11-05 (5), BT-OVERBUILD X3: item revisions and
    // instance CAS own update conflicts; unrelated Session metadata does not.
    const f = await fixture();
    const review = await f.diff();
    expect(await f.executor.execute('session.title.set', {
      sessionId: ref.sessionId, title: 'My renamed helper',
    }, f.context)).toMatchObject({ ok: true });
    expect((await f.diff()).metadataRevision).toBeGreaterThan(review.metadataRevision);

    const result = await f.apply(review);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { acceptedVersion: '1.1.0' } });
    expect(f.state()).toMatchObject({ title: 'My renamed helper', instance: { acceptedVersion: '1.1.0' } });
  });

  it('projects changed first-task and Agent suggestions from the accepted base and current release', async () => {
    const f = await fixture();
    f.accepted({ ...base, content: { ...base.content, firstTask: 'Sort the harvest',
      suggestedAgent: { agentId: 'claude', modelId: 'old-model' } } });
    f.release({ ...upstream, content: { ...upstream.content, firstTask: 'Plan the planting',
      suggestedAgent: { agentId: 'codex', modelId: 'new-model' } } });
    const review = await f.diff();
    expect(review.acceptedSuggestions).toEqual({ firstTask: 'Sort the harvest',
      suggestedAgent: { agentId: 'claude', modelId: 'old-model' } });
    expect(review.upstream.release.content).toMatchObject({ firstTask: 'Plan the planting',
      suggestedAgent: { agentId: 'codex', modelId: 'new-model' } });
  });
  it.each([null, { style: 'solid', body: 'crab', seed: 'theirs' }] as const)(
    'takes the author identity through the canonical title and face Actions: %j', async face => {
      const f = await fixture();
      f.release({ ...upstream, content: { ...upstream.content, identity: { name: 'Author helper', description: '', ...(face ? { face } : {}) } } });
      const result = await f.apply(await f.diff(), { takeIdentity: true });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { acceptedVersion: '1.1.0', applied: ['instructions', 'identity'] } });
      expect(f.state()).toMatchObject({ title: 'Author helper', face, instance: { acceptedVersion: '1.1.0' } });
      expect(f.reports).toEqual([{ artifactId: sourceId, acceptedVersion: '1.1.0', copyId: ref.sessionId }]);
    });

  it.each([false, true])('re-reviews a failed face write after instructions/title succeed and retries with takeIdentity=%s', async takeIdentity => {
    const f = await fixture();
    const original = f.state();
    const authorFace = { style: 'solid', body: 'crab', seed: 'theirs' } as const;
    f.release({ ...upstream, content: { ...upstream.content, identity: { name: 'Author helper', description: '', face: authorFace } } });
    f.failFace();
    const partial = await f.apply(await f.diff(), { takeIdentity: true });
    expect(partial).toMatchObject({ ok: false, errorCode: 'session_metadata_unavailable',
      details: { applied: ['instructions'], remaining: ['identity', 'settlement'] } });
    expect(f.state()).toMatchObject({ title: 'Author helper', face: original.face, instance: original.instance, instanceWrites: 0 });
    expect(f.reports).toEqual([]);
    expect(await readPromptDocInLibrary({ store: f.store, artifactId: f.doc.artifactId }))
      .toMatchObject({ markdown: 'mine\ntwo\nnew three\n' });
    f.failFace(false);
    const retry = await f.apply(await f.diff(), { takeIdentity });
    expect(retry, JSON.stringify(retry)).toMatchObject({ ok: true, result: { acceptedVersion: '1.1.0', kept: ['instructions'] } });
    expect(f.state()).toMatchObject({ title: 'Author helper', face: takeIdentity ? authorFace : original.face,
      instance: { acceptedVersion: '1.1.0' }, instanceWrites: 1 });
    expect(f.writes).toEqual([f.doc.artifactId]);
    expect(f.reports).toEqual([{ artifactId: sourceId, acceptedVersion: '1.1.0', copyId: ref.sessionId }]);
  });

  it('applies a freshly reviewed skipped release and clears the skipped offer', async () => {
    const f = await fixture();
    expect(await f.executor.execute('template.updates.skip', { sessionRef: ref, version: '1.1.0' }, f.context))
      .toMatchObject({ ok: true, result: { changed: true } });
    const review = await f.diff();
    expect(review.offer).toBe('skipped');
    const applied = await f.apply(review);
    expect(applied, JSON.stringify(applied)).toMatchObject({ ok: true, result: { acceptedVersion: '1.1.0' } });
    expect(f.state().instance).toMatchObject({ acceptedVersion: '1.1.0', follow: true });
    expect(f.state().instance.skippedVersion).toBeUndefined();
  });

  it('previews a pinned plugin release and adopts the offered release through reviewed update preparation', async () => {
    // Plugin acquisition is a transport boundary; the real update/diff/child owners remain beneath it.
    const f = await fixture({}, async (source, _context, _signal, purpose?: 'update') => readBotTemplateReleaseV1(
      purpose === 'update' ? upstream : base, { ...source, registryItem: { ...source.registryItem,
        version: purpose === 'update' ? '1.1.0' : source.registryItem.version } }));
    f.accepted({ ...base, content: { ...base.content, firstTask: 'Plan the harvest',
      suggestedAgent: { agentId: 'claude' } } });
    const selected = f.state().instance.source;
    expect(await f.executor.execute('template.preview', { source: selected }, f.context))
      .toMatchObject({ ok: true, result: { release: { version: '1.0.0' } } });
    const review = await f.diff();
    expect(review).toMatchObject({ offer: 'available', upstream: { release: { version: '1.1.0' } } });
    expect(review.acceptedSuggestions).toEqual({ firstTask: 'Plan the harvest', suggestedAgent: { agentId: 'claude' } });
    expect(await f.apply(review)).toMatchObject({ ok: true, result: { acceptedVersion: '1.1.0' } });
    expect(f.state().instance.acceptedVersion).toBe('1.1.0');
    expect(f.state().instance.source).toEqual({ kind: 'plugin', registryItem: {
      sourceId: 'templates', itemId: '@acme/helper', version: '1.1.0' }, contributionId: 'helper' });
  });
  it('uses the retained base, combines disjoint changes and leaves learned memory byte-for-byte unchanged', async () => {
    const f = await fixture(); const before = structuredClone(f.docs.get(f.memory.artifactId));
    const review = await f.diff();
    expect(review.offer).toBe('available');
    expect(review.instructions?.comparison.text).toBe('mine\ntwo\nnew three\n');
    expect(await f.apply(review)).toMatchObject({ ok: true, result: { acceptedVersion: '1.1.0' } });
    expect((await readPromptDocInLibrary({ store: f.store, artifactId: f.doc.artifactId }))).toMatchObject({ title: 'Local instructions', markdown: 'mine\ntwo\nnew three\n' });
    expect(f.docs.get(f.memory.artifactId)).toEqual(before);
    expect(f.contentReads).not.toContain(f.memory.artifactId);
    expect(f.writes).toEqual([f.doc.artifactId]);
    expect(f.state().instance.acceptedVersion).toBe('1.1.0');
    expect(f.reports).toEqual([{ artifactId: sourceId, copyId: ref.sessionId, acceptedVersion: '1.1.0' }]);
  });
  it('advances the accepted release without rewriting an unchanged instruction section or reading learned memory', async () => {
    const f = await fixture();
    f.release({ ...upstream, content: { ...upstream.content, instructions: { markdown: 'mine\ntwo\nthree\n' } } });
    expect(await f.apply(await f.diff())).toMatchObject({ ok: true, result: { applied: [], kept: ['instructions'] } });
    expect(f.writes).toEqual([]);
    expect(f.contentReads).not.toContain(f.memory.artifactId);
    expect(f.state().instance.acceptedVersion).toBe('1.1.0');
  });
  it('reviews upstream whole-skill removal and removes only its Session inclusion on explicit choice', async () => {
    const f = await fixture();
    const entries = [skillFileFromBytesV1('SKILL.md', new TextEncoder().encode('---\nname: guide\ndescription: Review\n---\nGuide\n'))];
    const skillId = await f.seedSkill('guide', { name: 'guide', files: entries });
    f.accepted({ ...base, content: { ...base.content, skills: [{ key: 'guide', title: 'Guide', bundleSchemaId: 'skills.skill_md_v1', entries }] } });
    const before = structuredClone(f.docs.get(skillId));
    const review = await f.diff();
    expect(review.skills[0]).toMatchObject({ key: 'guide', status: 'removed', canTake: false });
    expect(review.skills[0].files.every(file => file.theirs === null)).toBe(true);
    expect(await f.apply(review, { skills: { guide: { choice: 'remove', expectedRevision: review.skills[0].revision } } })).toMatchObject({ ok: true });
    expect(readSessionCapabilityOverrideV1(readSessionCapabilitySelectionFromMetadataV1(f.metadata()), 'skill', skillId)).toBe('off');
    expect(f.docs.get(skillId)).toEqual(before);
    expect(f.state().instance.skillIds.guide).toBeUndefined();
  });
  it('refuses unavailable skill choices before changing any bound content', async () => {
    const f = await fixture();
    const entries = [skillFileFromBytesV1('SKILL.md', new TextEncoder().encode('---\nname: guide\ndescription: Review\n---\nGuide\n'))];
    f.release({ ...upstream, content: { ...upstream.content, skills: [{ key: 'guide', title: 'Guide', bundleSchemaId: 'skills.skill_md_v1', entries }] } });
    const review = await f.diff();
    expect(await f.apply(review, { skills: { guide: { choice: 'remove' } } })).toMatchObject({ ok: false, errorCode: 'invalid_request' });
    expect(f.writes).toEqual([]); expect(f.docs.size).toBe(2);
    expect(f.state().instance.acceptedVersion).toBe('1.0.0');
  });
  it('refuses a changed local revision and keeps the accepted base unchanged', async () => {
    const f = await fixture(); const review = await f.diff();
    await updatePromptDocInLibrary({ store: f.store, request: { artifactId: f.doc.artifactId, title: 'Local instructions',
      expectedRevision: review.instructions!.revision, markdown: 'new local edit' } });
    expect(await f.apply(review)).toMatchObject({ ok: false, errorCode: 'revision_conflict' });
    expect(f.state().instance.acceptedVersion).toBe('1.0.0');
    expect(f.docs.get(f.doc.artifactId)?.body).toContain('new local edit');
  });
  it('reports applied resources on partial settlement without advancing accepted version', async () => {
    const f = await fixture(); const review = await f.diff(); f.failSettlement();
    expect(await f.apply(review)).toMatchObject({ ok: false, errorCode: 'session_metadata_unavailable', details: { applied: ['instructions'] } });
    expect(f.state().instance.acceptedVersion).toBe('1.0.0');
    expect(f.reports).toEqual([]);
  });
  it('reports successful settlement best effort and reuses a retained base after partial settlement', async () => {
    const f = await fixture(); const review = await f.diff(); f.failSettlement();
    const partial = await f.apply(review);
    expect(partial).toMatchObject({ ok: false, details: { acceptedBaseId: expect.any(String), applied: ['instructions'], remaining: ['settlement'] } });
    if (partial.ok) throw new Error('expected failed metadata boundary');
    const recovered = BotTemplateUpdateFailureDetailsV1Schema.parse(partial.details);
    f.failSettlement(false); f.refuseReport();
    const next = await f.diff();
    expect(await f.apply(next, { recovery: { skillIds: recovered.skillIds ?? {}, mcpServerIds: recovered.mcpServerIds ?? {}, acceptedBaseId: recovered.acceptedBaseId } }))
      .toMatchObject({ ok: true, result: { acceptedVersion: '1.1.0', resourceIds: [] } });
    expect(f.writes).toEqual([f.doc.artifactId]);
    expect(f.reports).toHaveLength(1);
  });
  it('advances the upstream base across a skipped new skill so the next release preserves its absence', async () => {
    const f = await fixture();
    const skill = { key: 'new-skill', title: 'New skill', bundleSchemaId: 'skills.skill_md_v1' as const,
      entries: [skillFileFromBytesV1('SKILL.md', new TextEncoder().encode('---\nname: helper\ndescription: help\n---\nbody\n'))] };
    const release = { ...upstream, content: { ...upstream.content, skills: [skill] } };
    f.release(release);
    const review = await f.diff();
    expect(review.skills[0]).toMatchObject({ key: skill.key, status: 'added' });
    expect(await f.apply(review, { skills: { [skill.key]: { choice: 'skip' } } })).toMatchObject({ ok: true });
    f.release({ ...release, version: '1.2.0' });
    expect((await f.diff()).skills[0]).toMatchObject({ key: skill.key, status: 'deleted' });
    expect(f.state().instance.skillIds).toEqual({});
  });
  it('requires newly added accounts before content effects and retains incumbent recipient bindings', async () => {
    const f = await fixture();
    const need = { key: 'github', serviceId: 'github', name: 'GitHub', requirement: 'required' as const,
      purpose: 'Read repository issues', skipConsequence: 'Cannot read repository issues' };
    const release = { ...upstream, content: { ...upstream.content,
      needs: { ...upstream.content.needs, connectedAccounts: [need] } } };
    f.release(release);
    const review = await f.diff();
    expect(review.needs.connectedAccounts).toEqual([need]);
    expect(await f.apply(review)).toMatchObject({ ok: false, errorCode: 'missing_values' });
    expect(f.writes).toEqual([]);
    expect(f.accountWrites).toEqual([]);
    expect(f.state().instance.acceptedVersion).toBe('1.0.0');
    expect(await f.apply(review, { setup: { software: [], mcpServers: [], accounts: [{ key: need.key,
      selection: { action: 'connect', binding: { source: 'connected', selection: 'profile', profileId: 'recipient-github' } } }] } }))
      .toMatchObject({ ok: true, result: { applied: ['accounts', 'instructions'] } });
    expect(f.accountWrites).toMatchObject([{ machineId: 'recipient-machine', sessionId: ref.sessionId,
      bindings: { bindingsByServiceId: {
        [f.incumbentService]: { profileId: 'incumbent' },
        [readBuiltInLegacyConnectedAccountServiceKeyIngress('github')!]: { profileId: 'recipient-github' },
      } } }]);
    f.release({ ...release, version: '1.2.0' });
    expect((await f.diff()).needs.connectedAccounts).toEqual([]);
  });
  it.each(['first', 'second'] as const)('updates a changed imported MCP stable key through the same catalog identity and Session reach for the %s copy', async copy => {
    const f = await fixture();
    const need = { key: 'docs', name: 'Docs', requirement: 'required' as const, purpose: 'Read documentation', skipConsequence: '',
      definition: { name: 'docs', transport: 'http' as const, env: {},
        remote: { url: { baseUrl: { kind: 'literal' as const, value: 'https://old.example/mcp' }, query: [] }, headers: {} }, inputs: [] } };
    f.accepted({ ...base, content: { ...base.content, needs: { ...base.content.needs, mcpServers: [need] } } });
    const importedName = copy === 'second' ? 'docs_2' : 'docs';
    f.seedMcp(need.key, { id: 'existing-docs', name: importedName, transport: 'http', remote: { url: 'https://old.example/mcp', headers: {} },
      env: {}, createdAt: 10, updatedAt: 10 });
    if (copy === 'second') f.catalog().servers.push({ id: 'first-copy-docs', name: 'docs', transport: 'http',
      remote: { url: 'https://old.example/mcp', headers: {} }, env: {}, createdAt: 1, updatedAt: 1 });
    expect(await f.executor.execute('session.capabilities.set', { sessionId: ref.sessionId, kind: 'mcp_server', id: 'existing-docs', state: 'on' }, f.context))
      .toMatchObject({ ok: true });
    const next = { ...need, definition: { ...need.definition, remote: { ...need.definition.remote,
      url: { ...need.definition.remote.url, baseUrl: { kind: 'literal' as const, value: 'https://new.example/mcp' } } } } };
    f.release({ ...upstream, content: { ...upstream.content, needs: { ...upstream.content.needs, mcpServers: [next] } } });
    const review = await f.diff();
    const result = await f.apply(review, { setup: { software: [], accounts: [], mcpServers: [{ key: need.key, selection: { action: 'bind', inputs: {} } }] } });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(f.catalog().servers.find(server => server.id === 'existing-docs')).toMatchObject({ name: importedName,
      remote: { url: 'https://new.example/mcp', headers: {} }, createdAt: 10 });
    expect(f.catalog().servers).toHaveLength(copy === 'second' ? 2 : 1);
    expect(f.state().instance.mcpServerIds).toEqual({ docs: 'existing-docs' });
    const selection = readSessionCapabilitySelectionFromMetadataV1(f.metadata());
    expect(readSessionCapabilityOverrideV1(selection, 'mcp_server', 'existing-docs')).toBe('on');
  });
  it.each([false, true])('retains an acknowledged MCP identity on retry and reconciles the reviewed definition (new release=%s)', async changedRelease => {
    const f = await fixture();
    const need = { key: 'docs', name: 'Docs', requirement: 'required' as const, purpose: 'Read documentation', skipConsequence: '',
      definition: { name: 'docs', transport: 'http' as const, env: {},
        remote: { url: { baseUrl: { kind: 'literal' as const, value: 'https://docs.example/mcp' }, query: [] }, headers: {} }, inputs: [] } };
    f.release({ ...upstream, content: { ...upstream.content, needs: { ...upstream.content.needs, mcpServers: [need] } } });
    const setup = { software: [], accounts: [], mcpServers: [{ key: need.key, selection: { action: 'bind', inputs: {} } }] };
    f.failCapability();
    const partial = await f.apply(await f.diff(), { setup });
    expect(partial, JSON.stringify(partial)).toMatchObject({ ok: false, details: { mcpServerIds: { docs: expect.any(String) }, remaining: ['mcp:docs', 'settlement'] } });
    if (partial.ok) throw new Error('expected Session persistence failure');
    const recovery = BotTemplateUpdateFailureDetailsV1Schema.parse(partial.details);
    expect(f.catalog().servers).toHaveLength(1);
    expect(f.state().instance.acceptedVersion).toBe('1.0.0');
    const candidate = changedRelease ? { ...need, definition: { ...need.definition, remote: { ...need.definition.remote,
      url: { ...need.definition.remote.url, baseUrl: { kind: 'literal' as const, value: 'https://new-docs.example/mcp' } } } } } : need;
    if (changedRelease) f.release({ ...upstream, version: '1.2.0', content: { ...upstream.content,
      needs: { ...upstream.content.needs, mcpServers: [candidate] } } });
    f.failCapability(false);
    const result = await f.apply(await f.diff(), { setup, recovery: { skillIds: {}, mcpServerIds: recovery.mcpServerIds } });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(f.catalog().servers).toHaveLength(1);
    expect(f.state().instance.mcpServerIds).toEqual(recovery.mcpServerIds);
    expect(f.catalog().servers[0]).toMatchObject({ remote: { url: candidate.definition.remote.url.baseUrl.value } });
    expect(f.state().instance.acceptedVersion).toBe(changedRelease ? '1.2.0' : '1.1.0');
  });
  it('returns only new resource recovery identities when incumbent skills and MCP already exist', async () => {
    const f = await fixture();
    const skill = { key: 'guide', title: 'Guide', bundleSchemaId: 'skills.skill_md_v1' as const,
      entries: [skillFileFromBytesV1('SKILL.md', new TextEncoder().encode('---\nname: guide\ndescription: Review changes\n---\nGuide\n'))] };
    f.seedSkillReference(skill.key, 'incumbent-guide');
    f.accepted({ ...base, content: { ...base.content, skills: [skill] } });
    f.release({ ...upstream, content: { ...upstream.content, skills: [skill] } });
    f.seedMcp('incumbent-mcp', { id: 'incumbent-mcp', name: 'incumbent', transport: 'http',
      remote: { url: 'https://incumbent.example/mcp', headers: {} }, env: {}, createdAt: 1, updatedAt: 1 });
    expect(await f.executor.execute('session.capabilities.set', { sessionId: ref.sessionId, kind: 'skill', id: 'incumbent-guide', state: 'off' }, f.context))
      .toMatchObject({ ok: true });
    f.failSettlement();
    const partial = await f.apply(await f.diff());
    expect(partial, JSON.stringify(partial)).toMatchObject({ ok: false, details: { skillIds: {}, mcpServerIds: {}, acceptedBaseId: expect.any(String) } });
    if (partial.ok) throw new Error('expected private settlement failure');
    const details = BotTemplateUpdateFailureDetailsV1Schema.parse(partial.details);
    expect(details.skillIds).toEqual({}); expect(details.mcpServerIds).toEqual({});
    f.failSettlement(false);
    const result = await f.apply(await f.diff(), { recovery: { skillIds: details.skillIds, mcpServerIds: details.mcpServerIds, acceptedBaseId: details.acceptedBaseId } });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(f.state().instance.skillIds).toEqual({ guide: 'incumbent-guide' });
    expect(f.state().instance.mcpServerIds).toEqual({ 'incumbent-mcp': 'incumbent-mcp' });
  });
  it('preserves a locally deleted skill by default and permits explicit Add from the current upstream', async () => {
    const f = await fixture();
    const skill = { key: 'guide', title: 'Guide', bundleSchemaId: 'skills.skill_md_v1' as const,
      entries: [skillFileFromBytesV1('SKILL.md', new TextEncoder().encode('---\nname: guide\ndescription: Review changes\n---\nGuide\n'))] };
    f.accepted({ ...base, content: { ...base.content, skills: [skill] } });
    f.release({ ...upstream, content: { ...upstream.content, skills: [skill] } });
    const review = await f.diff();
    expect(review.skills[0]).toMatchObject({ key: skill.key, status: 'deleted' });
    expect(f.docs.size).toBe(2);
    const result = await f.apply(review, { skills: { guide: { choice: 'take' } } });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(f.state().instance.skillIds.guide).toEqual(expect.any(String));
    expect(f.docs.size).toBe(3);
    expect(readSessionCapabilityOverrideV1(readSessionCapabilitySelectionFromMetadataV1(f.metadata()), 'skill', f.state().instance.skillIds.guide!)).toBe('on');
  });
  it('adds a fresh upstream skill after its incumbent inclusion was turned off locally', async () => {
    const f = await fixture();
    const entries = [skillFileFromBytesV1('SKILL.md', new TextEncoder().encode('---\nname: guide\ndescription: Review\n---\nGuide\n'))];
    const skill = { key: 'guide', title: 'Guide', bundleSchemaId: 'skills.skill_md_v1' as const, entries };
    const incumbentId = await f.seedSkill(skill.key, { name: 'guide', files: entries });
    f.accepted({ ...base, content: { ...base.content, skills: [skill] } });
    f.release({ ...upstream, content: { ...upstream.content, skills: [skill] } });
    expect(await f.executor.execute('session.capabilities.set', { sessionId: ref.sessionId, kind: 'skill', id: incumbentId, state: 'off' }, f.context))
      .toMatchObject({ ok: true });
    const incumbent = structuredClone(f.docs.get(incumbentId));
    const review = await f.diff();
    expect(review.skills[0]).toMatchObject({ status: 'deleted', canTake: true });
    const result = await f.apply(review, { skills: { guide: { choice: 'take' } } });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    const addedId = f.state().instance.skillIds.guide!;
    expect(addedId).not.toBe(incumbentId);
    const selection = readSessionCapabilitySelectionFromMetadataV1(f.metadata());
    expect(readSessionCapabilityOverrideV1(selection, 'skill', incumbentId)).toBe('off');
    expect(readSessionCapabilityOverrideV1(selection, 'skill', addedId)).toBe('on');
    expect(f.docs.get(incumbentId)).toEqual(incumbent);
  });
  it('keeps the accepted base behind terminal setup failure and accepts only after a successful reviewed retry', async () => {
    const recipe = { pluginId: 'test.tools', recipeId: 'git', revision: '1' };
    const setup = { items: [{ kind: 'softwareRecipe' as const, selection: { ref: recipe, inputs: {} } }] };
    const events: string[] = [];
    let releaseEffect: ((state: 'failed' | 'succeeded') => void) | undefined;
    let effect = new Promise<'failed' | 'succeeded'>(resolve => { releaseEffect = resolve; });
    let enterEffect: (() => void) | undefined;
    let entered = new Promise<void>(resolve => { enterEffect = resolve; });
    let attempt = 0;
    const f = await fixture({ machineSetupPlan: async ({ input }) => {
      expect(input.homeId).toBe('stable-home');
      events.push('plan');
      return { desiredRevision: 0, sources: [{ kind: 'direct', setup }], exclusions: [], support: [{ sourceIndex: 0, itemIndex: 0, status: 'drifted' }],
        recipePlans: [{ sourceIndex: 0, itemIndex: 0, plan: { v: 1,
          basis: { kind: 'setup', machineId: 'recipient-machine', desiredRevision: 0, selection: { ref: recipe, inputs: {} } },
          steps: [{ id: 'git', kind: 'package', manager: 'apt', packages: [{ name: 'git' }] }], planDigest: 'a'.repeat(64),
          nativeFacts: [{ stepId: 'git', status: 'drifted', facts: {} }] } }] };
    }, machineSetupApply: async ({ input, context }) => {
      expect(context.runtimeAccountId).toBe('recipient');
      expect(context.presentUserApproval?.actionId).toBe('template.updates.apply');
      expect(input.homeId).toBe('stable-home');
      expect(input.targets[0]).toMatchObject({ machineId: 'recipient-machine', desiredRevision: 0, sources: [{ kind: 'direct', setup }] });
      events.push('receipt'); attempt++; return { operationId: `install-git-${attempt}` };
    }, actionOperationAction: request => executeActionOperationActionV1({ ...request,
      // Network boundary follows the setup producer: receipt first, blocking get settles later.
      transport: async ({ serverId, machineId, method, payload }) => {
        expect({ serverId, machineId, method, payload }).toEqual({ serverId: 'home', machineId: 'recipient-machine',
          method: 'actionOperation.get.v2', payload: { operationId: `install-git-${attempt}`, waitForTerminal: true } });
        expect(request.context.runtimeAccountId).toBe('recipient');
        events.push('wait'); enterEffect!();
        const state = await effect;
        const operation: ActionOperationSnapshotV1 = { version: 1, operationId: `install-git-${attempt}`, revision: 2,
          actionId: 'machines.setup.apply', state, scope: { accountId: 'recipient', machineId }, title: 'Install Git',
          createdAt: 1, startedAt: 1, settledAt: 2, cancellation: 'supported',
          ...(state === 'failed' ? { error: { errorCode: 'package_install_failed', error: 'Package install failed' } } : {}) };
        return ActionOperationGetV1ResponseSchema.parse({ kind: 'found', operation });
      } }) });
    f.context.serverIdentityId = 'stable-home';
    f.release({ ...upstream, content: { ...upstream.content, needs: { ...upstream.content.needs, software: [{ key: 'git', name: 'Git',
      requirement: 'required', purpose: 'Read changes', skipConsequence: '', recipe }] } } });
    const review = await f.diff();
    const selections = { setup: { software: [{ key: 'git', selection: { action: 'install', inputs: {} } }], accounts: [], mcpServers: [] } };
    const pending = f.apply(review, selections);
    await Promise.race([entered, pending.then(result => { throw new Error(`Apply settled before the native effect: ${JSON.stringify(result)}`); })]);
    expect(events).toEqual(['plan', 'receipt', 'wait']);
    expect(f.state().instance.acceptedVersion).toBe('1.0.0');
    expect(f.state().instanceWrites).toBe(0);
    expect(f.reports).toEqual([]);
    expect(f.boundary.rows.has(baseId)).toBe(true);
    releaseEffect!('failed');
    expect(await pending).toMatchObject({ ok: false, errorCode: 'package_install_failed',
      details: { applied: ['instructions'], remaining: ['software', 'settlement'] } });
    expect(f.state().instance).toMatchObject({ acceptedVersion: '1.0.0', acceptedBase: { artifactId: baseId } });
    expect(f.boundary.rows.size).toBe(2);
    const learnedMemory = structuredClone(f.docs.get(f.memory.artifactId));
    const instructionWrites = f.writes.length;
    effect = new Promise(resolve => { releaseEffect = resolve; });
    entered = new Promise(resolve => { enterEffect = resolve; });
    const retryReview = await f.diff();
    const retry = f.apply(retryReview, selections);
    await Promise.race([entered, retry.then(result => { throw new Error(`Retry settled before setup: ${JSON.stringify(result)}`); })]);
    expect(f.state().instanceWrites).toBe(0);
    releaseEffect!('succeeded');
    expect(await retry).toMatchObject({ ok: true, result: { acceptedVersion: '1.1.0', applied: ['software'] } });
    expect(f.state().instance).toMatchObject({ acceptedVersion: '1.1.0' });
    expect(f.state().instanceWrites).toBe(1);
    expect(f.boundary.rows.has(baseId)).toBe(false);
    expect(f.reports).toHaveLength(1);
    expect(f.writes).toHaveLength(instructionWrites);
    expect(f.docs.get(f.memory.artifactId)).toEqual(learnedMemory);
    expect(await f.executor.execute('template.follow.stop', { sessionRef: ref }, f.context)).toMatchObject({ ok: true });
    expect(f.state().instance).toMatchObject({ acceptedVersion: '1.1.0', follow: false });
  });
  it('skip/stop only patch private intent and never load content; repeated choice writes nothing', async () => {
    const f = await fixture();
    expect(await f.executor.execute('template.updates.skip', { sessionRef: ref, version: '1.1.0' }, f.context)).toMatchObject({ ok: true, result: { changed: true } });
    expect(await f.executor.execute('template.updates.skip', { sessionRef: ref, version: '1.1.0' }, f.context)).toMatchObject({ ok: true, result: { changed: false } });
    expect(readBotTemplateUpdateOfferV1(f.state().instance, '1.1.0')).toBe('skipped');
    expect(readBotTemplateUpdateOfferV1(f.state().instance, '1.2.0')).toBe('available');
    expect(await f.executor.execute('template.follow.stop', { sessionRef: ref }, f.context)).toMatchObject({ ok: true });
    expect(f.state()).toMatchObject({ instanceWrites: 2, sourceReads: 0, instance: { follow: false, acceptedVersion: '1.0.0' } });
    expect(f.writes).toEqual([]);
  });
});
