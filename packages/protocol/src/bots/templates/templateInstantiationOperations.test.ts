import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '../../actions/actionExecutor.js';
import { createWorkBoardArtifactBoundary } from '../../boards/workBoardArtifactV1.testkit.js';
import { createPromptDocInLibrary, type PromptLibraryArtifactStore, type PromptLibraryStoredArtifact } from '../../prompts/library/promptLibraryActionOperations.js';
import { writeSessionContextIntentV1ToMetadata } from '../../sessions/context/sessionContextV1.js';
import { createBotTemplateActionExecuteV1 } from './botTemplateOperations.js';
import { projectBotTemplateArtifactHeaderV1, type BotTemplateReleaseV1 } from './botTemplateV1.js';
import { createSkillActionExecuteV1 } from '../../prompts/library/skills/skillActionOperations.js';
import type { SkillRulesActionPortV1 } from '../../prompts/library/skillRulesActionsV1.js';
import { setSessionCapabilityV1 } from '../../actions/executor/sessionCapabilities.js';
import { artifactSavedByFromActionContextV1 } from '../../artifacts/artifactBinaryV1.js';
import { readRecord } from '../../inputs/inputRecords.js';
import { readSessionCapabilitySelectionFromMetadataV1 } from '../../reach/sessionCapabilityMetadataV1.js';
import { ActionsSettingsV1Schema } from '../../actions/actionSettings.js';
import { computeActionInputApprovalDigestV1 } from '../../actions/decisionAuthority.js';
import { ApprovalRequestV2Schema, type ApprovalRequest } from '../../approvals/approvalRequestV1.js';
import { decideApprovalRequestTransition } from '../../approvals/approvalRequestTransition.js';
import { isApprovalRequiredByActionsSettings } from '../../actions/actionApprovalPolicy.js';
import { createMcpServerActionExecuteV1 } from '../../mcp/servers/serverActionsV1.js';
import { commitMcpServerCatalogMutationV1, loadMcpServerCatalogV1 } from '../../mcp/servers/serverCatalogV1.js';
import type { McpServerCatalogV1 } from '../../mcp/servers/serverRowsV1.js';
import type { SessionBotFaceV1 } from '../../sessions/identity/sessionBotFaceV1.js';

const releaseId = '84a6bc9c-0418-44f6-a593-8a751bde13e0';
const baseId = '7e23f798-230a-42f3-931f-e38b20736333';
const sessionId = 'cm00000000000000000000001';
const release: BotTemplateReleaseV1 = { v: 1, version: '1.0.0', changelog: '', releasedAtMs: 1,
  content: { v: 1, identity: { name: 'Helper', description: 'Reusable helper' }, instructions: { markdown: 'Help with work.' },
    memoryRules: [], skills: [], needs: { software: [], connectedAccounts: [], mcpServers: [] }, firstTask: 'Review my change' } };

function fixture(carried = false, operations = false, observeCommit = false, failSkillWrite = false, setup = false, report = false, awaiting = false,
  transient?: 'matching' | 'mismatched', requesterAdmission = false,
  copy?: { catalog: { value: McpServerCatalogV1; revision: number }; baseId: string; sessionId: string }) {
  const instanceBaseId = copy?.baseId ?? baseId;
  const instanceSessionId = copy?.sessionId ?? sessionId;
  let selectedRelease: BotTemplateReleaseV1 = carried ? { ...release, content: { ...release.content,
    memoryRules: [{ key: 'style', text: 'Prefer small changes.' }],
    skills: [{ key: 'guide', title: 'Guide', bundleSchemaId: 'skills.skill_md_v1', entries: [
      { path: 'SKILL.md', contentBase64: 'LS0tCm5hbWU6IGd1aWRlCmRlc2NyaXB0aW9uOiBndWlkZQotLS0KSGVscC4=', contentKind: 'utf8' },
      { path: 'images/example.bin', contentBase64: 'AAH//g==', contentKind: 'binary', unixMode: 0o755 },
    ] }],
  } } : release;
  if (setup) selectedRelease = { ...selectedRelease, content: { ...selectedRelease.content, needs: {
    software: [{ key: 'git', requirement: 'required', name: 'Git', purpose: 'Review changes', skipConsequence: '', recipe: { pluginId: 'test.tools', recipeId: 'git', revision: '1' } }],
    connectedAccounts: [{ key: 'github', requirement: 'required', name: 'GitHub', purpose: 'Read pull requests', skipConsequence: '', serviceId: 'github' }],
    mcpServers: [{ key: 'docs', requirement: 'required', name: 'Docs', purpose: 'Read documentation', skipConsequence: '', definition: {
      name: 'docs', transport: 'http', env: {}, remote: { url: { baseUrl: { kind: 'literal', value: 'https://example.com/mcp' }, query: [] }, headers: { Authorization: { kind: 'input', key: 'token' } } },
      inputs: [{ key: 'token', label: 'Token', purpose: 'Authenticate', secret: true, required: true }],
    } }],
  } } };
  // Session and Artifact persistence, plus actual process launch, are the only boundaries here.
  const boundary = createWorkBoardArtifactBoundary();
  const envelope = { v: 1 as const, state: 'released' as const, release: selectedRelease };
  boundary.rows.set(releaseId, { artifactId: releaseId, header: projectBotTemplateArtifactHeaderV1(envelope),
    body: JSON.stringify(envelope), revision: { headerVersion: 1, bodyVersion: 1 }, access: 'view', shared: true });
  const docs = new Map<string, PromptLibraryStoredArtifact>();
  let metadata: Record<string, unknown> = {};
  let revision = 0;
  let births = 0;
  let launches = 0;
  const catalogState = copy?.catalog ?? { value: { v: 1 as const, servers: [], bindings: [] } satisfies McpServerCatalogV1, revision: 0 };
  const events: string[] = [];
  let approval: ApprovalRequest | null = null;
  const store: PromptLibraryArtifactStore = {
    read: async id => docs.get(id) ?? null,
    create: async input => { const artifactId = `doc-${docs.size + 1}`;
      docs.set(artifactId, { id: artifactId, header: input.header, body: input.body,
        ...(input.savedBy ? { savedBy: input.savedBy } : {}), owned: true, access: 'owner', revision: { headerVersion: 1, bodyVersion: 1 } });
      events.push(docs.size === 1 ? 'instructions-created' : 'content-created'); return { artifactId, revision: { headerVersion: 1, bodyVersion: 1 } }; },
    update: async () => { throw new Error('Unexpected document update'); },
  };
  const skillRules: SkillRulesActionPortV1 = { serverId: 'home', assertCurrent: () => {},
    ruleWriteContext: () => ({ nowMs: 1, newId: () => 'rule' }), listSkills: async () => [],
    readCatalog: async () => ({ catalog: { status: 'ready', rows: [{ record: { key: 'skill-rules', value: { v: 1, rules: [] } }, revision: 1 }], tombstones: [], diagnostics: [] } }),
    writeRecord: async () => { throw new Error('Template skill must never acquire global reach'); },
  };
  const execute = createBotTemplateActionExecuteV1({ artifacts: boundary.forAccount('recipient'),
    randomId: () => instanceBaseId, readSourceDraftRef: async () => null, writeSourceDraftRef: async () => {}, grant: async () => {},
    ...(transient ? { resolveInstantiationRelease: async () => ({
      source: { kind: 'artifact' as const, serverId: 'home', artifactId: transient === 'matching' ? releaseId : 'other-source' },
      release: selectedRelease, revision: { headerVersion: 1, bodyVersion: 1 }, follow: false as const, reportAcceptedVersion: false as const,
    }) } : {}),
    recipient: {
      ...(requesterAdmission ? { prepareRequesterAdmission: async (request: { input: unknown; context: import('../../actions/executor/types.js').ActionExecutorContext;
        machineSetup?: import('../../machines/managed/machineSetupV1.js').MachineSetupV1 }) => {
        expect(request.machineSetup).toMatchObject({ items: [{ kind: 'softwareRecipe', selection: { ref: { pluginId: 'test.tools', recipeId: 'git', revision: '1' } } }] });
        events.push('requester-admitted');
        const stopped = new AbortController(); stopped.abort();
        return { ...request.context, signal: stopped.signal };
      } } : {}),
      readSession: async () => ({ metadata, revision }),
      writeInstance: async (_ref, instance) => { metadata = { ...metadata, work: { ...metadata.work as object, templateInstance: instance } }; revision++; events.push('instance-written'); },
      ...(report ? { reportAcceptedVersion: async (input: { artifactId: string; copyId: string; acceptedVersion: string }) => {
        expect(input).toEqual({ artifactId: releaseId, copyId: instanceSessionId, acceptedVersion: '1.0.0' });
        events.push('reported'); throw new Error('Author status transport unavailable');
      } } : {}),
    },
  });
  const executor = createActionExecutor({ botTemplateAction: execute,
    mcpServerAction: createMcpServerActionExecuteV1({
      readCatalog: () => loadMcpServerCatalogV1({ mode: 'plain', material: null, readRow: async () => ({ status: 'present', revision: catalogState.revision, content: { t: 'plain', v: catalogState.value } }) }),
      mutate: (change, expectedRevision) => commitMcpServerCatalogMutationV1({ catalog: catalogState.value, revision: catalogState.revision, change, scope: null,
        writeCatalog: async candidate => { if (candidate.expectedRevision !== catalogState.revision || expectedRevision !== catalogState.revision) return { status: 'conflict', revision: catalogState.revision };
          catalogState.value = candidate.catalog; return { status: 'updated', revision: ++catalogState.revision, cursor: catalogState.revision }; } }),
      machine: async () => { throw new Error('Template MCP import never starts code'); },
    }),
    sessionCapabilities: {
      readSession: async () => ({ metadata, sessionRunning: false, agent: { vendorResume: 'supported', skillsLiveReload: 'supported' }, launchRestart: 'automatic' }),
      resolveItem: async ({ id }) => id,
      writeMetadata: async ({ update }) => { metadata = readRecord(update(metadata)); revision++; return 'updated'; },
    },
    isApprovalExecutionOriginCurrent: async () => true,
    approvalsCreate: async ({ request }) => { approval = ApprovalRequestV2Schema.parse(request); return { artifactId: 'copy-approval' }; },
    approvalsGet: async () => approval && structuredClone(approval),
    approvalsUpdate: async ({ request }) => {
      if (!approval) throw new Error('Missing copy approval');
      const next = ApprovalRequestV2Schema.parse(request);
      const transition = decideApprovalRequestTransition(approval, next);
      if (!transition.ok) return transition;
      approval = next;
      return { ok: true };
    },
    ...(operations ? { runActionOperation: async (request: Parameters<NonNullable<import('../../actions/executor/types.js').ActionExecutorDeps['runActionOperation']>>[0]) => {
      events.push(`operation:${request.actionId}`); return request.execute(request.context);
    } } : {}),
    prepareBotTemplateInstantiation: request => execute.prepareInstantiation(request),
    promptDocCreate: input => createPromptDocInLibrary({ store, request: input }),
    memoryLibrary: { serverId: 'home', store, randomId: () => 'seed-fact',
      readSession: async () => ({ metadata, revision }),
      readExposure: async artifactId => ({ grants: { artifactId, ownerAccountId: 'recipient', access: 'owner', grants: [] }, publicShares: null }),
    },
    skillActionExecute: ({ actionId, input, context }) => createSkillActionExecuteV1({ store, skillRules,
      randomId: () => 'rule', savedBy: artifactSavedByFromActionContextV1(context),
      creationSessionId: context.invocationServices?.templateSkillSessionId,
      includeInSession: (sid, id) => setSessionCapabilityV1({ request: { sessionId: sid, kind: 'skill', id, state: 'on' }, context,
        port: { readSession: async () => ({ metadata, sessionRunning: false,
          agent: { vendorResume: 'supported', skillsLiveReload: 'supported' }, launchRestart: 'automatic' }),
          resolveItem: async () => id, writeMetadata: async ({ update }) => {
            if (failSkillWrite) throw new Error('Session persistence unavailable');
            metadata = readRecord(update(metadata)); revision++; return 'updated';
          } } }),
    })(actionId, input, { surface: context.surface ?? null }, context.signal),
    sessionStateFieldSet: async write => { if (write.fieldId !== 'intent.context') throw new Error('Unexpected field');
      if (write.expectedMetadataRevision !== revision) return { ok: false, errorCode: 'revision_conflict', error: 'revision_conflict' };
      metadata = writeSessionContextIntentV1ToMetadata(metadata, write.value); revision++; events.push('instructions-attached'); return { ok: true, version: revision }; },
    sessionSpawnNew: async (input, continuation) => {
      if (setup) {
        expect(continuation?.machineSetup).toMatchObject({ items: [{ kind: 'softwareRecipe', selection: {
          ref: { pluginId: 'test.tools', recipeId: 'git', revision: '1' }, inputs: {},
        } }] });
        expect(input.connectedServices).toMatchObject({ v: 2, bindingsByServiceId: {
          'happier.scm.forge.github/github-account': { source: 'connected', profileId: 'recipient-profile' },
        } });
      }
      births++;
      metadata = { bot: input.identity?.bot, createdAsBot: input.identity?.createdAsBot,
        ...(input.identity?.botFace ? { botFace: input.identity.botFace } : {}), summary: { text: input.title } };
      events.push('birth');
      try { await continuation?.beforeLaunch({ sessionId: instanceSessionId, disposition: 'created', metadataRevision: revision }); }
      catch (error) {
        if (!failSkillWrite) throw error;
        // The ordinary creation adapter projects a failed callback to a typed launch result.
        return { type: 'error', code: 'spawn_failed', retryable: true };
      }
      expect(metadata).toMatchObject({ bot: { kind: 'bot' }, createdAsBot: true,
        work: { templateInstance: { acceptedVersion: '1.0.0', acceptedBase: { serverId: 'home', artifactId: instanceBaseId } } } });
      expect(continuation?.hostOnboarding).toEqual({ templateName: 'Helper', templateVersion: '1.0.0', firstTask: 'Review my change' });
      expect(input.permissionMode).toBe('default');
      if (observeCommit) expect(input.observeSessionCommit).toBeUndefined();
      if (!awaiting) { launches++; events.push('launch'); }
      return { type: 'success', disposition: 'created', sessionId: instanceSessionId, executionTarget: input.executionTarget,
        organizationPlacement: { folderId: null, tagIds: [] }, initialInput: awaiting ? { status: 'accepted', localId: 'host-onboarding' } : { status: 'notRequested' } };
    },
  });
  const input = { source: { kind: 'artifact', serverId: 'home', artifactId: releaseId }, expectedVersion: '1.0.0',
    ...(setup ? { setup: { software: [{ key: 'git', selection: { action: 'install', inputs: {} } }],
      accounts: [{ key: 'github', selection: { action: 'connect', binding: { source: 'connected', selection: 'profile', profileId: 'recipient-profile' } } }],
      mcpServers: [{ key: 'docs', selection: { action: 'bind', inputs: { token: { t: 'savedSecret', secretId: 'recipient-secret' } } } }] } } : {}),
    expectedRevision: { headerVersion: 1, bodyVersion: 1 }, creation: { creationKey: 'template-copy-1',
      ...(observeCommit ? { observeSessionCommit: true as const } : {}),
      executionTarget: { serverId: 'home', machineId: 'machine' }, directory: { kind: 'managed' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } }, permissionMode: 'default' } };
  // The designed Create dispatch records the exact completed native confirmation.
  const run = (confirmed = true) => executor.execute('template.instantiate', input, { surface: 'ui', authority: 'present_user', serverId: 'home', serverIdentityId: 'home', runtimeAccountId: 'recipient',
    actionCaller: { kind: 'host' }, actionRequestId: 'copy-request', ...(confirmed ? { presentUserConfirmation: {
      actionId: 'template.instantiate', inputDigest: computeActionInputApprovalDigestV1('template.instantiate', input),
      accountId: 'recipient', serverId: 'home', requestId: 'copy-request', target: null,
    } } : {}),
    actionsSettings: ActionsSettingsV1Schema.parse({ v: 1,
      ...(!confirmed ? { actions: { 'template.instantiate': { approvalRequiredSurfaces: ['ui'] } } } : {}) }) });
  const reject = () => executor.execute('approval.request.decide', { artifactId: 'copy-approval', decision: 'reject' }, {
    surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'home', serverIdentityId: 'home',
    runtimeAccountId: 'recipient', actionRequestId: 'reject-copy', actionsSettings: ActionsSettingsV1Schema.parse({ v: 1 }),
  });
  return { run, reject, approval: () => approval, selectedRelease, input, events, docs, boundary, catalog: () => catalogState.value, metadata: () => metadata, counts: () => ({ births, launches }) };
}

describe('template instantiation through ordinary creation', () => {
  it.each([true, false])('rejects invalid %s override/released art before the ordinary birth', async override => {
    const f = fixture();
    const face = { shape: { v: 1, fill: ['M0 0 H90 V90 Z'], mouth: [45, 46, 0.8] } };
    if (override) Object.assign(f.input, { face });
    else {
      const row = f.boundary.rows.get(releaseId)!;
      const artifact = { v: 1 as const, state: 'released' as const, release: { ...release, content: {
        ...release.content, identity: { ...release.content.identity, face },
      } } };
      f.boundary.rows.set(releaseId, { ...row, header: row.header, body: JSON.stringify(artifact) });
    }
    expect(await f.run()).toMatchObject({ ok: false });
    expect(f.counts()).toEqual({ births: 0, launches: 0 });
  });

  it('normalizes an explicit copy face at admission before ordinary birth', async () => {
    const f = fixture();
    Object.assign(f.input, { face: { shape: { v: 1, fill: ['M20 0 L100 0 L100 80 L20 80 Z'], mouth: [60, 46, 0.8] } } });
    expect(await f.run()).toMatchObject({ ok: true });
    expect(f.metadata().botFace).toMatchObject({ shape: { mouth: [45, 46, 0.8] } });
    expect(f.counts()).toEqual({ births: 1, launches: 1 });
  });

  it('carries a generated outline from the released template into the independent Bot birth', async () => {
    const f = fixture();
    const face = { body: 'tall', shape: { v: 1, fill: ['M 5 15 L 85 15 L 85 85 L 5 85 Z'],
      mouth: [45, 55, 0.8], origin: 'surprise' } } satisfies SessionBotFaceV1;
    const row = f.boundary.rows.get(releaseId);
    if (!row) throw new Error('Missing template release fixture');
    const artifact = { v: 1 as const, state: 'released' as const, release: { ...release, content: {
      ...release.content, identity: { ...release.content.identity, face },
    } } };
    f.boundary.rows.set(releaseId, { ...row, header: projectBotTemplateArtifactHeaderV1(artifact), body: JSON.stringify(artifact) });
    expect(await f.run()).toMatchObject({ ok: true });
    expect(f.metadata().botFace).toEqual(face);
    expect(f.counts()).toEqual({ births: 1, launches: 1 });
  });

  it('refuses raw launch environment before finite recipient birth or content writes', async () => {
    const f = fixture();
    Object.assign(f.input.creation, { environmentVariables: { API_TOKEN: 'local-only-value' } });
    expect(await f.run()).toMatchObject({ ok: false, errorCode: 'invalid_request' });
    expect(f.counts()).toEqual({ births: 0, launches: 0 });
    expect(f.docs.size).toBe(0);
  });

  it('makes a second independent Bot copy in the same recipient MCP catalog', async () => {
    const catalog: { value: McpServerCatalogV1; revision: number } = { value: { v: 1, servers: [], bindings: [] }, revision: 0 };
    const first = fixture(false, false, false, false, true, false, false, undefined, false,
      { catalog, baseId, sessionId });
    const secondId = 'ae23f798-230a-42f3-931f-e38b20736333';
    const second = fixture(false, false, false, false, true, false, false, undefined, false,
      { catalog, baseId: secondId, sessionId: 'cm00000000000000000000002' });
    expect(await first.run()).toMatchObject({ ok: true });
    const copied = await second.run();
    expect(copied, JSON.stringify(copied)).toMatchObject({ ok: true });
    expect(catalog.value.servers.map(entry => entry.id)).toEqual([baseId, secondId]);
    expect(new Set(catalog.value.servers.map(entry => entry.name)).size).toBe(2);
    expect(catalog.value.bindings).toEqual([]);
    expect(readSessionCapabilitySelectionFromMetadataV1(first.metadata()).mcp?.forceIncludeServerIds).toEqual([baseId]);
    expect(readSessionCapabilitySelectionFromMetadataV1(second.metadata()).mcp?.forceIncludeServerIds).toEqual([secondId]);
  });
  it('uses the enriched requester context before the first birth or content effect', async () => {
    const f = fixture(false, false, false, false, true, false, false, undefined, true);
    expect(await f.run()).toMatchObject({ ok: false });
    expect(f.events).toEqual(['requester-admitted']);
    expect(f.counts()).toEqual({ births: 0, launches: 0 });
    expect(f.docs.size).toBe(0);
  });
  it('copies an admitted live link without a grant, follows nothing and reports no adoption', async () => {
    const f = fixture(true, false, false, false, false, true, false, 'matching');
    f.boundary.rows.delete(releaseId);
    expect(await f.run()).toMatchObject({ ok: true, result: { type: 'success', sessionId } });
    expect(f.counts()).toEqual({ births: 1, launches: 1 });
    expect(f.metadata()).toMatchObject({ work: { templateInstance: { source: f.input.source,
      acceptedVersion: '1.0.0', acceptedBase: { serverId: 'home', artifactId: baseId }, follow: false } } });
    expect(f.events).not.toContain('reported');
    expect(f.boundary.rows.get(baseId)?.body).toBe(JSON.stringify({ v: 1, state: 'released', release: f.selectedRelease }));
  });
  it('refuses a transient admission for another source before creating recipient resources', async () => {
    const f = fixture(false, false, false, false, false, true, false, 'mismatched');
    expect(await f.run()).toMatchObject({ ok: false });
    expect(f.counts()).toEqual({ births: 0, launches: 0 });
    expect(f.events).not.toContain('reported');
    expect(f.docs.size).toBe(0);
  });
  it('reports accepted version only after successful launch and ignores status transport failure', async () => {
    const f = fixture(false, false, false, false, false, true);
    expect(await f.run()).toMatchObject({ ok: true });
    expect(f.events.slice(-2)).toEqual(['launch', 'reported']);
    const failed = fixture(true, false, false, true, false, true);
    expect(await failed.run()).toMatchObject({ ok: false });
    expect(failed.events).not.toContain('reported');
  });
  it('does not report Pending onboarding admission as completed setup and launch', async () => {
    const f = fixture(false, false, false, false, false, true, true);
    expect(await f.run()).toMatchObject({ ok: true, result: { type: 'success', initialInput: { status: 'accepted' } } });
    expect(f.counts()).toEqual({ births: 1, launches: 0 });
    expect(f.events).not.toContain('reported');
  });
  it('carries one merged software setup and recipient Connect selection through ordinary creation', async () => {
    const f = fixture(false, false, false, false, true);
    const result = await f.run();
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { type: 'success', sessionId } });
    expect(f.counts()).toEqual({ births: 1, launches: 1 });
    expect(f.catalog()).toMatchObject({ bindings: [], servers: [{ remote: { headers: { Authorization: { t: 'savedSecret', secretId: 'recipient-secret' } } } }] });
    expect(readSessionCapabilitySelectionFromMetadataV1(f.metadata()).mcp?.forceIncludeServerIds).toEqual([baseId]);
    expect(f.metadata()).toMatchObject({ work: { templateInstance: { mcpServerIds: { docs: baseId } } } });
  });
  it('seeds real Bot memory and binary skill content with recipient inclusion and instantiator attribution before launch', async () => {
    const f = fixture(true);
    const result = await f.run();
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { type: 'success', sessionId } });
    expect(f.counts()).toEqual({ births: 1, launches: 1 });
    expect(f.metadata()).toMatchObject({ work: { templateInstance: { skillIds: { guide: 'doc-3' }, follow: true } } });
    expect(f.docs.get('doc-2')?.body).toContain('Prefer small changes.');
    expect(f.docs.get('doc-3')).toMatchObject({ savedBy: { kind: 'person', accountId: 'recipient' } });
    expect(JSON.parse(f.docs.get('doc-3')!.body!)).toMatchObject({ entries: [
      { path: 'SKILL.md', contentBase64: 'LS0tCm5hbWU6IGd1aWRlCmRlc2NyaXB0aW9uOiBndWlkZQotLS0KSGVscC4=' },
      { path: 'images/example.bin', contentBase64: 'AAH//g==', contentKind: 'binary', unixMode: 0o755 },
    ] });
    expect(readSessionCapabilitySelectionFromMetadataV1(f.metadata()).skills.forceIncludeSkillIds).toEqual(['doc-3']);
    expect(f.metadata()).toMatchObject({ work: { promptStack: [
      { id: 'session.instructions', ref: { artifactId: 'doc-1' } },
      { id: 'session.memory', ref: { artifactId: 'doc-2' } },
    ] } });
    expect(f.boundary.reads).toEqual([releaseId]);
  });
  it('runs the captured composition under the existing parent operation before its first birth effect', async () => {
    const f = fixture(false, true);
    expect(await f.run()).toMatchObject({ ok: true });
    expect(f.events.filter(event => event === 'operation:template.instantiate')).toHaveLength(1);
    expect(f.events.indexOf('operation:template.instantiate')).toBeLessThan(f.events.indexOf('birth'));
  });
  it('awaits composition and launch instead of publishing the child-only early Session observation', async () => {
    const f = fixture(false, false, true);
    const result = await f.run();
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { type: 'success', sessionId } });
    expect(f.counts()).toEqual({ births: 1, launches: 1 });
  });
  it('retains the born Session and already-created skill when Session inclusion fails before launch', async () => {
    const f = fixture(true, false, false, true);
    expect(await f.run()).toMatchObject({ ok: false, errorCode: 'skill_content_unavailable',
      details: { sessionId, resourceIds: ['doc-1', 'doc-2', 'doc-3'] } });
    expect(f.counts()).toEqual({ births: 1, launches: 0 });
    expect(f.metadata()).not.toHaveProperty('work.templateInstance');
    expect(f.boundary.rows.has(baseId)).toBe(false);
  });
  it('commits recipient content and base before real launch, under one addressed source admission', async () => {
    const f = fixture();
    expect(await f.run()).toMatchObject({ ok: true, result: { type: 'success', sessionId } });
    expect(f.counts()).toEqual({ births: 1, launches: 1 });
    expect(f.boundary.reads).toEqual([releaseId]);
    expect(f.events).toEqual(['birth', 'instructions-created', 'instructions-attached', 'instance-written', 'launch']);
    expect(JSON.parse(f.docs.get('doc-1')!.body!)).toMatchObject({ markdown: release.content.instructions.markdown });
    expect(JSON.parse(f.boundary.rows.get(baseId)!.body!)).toEqual({ v: 1, state: 'released', release });
  });
  it('rejects a changed release before birth or content writes', async () => {
    const f = fixture(); f.input.expectedVersion = '2.0.0';
    expect(await f.run()).toMatchObject({ ok: false, errorCode: 'version_mismatch' });
    expect(f.counts()).toEqual({ births: 0, launches: 0 });
    expect(f.events).toEqual([]);
  });
  it('reviews the complete release once and declining creates no Bot or recipient content', async () => {
    expect(isApprovalRequiredByActionsSettings('template.instantiate', ActionsSettingsV1Schema.parse({ v: 1 }),
      { surface: 'agent', authority: 'account_automation' })).toBe(true);
    const f = fixture(true);
    expect(await f.run(false)).toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'copy-approval' } });
    expect(f.approval()).toMatchObject({ preview: { hostReviewedContent: { release: f.selectedRelease } } });
    expect(await f.reject()).toMatchObject({ ok: true });
    expect(f.approval()).toMatchObject({ status: 'rejected' });
    expect(f.counts()).toEqual({ births: 0, launches: 0 });
    expect(f.docs.size).toBe(0);
    expect(f.events).toEqual([]);
    expect(f.boundary.rows.has(baseId)).toBe(false);
    expect(f.boundary.reads).toEqual([releaseId]);
  });
});
