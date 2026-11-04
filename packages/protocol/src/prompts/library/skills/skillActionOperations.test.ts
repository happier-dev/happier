import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { decodeBase64, encodeBase64 } from '../../../crypto/base64.js';
import type { PromptLibraryArtifactStore, PromptLibraryStoredArtifact } from '../promptLibraryActionOperations.js';
import type { SkillRulesActionPortV1 } from '../skillRulesActionsV1.js';
import type { SkillRuleV1 } from '../../../reach/reachRuleV1.js';
import { createSkillActionExecuteV1 } from './skillActionOperations.js';
import { SKILL_ACTION_INPUT_SCHEMAS_V1, SKILL_ACTION_OUTPUT_SCHEMAS_V1, SkillInstallAcknowledgedEffectsV1Schema } from './skillActionSchemasV1.js';
import { readSkillFrontmatterV1, readSkillLockV1 } from './skillLibraryItemV1.js';
import { readSkillZipFilesV1 } from './skillZipV1.js';
import { createRegistryHostV1 } from '../../../registries/registryHostV1.js';
import { computeGitBlobShaV1, computeGitTreeShaV1 } from '../../../registries/registryGitTreeV1.js';
import type { RegistryHttpV1 } from '../../../registries/formats/registryFormatAdapterV1.js';
import type { RegistrySourceDescriptorV1 } from '../../../registries/registrySourcesV1.js';
import type { FoundSkillBundleV1 } from './foundSkillTransferV1.js';
import { FIRST_PARTY_SKILLS_V1, buildFirstPartySkillSeedRuleV1 } from './firstPartySkillsV1.js';
import { computePromptBundleDigestV1 } from '../promptLibraryDigests.js';
import { readSkillInLibrary } from '../promptLibraryActionOperations.js';
import { SkillReadResultV1Schema } from './skillReadV1.js';
import retainedFrontmatter from '../../../../fixtures/0.2-retained-skill-frontmatter.json';
import { estimateTokensV1 } from '../../../capabilities/estimateTokensV1.js';
import { readSkillLibraryCatalog } from './readSkillLibraryCatalog.js';
import { listArtifactHeadersV1 } from '../../../artifacts/artifactListSelectionV1.js';
import { buildApprovalExecutionOriginV1, createActionExecutor, type ActionExecutorContext, type ActionExecutorDeps } from '../../../actions/actionExecutor.js';
import { ApprovalRequestV2Schema, type ApprovalRequest } from '../../../approvals/approvalRequestV1.js';
import { createBlockingApprovalCoordinator } from '../../../actions/blockingApprovalCoordinator.js';
import { prepareArtifactHeaderForBodyV1, prepareArtifactHeaderForRevisionV1 } from '../../../artifacts/artifactHeaderRestorationV1.js';

const markdown = '---\nname: sample\ndescription: A useful skill\n---\nInstructions';
const included = { ok: true, state: 'on', previous: 'inherit', applyTiming: { t: 'next_turn' } } as const;
const files = [{ path: 'SKILL.md', contentBase64: encodeBase64(new TextEncoder().encode(markdown), 'base64'), contentKind: 'utf8' as const }];
type RegistryPorts = Pick<ReturnType<typeof createRegistryHostV1>, 'readRegistryItem' | 'readRegistrySource' | 'filesForPointer' | 'readLinkSkills' | 'fetchLinkSkillFiles'>;
function gitRegistryHarness() {
  const initial = '1'.repeat(40), latest = '2'.repeat(40); let head = initial;
  const original = [{ path: 'SKILL.md', unixMode: 0o644 as const, bytes: new TextEncoder().encode(markdown) }];
  const upstream = [{ ...original[0]!, bytes: new TextEncoder().encode(markdown + '\nUpstream') }];
  const source: RegistrySourceDescriptorV1 = { id: 'repo', title: 'Repo', format: 'git', kinds: ['skill'], url: 'https://github.com/a/b', enabled: true, addedAt: 0, origin: { kind: 'user' }, removable: true };
  const atUrl = (url: string) => url.includes(latest) ? upstream : original;
  // GitHub HTTP is the external boundary; registry decoding, pinning and integrity checks stay real.
  const http: RegistryHttpV1 = {
    getJson: async url => {
      if (url.includes('marketplace.json')) return { ok: false, status: { state: 'unreachable' } };
      if (url.includes('/commits/')) return { ok: true, fetchedAt: 1, value: { sha: url.endsWith('/HEAD') ? head : decodeURIComponent(url.split('/').at(-1)!) } };
      if (url.includes('/git/trees/')) { const files = atUrl(url); return { ok: true, fetchedAt: 1, value: { sha: computeGitTreeShaV1(files), tree: files.map(file => ({ path: file.path, mode: '100644', type: 'blob', sha: computeGitBlobShaV1(file.bytes), size: file.bytes.length })) } }; }
      return { ok: true, fetchedAt: 1, value: { name: 'b' } };
    },
    getText: async url => ({ ok: true, fetchedAt: 1, value: new TextDecoder().decode(atUrl(url)[0]!.bytes) }),
    getBytes: async url => ({ ok: true, fetchedAt: 1, value: atUrl(url)[0]!.bytes }),
  };
  return { initial, latest, source, registry: createRegistryHostV1({ host: 'node', http, readSources: async () => [source] }),
    setHead: (commit: string) => { head = commit; } };
}
function harness(registry?: RegistryPorts, foundReader?: (machineId: string, path: string) => Promise<FoundSkillBundleV1>) {
  // These in-memory ports stand for the independently committed Artifact/row/session stores.
  const artifacts = new Map<string, PromptLibraryStoredArtifact>();
  let usage: Record<string, number> = {}, usageUnavailable = false, rules: SkillRuleV1[] = [], rowRevision = 0, creates = 0, createAttempts = 0, failCreateAt = 0, failRules = false, failSession = false, failCreatedRead = false, failUpdatedRead = false;
  const order: string[] = [], includes = new Map<string, string[]>();
  const store: PromptLibraryArtifactStore = {
    list: async () => ({ coverage: 'complete', items: [...artifacts.values()].map(a => ({ id: a.id, header: a.header, updatedAtMs: 1, owned: true })) }),
    read: async id => failCreatedRead && artifacts.has(id) ? null : artifacts.get(id) ?? null,
    create: async input => { if (++createAttempts === failCreateAt) throw Object.assign(new Error('quota_exceeded'), { code: 'quota_exceeded' });
      const id = `skill-${++creates}`; artifacts.set(id, { id, ...input, owned: true, revision: { headerVersion: 1, bodyVersion: 1 } }); order.push('content'); return id; },
    update: async input => { const current = artifacts.get(input.artifactId)!;
      if (JSON.stringify(input.expectedRevision) !== JSON.stringify(current.revision)) throw Object.assign(new Error('version_mismatch'), { code: 'version_mismatch' });
      const revision = { headerVersion: current.revision.headerVersion + 1, bodyVersion: current.revision.bodyVersion + 1 };
      artifacts.set(current.id, { ...current, header: input.header, body: input.body, revision });
      if (failUpdatedRead) { failCreatedRead = true; return; } return { revision }; },
    delete: async input => { artifacts.delete(input.artifactId); order.push('delete'); },
  };
  const skillRules: SkillRulesActionPortV1 = {
    serverId: 'home', assertCurrent: () => {}, ruleWriteContext: () => ({ nowMs: 1, newId: () => 'rule' }),
    listSkills: async () => [...artifacts.values()].map(a => ({ id: a.id, name: 'sample' })).concat(FIRST_PARTY_SKILLS_V1.map(skill => ({ id: skill.skillId, name: skill.name }))),
    readCatalog: async (_signal, key) => { if (key === 'skill-usage' && usageUnavailable) throw new Error('Usage row unavailable');
      return { catalog: { status: 'ready', rows: [{ record: { key: 'skill-rules', value: { v: 1, rules } }, revision: rowRevision },
      { record: { key: 'skill-usage', value: { v: 1, lastUsedAt: usage } }, revision: 1 }], tombstones: [], diagnostics: [] } }; },
    writeRecord: async input => { if (failRules) throw new Error('row transport unavailable'); if (input.expectedRevision !== rowRevision) return { status: 'conflict', revision: rowRevision };
      if (input.record.key === 'skill-rules') rules = input.record.value.rules; order.push('rules'); return { status: 'updated', revision: ++rowRevision, cursor: rowRevision }; },
  };
  const execute = createSkillActionExecuteV1({ store, skillRules, randomId: () => 'rule', nowMs: () => 1,
    ...(foundReader ? { readFoundSkillBundle: foundReader } : {}),
    ...(registry ? { readRegistryItem: registry.readRegistryItem, readRegistrySource: registry.readRegistrySource,
      fetchRegistrySkillFiles: registry.filesForPointer, readLinkSkills: registry.readLinkSkills, fetchLinkSkillFiles: registry.fetchLinkSkillFiles } : {}),
    includeInSession: async (sessionId, id) => { if (failSession) return { ok: false }; includes.set(sessionId, [...(includes.get(sessionId) ?? []), id]); order.push('session'); return { ok: true }; },
  });
  return { execute, store, skillRules, artifacts, includes, order, rules: () => rules, setRules: (value: SkillRuleV1[]) => { rules = value; }, creates: () => creates, usage: (value: Record<string, number>) => { usage = value; },
    usageUnavailable: () => { usageUnavailable = true; },
    failCreateAt: (value: number) => { failCreateAt = value; },
    failCreatedRead: (value: boolean) => { failCreatedRead = value; },
    failUpdatedRead: (value: boolean) => { failUpdatedRead = value; },
    failRules: (value: boolean) => { failRules = value; }, failSession: (value: boolean) => { failSession = value; } };
}
describe('skill library Actions', () => {
  it('lists selected summarized skills without reading bundle bodies or unrelated headers', async () => {
    const h = harness();
    const header = { v: 1, kind: 'prompt_bundle.v2', title: 'sample', bundleSchemaId: 'skills.skill_md_v1' };
    const body = JSON.stringify({ v: 1, entries: files, createdAtMs: 1, updatedAtMs: 1 });
    const provenance = { savedBy: { kind: 'person', accountId: 'owner' }, skillCreator: { kind: 'agent', accountId: 'owner', sessionId: 'bot' } } as const;
    const stored = { id: 'selected', header: prepareArtifactHeaderForBodyV1(header, body), revision: { headerVersion: 3, bodyVersion: 2 }, body: null, provenance, owned: true };
    const headerReads: string[][] = [];
    let bodyReads = 0, inventoryReads = 0;
    const execute = createSkillActionExecuteV1({ store: { ...h.store,
      list: async () => { inventoryReads++; return { items: [], coverage: 'complete' }; },
      readHeadersByIds: async (ids: readonly string[]) => { headerReads.push([...ids]); return ids.map(id => ({ status: 'fulfilled' as const, value: id === stored.id ? stored : null })); },
      read: async () => { bodyReads++; throw new Error('body must remain unopened'); },
    }, skillRules: h.skillRules, randomId: () => 'rule', includeInSession: async () => included });
    const result = await execute('skills.list', { skillIds: ['selected', 'selected'] }, { surface: 'ui' });
    expect(result).toMatchObject({ items: [{ skillId: 'selected', name: 'sample', revision: '3:2', creator: provenance.skillCreator, cost: { descriptionTokens: 4, bodyTokens: 3 } }] });
    expect(headerReads).toEqual([['selected']]);
    expect({ bodyReads, inventoryReads }).toEqual({ bodyReads: 0, inventoryReads: 0 });
  });
  it.each([250, 500, 1000])('opens only legacy bodies while listing %i skills and keeps selected demand fixed', async size => {
    const h = harness();
    const inventory = Array.from({ length: size }, (_, index): PromptLibraryStoredArtifact => {
      const name = `sample-${index}`;
      const skillFiles = [{ ...files[0]!, contentBase64: encodeBase64(new TextEncoder().encode(markdown.replace('name: sample', `name: ${name}`)), 'base64') },
        { path: 'assets/icon.bin', contentBase64: 'AAECAwQFBgcICQ==', contentKind: 'binary' as const }];
      const body = JSON.stringify({ v: 1, entries: skillFiles, createdAtMs: 1, updatedAtMs: 1 });
      const header = { v: 1, kind: 'prompt_bundle.v2', title: name, bundleSchemaId: 'skills.skill_md_v1' };
      return { id: `skill-${index}`, header: index === 0 ? header : prepareArtifactHeaderForBodyV1(header, body), body,
        revision: { headerVersion: 1, bodyVersion: 1 }, owned: true,
        provenance: { savedBy: { kind: 'person', accountId: 'owner' }, skillCreator: { kind: 'agent', accountId: 'owner', sessionId: `bot-${index % 2}` } } };
    });
    const byId = new Map(inventory.map(item => [item.id, item]));
    let pages = 0;
    const bodyReads: string[][] = [], selectedHeaders: string[][] = [];
    const execute = createSkillActionExecuteV1({ store: { ...h.store,
      list: async options => {
        pages++;
        const offset = Number(options?.cursor ?? 0), limit = options?.limit ?? 500;
        const items = inventory.slice(offset, offset + limit).map(({ body: _body, ...item }) => ({ ...item, updatedAtMs: 1 }));
        return { items, coverage: 'complete', ...(offset + items.length < size ? { nextCursor: String(offset + items.length) } : {}) };
      },
      read: async () => { throw new Error('The batched content owner must serve legacy rows'); },
      readMany: async ids => { bodyReads.push([...ids]); return ids.map(id => ({ status: 'fulfilled' as const, value: byId.get(id) ?? null })); },
      readHeadersByIds: async ids => {
        selectedHeaders.push([...ids]);
        return ids.map(id => { const item = byId.get(id); return { status: 'fulfilled' as const, value: item ? { ...item, body: null } : null }; });
      },
    }, skillRules: h.skillRules, randomId: () => 'rule', includeInSession: async () => included });
    const full = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.list'].parse(await execute('skills.list', {}, { surface: 'ui' }));
    expect(full.items.filter(item => byId.has(item.skillId))).toHaveLength(size);
    expect(pages).toBe(Math.ceil(size / 500));
    expect(bodyReads).toEqual([['skill-0']]);
    pages = 0; bodyReads.length = 0;
    const selection = ['skill-0', 'skill-1', 'skill-2'];
    const selected = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.list'].parse(await execute('skills.list', { skillIds: selection }, { surface: 'ui' }));
    expect(selected.items.map(item => item.skillId).sort()).toEqual(selection);
    expect(selected.items.every(item => item.creator?.kind === 'agent')).toBe(true);
    expect({ pages, bodyReads, selectedHeaders }).toEqual({ pages: 0, bodyReads: [['skill-0']], selectedHeaders: [selection] });
  });
  it('rebuilds the skill summary on generic writes and restores without carrying private creator into content', () => {
    const header = { v: 1, kind: 'prompt_bundle.v2', title: 'sample', bundleSchemaId: 'skills.skill_md_v1', skillListSummary: { stale: true } };
    const body = JSON.stringify({ v: 1, entries: [...files, { path: 'assets/icon.bin', contentBase64: 'AAEC', contentKind: 'binary' }], createdAtMs: 7, updatedAtMs: 9 });
    const written = prepareArtifactHeaderForBodyV1(header, body);
    expect(written.skillListSummary).toMatchObject({ v: 1, name: 'sample', description: 'A useful skill', createdAt: 7, trust: 'has_files', userInvocable: true });
    const restored = prepareArtifactHeaderForRevisionV1({ artifactId: 'selected', header, body,
      expectedRevision: { headerVersion: 3, bodyVersion: 2 }, nextRevision: { headerVersion: 4, bodyVersion: 3 } });
    expect(restored.skillListSummary).toEqual(written.skillListSummary);
    expect(JSON.stringify(written)).not.toContain('skillCreator');
  });
  it.each(['default', 'explicit', 'partial', 'include_failure'] as const)('keeps private registry install intent across the source transport: %s', async mode => {
    const upstream = gitRegistryHarness(), h = harness(upstream.registry);
    const input = { source: { kind: 'registry' as const, sourceId: upstream.source.id, itemId: '', version: upstream.initial },
      ...(mode === 'explicit' ? { where: { kind: 'write' as const, write: { place: { t: 'machine' as const, machineId: 'chosen' }, state: 'on' as const } } } : {}) };
    const origin = buildApprovalExecutionOriginV1({ actionId: 'skills.install', input, targetSessionId: 'creating-session',
      context: { surface: 'agent', authority: 'account_automation', serverId: 'home', actionRequestId: 'private-install',
        actionCaller: { kind: 'session', sessionId: 'creating-session', starterDepth: 0, turnDepth: 0 } } });
    if (!origin) throw new Error('Missing canonical approval origin');
    const local = createSkillActionExecuteV1({ store: h.store, skillRules: h.skillRules, randomId: () => 'rule',
      readRegistrySource: async () => ({ ...upstream.source, token: { secretRef: 'private-source-key' } }),
      readRegistryItem: upstream.registry.readRegistryItem,
      // The private source is reachable only on the existing Node transport.
      fetchRegistrySkillFiles: async () => { throw new Error('Private bytes unavailable on this client'); },
      executeRegistryInstall: async request => {
        const result = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.install'].parse(await h.execute('skills.install', request, { surface: 'ui' }));
        if (!('skillIds' in result)) throw new Error('Missing source receipt');
        return mode === 'partial'
          ? { ok: false as const, errorCode: 'content_write_failed', error: 'content_write_failed', details: { skillIds: result.skillIds, incomplete: [] } }
          : { ok: true as const, result };
      },
      includeInSession: async (sessionId, skillId) => {
        if (mode === 'include_failure') return { ok: false };
        h.includes.set(sessionId, [...h.includes.get(sessionId) ?? [], skillId]); return { ok: true };
      },
    });
    const output = await local('skills.install', input, { surface: 'ui', sessionId: 'focused-session',
      approvedActionReplay: { artifactId: 'approval', origin } });
    if (mode === 'partial') expect(output).toMatchObject({ ok: false, errorCode: 'content_write_failed', details: { skillIds: ['skill-1'], incomplete: [] } });
    else expect(output).toMatchObject({ skillIds: ['skill-1'], includedInSessionId: mode === 'default' ? 'creating-session' : null });
    if (mode === 'include_failure') expect(output).toMatchObject({ incomplete: [{ skillId: 'skill-1', step: 'session_include' }] });
    expect(h.rules()).toEqual(mode === 'explicit' ? [expect.objectContaining({ target: { t: 'machine', machineId: 'chosen' }, enabled: true })] : []);
    expect(h.includes.get('creating-session')).toEqual(mode === 'default' || mode === 'partial' ? ['skill-1'] : undefined);
    expect(h.includes.has('focused-session')).toBe(false);
    expect(h.creates()).toBe(1);
  });
  it.each(['approved', 'waived', 'explicit', 'held'] as const)('keeps Session-created skills scoped through %s execution', async mode => {
    const h = harness();
    const coordinator = createBlockingApprovalCoordinator();
    onTestFinished(() => coordinator.dispose());
    let waiterReady!: () => void;
    const ready = new Promise<void>(resolve => { waiterReady = resolve; });
    let approval: ApprovalRequest | null = null;
    const contexts: ActionExecutorContext[] = [];
    const deps: ActionExecutorDeps = {
      // Independently committed Artifact/row/Session persistence are the boundaries.
      approvalsCreate: async ({ request }) => { approval = ApprovalRequestV2Schema.parse(request); return { artifactId: 'approval' }; },
      approvalsGet: async () => approval,
      approvalsUpdate: async ({ request }) => { approval = ApprovalRequestV2Schema.parse(request);
        coordinator.notifyApprovalUpdated({ artifactId: 'approval', request: approval }); return { ok: true }; },
      isApprovalExecutionOriginCurrent: async () => true,
      ...(mode === 'waived' ? { isActionApprovalRequired: () => false } : {}),
      skillActionExecute: async ({ actionId, input, context }) => {
        contexts.push(context);
        return h.execute(actionId, input, { ...context, surface: context.surface ?? null,
          ...(context.defaultSessionId ? { sessionId: context.defaultSessionId } : {}) }, context.signal);
      },
    };
    const executor = createActionExecutor({ ...deps, approvalsWaitForDecision: async args => {
      const pending = coordinator.waitForDecision(args); waiterReady();
      const decision = await pending;
      return { ...decision, request: ApprovalRequestV2Schema.parse(decision.request) };
    } });
    const source = { kind: 'upload', files };
    if (mode === 'held') await h.execute('skills.install', { source }, { surface: 'ui' });
    const pending = executor.execute('skills.install', { source,
      ...(mode === 'explicit' ? { where: { kind: 'write', write: { place: { t: 'machine', machineId: 'chosen' }, state: 'on' } } } : {}),
    }, { surface: 'mcp', authority: 'account_automation', serverId: 'home', serverIdentityId: 'srv_01234567890123456789012345678901', runtimeAccountId: 'account',
      defaultSessionId: 'creating-session', actionRequestId: 'create-skill',
      actionCaller: { kind: 'session', sessionId: 'creating-session', starterDepth: 0, turnDepth: 0 } });
    void pending.catch(() => {});
    if (mode !== 'waived') {
      const admission = await Promise.race([ready.then(() => 'waiting' as const), pending.then(result => result.ok ? 'completed' : result.errorCode)]);
      expect(admission).toBe('waiting');
      expect(ApprovalRequestV2Schema.parse(approval).executionOriginV1).toMatchObject({
        caller: { kind: 'session', sessionId: 'creating-session' }, surface: 'agent',
      });
      // A different device has the same durable stores, not the originating live waiter.
      const decided = await createActionExecutor(deps).execute('approval.request.decide', { artifactId: 'approval', decision: 'approve' }, {
        surface: 'ui', authority: 'present_user', serverId: 'other-device-profile', serverIdentityId: 'srv_01234567890123456789012345678901', runtimeAccountId: 'account',
        defaultSessionId: 'deciding-session', actionCaller: { kind: 'host' },
      });
      expect(decided, decided.ok ? undefined : decided.errorCode).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
      // The approving person still owns execution; creation provenance grants no authority.
      expect(contexts.at(-1)).toMatchObject({ surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'other-device-profile' });
      await pending;
    } else expect(await pending).toMatchObject({ ok: true, result: { skillIds: ['skill-1'], includedInSessionId: 'creating-session' } });
    if (mode === 'explicit') {
      expect(h.rules()).toEqual([expect.objectContaining({ skillId: 'skill-1', enabled: true, target: { t: 'machine', machineId: 'chosen' } })]);
      expect(h.includes.size).toBe(0);
    } else {
      if (mode !== 'held') expect(h.rules()).toEqual([]);
      expect(h.includes.get('creating-session')).toEqual(['skill-1']);
      expect(h.includes.has('deciding-session')).toBe(false);
    }
    expect(h.creates()).toBe(1);
  });
  it('opens a page through the batched Artifact owner while retaining per-item failures', async () => {
    const h = harness();
    const created = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.create'].parse(await h.execute('skills.create', { name: 'sample', files }, { surface: 'ui' }));
    const artifact = h.artifacts.get(created.skillId)!;
    h.artifacts.set('unreadable', { ...artifact, id: 'unreadable', body: 'invalid' });
    h.artifacts.set('removed', { ...artifact, id: 'removed' });
    const store = { ...h.store,
      // Independent persistent-store transport; domain decoding and projection stay real.
      readMany: async (ids: readonly string[]) => Promise.allSettled(ids.map(async id => id === 'removed' ? null : h.artifacts.get(id) ?? null)),
      read: async () => { throw new Error('Unexpected per-item transport'); },
    };
    const execute = createSkillActionExecuteV1({ store, skillRules: h.skillRules, randomId: () => 'unused', includeInSession: async () => ({ ok: true }) });
    const result = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.list'].parse(await execute('skills.list', {}, { surface: 'ui' }));
    expect(result.items.find(item => item.skillId === created.skillId)).toMatchObject({ name: 'sample', description: 'A useful skill', userInvocable: true });
    expect(result.unavailableItems).toEqual([
      { skillId: 'unreadable', title: 'sample', reason: 'skill_content_unavailable' },
      { skillId: 'removed', title: 'sample', reason: 'not_found' },
    ]);
  });
  it('selects classified skill pages through the real library Action and daemon catalog', async () => {
    const h = harness();
    const created = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.create'].parse(await h.execute('skills.create', { name: 'sample', files }, { surface: 'ui' }));
    const artifact = h.artifacts.get(created.skillId)!;
    if (!artifact.header) throw new Error('Expected the created skill header');
    const skill = { artifactId: artifact.id, header: artifact.header, body: artifact.body, createdAt: 1, updatedAt: 1 };
    const unrelated = { ...skill, artifactId: 'unrelated-prompt', header: { kind: 'prompt_doc.v2' } };
    const requests: (string | undefined)[] = [];
    const list = async (options: Parameters<typeof listArtifactHeadersV1>[0]['options']) => listArtifactHeadersV1({ options,
      encodeCursor: row => row.artifactId,
      // This port is the HTTP/persistent inventory boundary; keep the selector real.
      readPage: async page => {
        requests.push(page?.coarseKind);
        return { items: page?.coarseKind === 'skill' ? [skill] : [skill, unrelated], hasUnclassified: false };
      } });
    const store: PromptLibraryArtifactStore = { ...h.store, list: async options => {
      const page = await list(options);
      return { ...page, items: page.items.map(row => ({ id: row.artifactId, header: row.header, updatedAtMs: row.updatedAt })) };
    } };
    const execute = createSkillActionExecuteV1({ store, skillRules: h.skillRules, randomId: () => 'unused', includeInSession: async () => ({ ok: true }) });
    const result = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.list'].parse(await execute('skills.list', {}, { surface: 'ui' }));
    expect(result.items.find(item => item.skillId === created.skillId)?.name).toBe('sample');
    expect(result.items.some(item => item.skillId === unrelated.artifactId)).toBe(false);
    expect(requests).toEqual(['skill']);
    requests.length = 0;
    expect(await readSkillLibraryCatalog({ list })).toContainEqual({ id: created.skillId, name: 'sample' });
    expect(requests).toEqual(['skill']);
  });
  it('returns an addressed bundle in one read only when full file contents are requested', async () => {
    const h = harness(), stub = FIRST_PARTY_SKILLS_V1[0]!;
    const normal = SkillReadResultV1Schema.parse(await readSkillInLibrary({ store: h.store, request: { skillId: stub.skillId } }));
    expect(normal).not.toHaveProperty('fileContents');
    const expanded = SkillReadResultV1Schema.parse(await readSkillInLibrary({ store: h.store,
      request: { skillId: stub.skillId, includeFileContents: true } }));
    expect(expanded.fileContents).toEqual(stub.files);
  });
  it('projects current plugin content through the built-in read-only path and copies into editable personal ownership', async () => {
    const h = harness();
    const pluginFiles = [{ ...files[0]!, contentBase64: encodeBase64(new TextEncoder().encode(markdown.replace('name: sample', 'name: sample\nuser-invocable: false\ndisable-model-invocation: true')), 'base64') },
      { path: 'scripts/check.sh', contentBase64: 'AAEC/w==', contentKind: 'binary' as const, unixMode: 0o755 }];
    const plugin = { skillId: 'plugin:external.skills/sample', files: pluginFiles,
      provenance: { kind: 'plugin' as const, pluginId: 'external.skills', occurrenceId: 'occurrence-1' } };
    let active = true;
    const readPluginSkills = async () => active ? [plugin] : [];
    const execute = createSkillActionExecuteV1({ store: h.store, skillRules: h.skillRules, randomId: () => 'rule',
      includeInSession: async () => ({ ok: true }), readPluginSkills });
    const list = async () => SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.list'].parse(await execute('skills.list', {}, { surface: 'ui' }));
    const item = (await list()).items.find(item => item.skillId === plugin.skillId);
    expect(item).toMatchObject({ name: 'sample', provenance: plugin.provenance, folderId: null, modified: false, userInvocable: false, trust: 'runs_scripts' });
    const read = await readSkillInLibrary({ store: h.store, pluginSkills: await readPluginSkills(), request: { skillId: plugin.skillId, file: 'SKILL.md' } });
    expect(SkillReadResultV1Schema.parse(read)).toMatchObject({ skillId: plugin.skillId, provenance: plugin.provenance, file: pluginFiles[0] });
    expect(SkillReadResultV1Schema.parse(await readSkillInLibrary({ store: h.store, pluginSkills: [plugin],
      request: { skillId: plugin.skillId, file: 'scripts/check.sh' } })).file).toEqual(pluginFiles[1]);
    for (const actionId of ['skills.update', 'skills.delete'] as const) {
      expect(await execute(actionId, { skillId: plugin.skillId, expectedRevision: item!.revision }, { surface: 'ui' }))
        .toMatchObject({ ok: false, code: 'skill_read_only' });
    }
    expect(h.order).toEqual([]);
    const copied = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.duplicate'].parse(await execute('skills.duplicate', { skillId: plugin.skillId }, { surface: 'ui' }));
    expect(readSkillLockV1(h.artifacts.get(copied.skillId)!.header).provenance).toEqual({ kind: 'written' });
    expect(await execute('skills.update', { skillId: copied.skillId, expectedRevision: copied.revision, description: 'My copy' }, { surface: 'ui' }))
      .toMatchObject({ revision: '2:2' });
    const retainedRule: SkillRuleV1 = { id: 'plugin-rule', skillId: plugin.skillId, target: { t: 'allMachines' },
      enabled: true, createdAt: 1, updatedAt: 1 };
    h.setRules([retainedRule]);
    active = false;
    expect((await list()).items.some(item => item.skillId === plugin.skillId)).toBe(false);
    expect(await execute('skills.delete', { skillId: plugin.skillId, expectedRevision: item!.revision }, { surface: 'ui' }))
      .toMatchObject({ ok: false, code: 'not_found' });
    expect(h.rules()).toEqual([retainedRule]);
    expect(await readSkillInLibrary({ store: h.store, pluginSkills: [], request: { skillId: plugin.skillId } })).toMatchObject({ ok: false, errorCode: 'not_found' });
    // A retired host source is absent even when the independent Artifact transport is unavailable.
    const unavailableStore = { ...h.store, read: async () => { throw new Error('Artifact transport unavailable'); } };
    expect(await readSkillInLibrary({ store: unavailableStore, pluginSkills: [], request: { skillId: plugin.skillId } }))
      .toMatchObject({ ok: false, errorCode: 'not_found' });
    const retiredExecute = createSkillActionExecuteV1({ store: unavailableStore, skillRules: h.skillRules,
      randomId: () => 'unused', includeInSession: async () => ({ ok: true }), readPluginSkills });
    expect(await retiredExecute('skills.duplicate', { skillId: plugin.skillId }, { surface: 'ui' }))
      .toMatchObject({ ok: false, code: 'not_found' });
    expect(await readSkillLibraryCatalog({ list: async () => ({ items: [], coverage: 'complete' as const }),
      read: unavailableStore.read, readPluginSkills }, undefined, [plugin.skillId])).toEqual([]);
    active = true;
    plugin.provenance.occurrenceId = 'occurrence-2';
    expect((await list()).items.find(item => item.skillId === plugin.skillId)?.provenance).toEqual(plugin.provenance);
  });
  it('starts independent Artifact inventory while display catalogs are still pending', async () => {
    const h = harness();
    const created = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.create'].parse(await h.execute('skills.create', { name: 'sample', files }, { surface: 'ui' }));
    let release!: () => void;
    const catalogReady = new Promise<void>(resolve => { release = resolve; });
    let inventoryStarted = false;
    let contentStarted = false;
    const execute = createSkillActionExecuteV1({ store: { ...h.store, list: async options => {
      inventoryStarted = true; return h.store.list!(options);
    }, read: async (...args) => {
      contentStarted = true; return h.store.read(...args);
    } }, skillRules: { ...h.skillRules, readCatalog: async (...args) => {
      await catalogReady; return h.skillRules.readCatalog(...args);
    } }, randomId: () => 'unused', includeInSession: async () => ({ ok: true }) });
    const pending = execute('skills.list', {}, { surface: 'ui' });
    try {
      expect(inventoryStarted).toBe(true);
      await vi.waitFor(() => expect(contentStarted).toBe(true));
    }
    finally { release(); }
    const listed = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.list'].parse(await pending);
    expect(listed.items.find(item => item.skillId === created.skillId)?.name).toBe('sample');
  });

  it('opens each page of skill content while later inventory and earlier bodies are pending', async () => {
    const h = harness();
    const created = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.create'].parse(await h.execute('skills.create', { name: 'sample', files }, { surface: 'ui' }));
    const first = h.artifacts.get(created.skillId)!;
    const second = { ...first, id: 'second-page-skill' };
    let release!: () => void;
    const firstBody = new Promise<void>(resolve => { release = resolve; });
    let secondOpened = false;
    let firstOpened = false;
    let releasePage!: () => void;
    const laterPage = new Promise<void>(resolve => { releasePage = resolve; });
    let secondPageUnavailable = false;
    const execute = createSkillActionExecuteV1({
      store: { ...h.store,
        list: async options => {
          if (!options?.cursor) return { coverage: 'partial', nextCursor: 'page-2', items: [{ id: first.id, header: first.header, updatedAtMs: 1 }] };
          await laterPage;
          return secondPageUnavailable ? { coverage: 'unavailable', items: [] }
            : { coverage: 'complete', items: [{ id: second.id, header: second.header, updatedAtMs: 1 }] };
        },
        read: async id => {
          if (id === first.id) { firstOpened = true; await firstBody; return first; }
          if (id === second.id) { secondOpened = true; return second; }
          return null;
        },
      }, skillRules: h.skillRules, randomId: () => 'unused', includeInSession: async () => ({ ok: true }),
    });
    const pending = execute('skills.list', {}, { surface: 'ui' });
    try {
      await vi.waitFor(() => expect(firstOpened).toBe(true));
      releasePage();
      await vi.waitFor(() => expect(secondOpened).toBe(true));
    }
    finally { releasePage(); release(); }
    const listed = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.list'].parse(await pending);
    expect(listed.items.filter(item => item.provenance.kind !== 'first_party').map(item => item.skillId)).toEqual([first.id, second.id]);
    secondPageUnavailable = true;
    expect(await execute('skills.list', {}, { surface: 'ui' })).toMatchObject({ ok: false, code: 'library_unavailable' });
  });

  it('lists only upstream-tracked skills without reading display catalogs or written content', async () => {
    const h = harness();
    const created = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.create'].parse(await h.execute('skills.create', { name: 'sample', files }, { surface: 'ui' }));
    const written = h.artifacts.get(created.skillId)!;
    const provenance = { kind: 'registry' as const, registry: { sourceId: 'repo', format: 'git' as const,
      sourceUrl: 'https://github.com/a/b', itemId: '', importedAt: 1,
      ref: { kind: 'gitTree' as const, repo: 'https://github.com/a/b', path: '', commit: '1'.repeat(40), treeSha: '2'.repeat(40) } } };
    const tracked = { ...written, id: 'tracked', header: { ...written.header, skillLock: { provenance, updatePolicy: 'manual' } } };
    const broken = { ...tracked, id: 'broken', body: '{malformed' };
    const opened: string[] = [];
    const execute = createSkillActionExecuteV1({
      store: { ...h.store, list: async options => options?.cursor
        ? { coverage: 'complete', items: [{ id: tracked.id, header: tracked.header, updatedAtMs: 1, owned: true }, { id: broken.id, header: broken.header, updatedAtMs: 1, owned: true }] }
        : { coverage: 'partial', nextCursor: 'next', items: [{ id: written.id, header: written.header, updatedAtMs: 1, owned: true }] },
        read: async id => { opened.push(id); if (id === tracked.id) return tracked; if (id === broken.id) return broken; throw new Error('Written content is irrelevant to upstream checks'); } },
      skillRules: { ...h.skillRules, readCatalog: async () => { throw new Error('Display catalogs are irrelevant to upstream checks'); } },
      randomId: () => 'unused', includeInSession: async () => { throw new Error('No Session mutation'); },
    });
    expect(await execute.listRegistryTrackedSkills()).toEqual([{ skillId: 'tracked', name: 'sample', createdAt: 1, provenance }]);
    expect(opened.sort()).toEqual(['broken', 'tracked']);
  });

  it('lists predecessor-valid non-YAML content and cost, while new writes remain valid YAML only', async () => {
    const h = harness();
    const vector = retainedFrontmatter.cases.find(item => item.id === 'unquoted-colon')!;
    h.artifacts.set('retained-yaml', { id: 'retained-yaml', header: vector.header, body: JSON.stringify(vector.body), owned: true,
      revision: { headerVersion: 1, bodyVersion: 1 } });
    const listed = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.list'].parse(await h.execute('skills.list', {}, { surface: 'ui' }));
    expect(listed.items.find(item => item.skillId === 'retained-yaml')).toMatchObject({ name: 'incident-postmortem',
      description: vector.expectedDescription, cost: { descriptionTokens: estimateTokensV1(vector.expectedDescription) } });
    expect(listed.unavailableItems).toBeUndefined();
    expect(await h.execute('skills.create', { name: 'incident-postmortem', files: vector.body.entries }, { surface: 'ui' }))
      .toMatchObject({ ok: false, code: 'invalid_skill_name' });
  });
  it('lists healthy skills beside malformed stored content while preserving inventory failure', async () => {
    const h = harness();
    const created = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.create'].parse(await h.execute('skills.create', { name: 'sample', files }, { surface: 'ui' }));
    const good = h.artifacts.get(created.skillId)!;
    h.artifacts.set('broken', { ...good, id: 'broken', body: '{malformed' });
    const listed = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.list'].parse(await h.execute('skills.list', {}, { surface: 'ui' }));
    expect(listed.items).toContainEqual(expect.objectContaining({ skillId: created.skillId }));
    expect(listed.items.some(item => item.skillId === 'broken')).toBe(false);
    expect(listed.unavailableItems).toEqual([{ skillId: 'broken', title: 'sample', reason: 'skill_content_unavailable' }]);
    const execute = createSkillActionExecuteV1({ store: { ...h.store, list: async () => ({ coverage: 'unavailable', items: [] }) },
      skillRules: h.skillRules, includeInSession: async () => ({ ok: true }), randomId: () => 'rule' });
    expect(await execute('skills.list', {}, { surface: 'ui' })).toMatchObject({ ok: false, code: 'library_unavailable' });
  });
  it('creates and updates decoded YAML fields without corrupting block scalars or nested metadata', async () => {
    const h = harness();
    const body = '\n    Instructions\r\n';
    const original = '---\nname: "original"\ndescription: >\n  Old folded\n  description\nmetadata:\n  name: nested\nuser-invocable: false\n---\n' + body;
    const created = await h.execute('skills.create', { name: 'sample', description: 'Use foo: bar # safely',
      files: [{ ...files[0]!, contentBase64: encodeBase64(new TextEncoder().encode(original), 'base64') }] }, { surface: 'ui' });
    expect(created).toMatchObject({ ok: true });
    const receipt = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.create'].parse(created);
    const read = () => readSkillInLibrary({ store: h.store, request: { skillId: receipt.skillId } });
    const first = SkillReadResultV1Schema.parse(await read());
    expect(readSkillFrontmatterV1(first.skillMd)).toMatchObject({ name: 'sample', description: 'Use foo: bar # safely', userInvocable: false });
    expect(first.skillMd).toContain('name: nested');
    expect(first.skillMd.endsWith('\n' + body)).toBe(true);
    const description = 'First: exact\nSecond # exact';
    expect(await h.execute('skills.update', { skillId: receipt.skillId, expectedRevision: first.revision, description }, { surface: 'ui' }))
      .toMatchObject({ revision: '2:2' });
    expect(readSkillFrontmatterV1(SkillReadResultV1Schema.parse(await read()).skillMd)).toMatchObject({ name: 'sample', description, userInvocable: false });
  });
  it.each([false, true])('keeps the acknowledged creation revision without a readback, including incomplete rules (%s)', async failRules => {
    const h = harness(); h.failRules(failRules);
    // Artifact persistence can acknowledge a current non-initial revision.
    // No second content observation is needed to report that durable receipt.
    const revision = { headerVersion: 3, bodyVersion: 7 };
    const store = { ...h.store,
      create: async (input: Parameters<NonNullable<PromptLibraryArtifactStore['create']>>[0]) => {
        const created = await h.store.create!(input);
        const artifactId = typeof created === 'string' ? created : created.artifactId;
        const artifact = h.artifacts.get(artifactId)!;
        h.artifacts.set(artifactId, { ...artifact, revision });
        return { artifactId, revision };
      },
      read: async () => { throw new Error('Creation receipt must not await readback'); },
    };
    const execute = createSkillActionExecuteV1({ store, skillRules: h.skillRules, randomId: () => 'rule', nowMs: () => 1,
      includeInSession: async () => ({ ok: true }) });
    const output = await execute('skills.duplicate', { skillId: FIRST_PARTY_SKILLS_V1[0]!.skillId }, { surface: 'ui' });
    expect(output).toEqual({ ok: true, skillId: 'skill-1', revision: '3:7', includedInSessionId: null,
      summary: { name: 'happier', description: 'Use Happier from this session' },
      ...(failRules ? { incomplete: 'rules' } : {}) });
    const result = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.duplicate'].parse(output);
    expect(h.order).toEqual(failRules ? ['content'] : ['content', 'rules']);
    expect(h.rules()).toEqual(failRules ? [] : [expect.objectContaining({ skillId: result.skillId, enabled: true })]);
  });
  it('lists the bundled skill with actual rules and refuses mutations without writing, while duplication makes a written copy', async () => {
    const h = harness(), stub = FIRST_PARTY_SKILLS_V1[0]!;
    h.setRules([buildFirstPartySkillSeedRuleV1(stub.skillId, 1)]);
    h.usage({ [stub.skillId]: 123 });
    const list = () => h.execute('skills.list', {}, { surface: 'ui' });
    const item = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.list'].parse(await list()).items.find(item => item.skillId === stub.skillId)!;
    expect(item).toMatchObject({ name: 'happier', provenance: { kind: 'first_party' }, createdAt: 0, folderId: null,
      modified: false, userInvocable: true, lastUsedAt: 123, rules: [buildFirstPartySkillSeedRuleV1(stub.skillId, 1)] });
    expect(item.revision).toBe(computePromptBundleDigestV1({ v: 1, entries: [...stub.files], createdAtMs: 0, updatedAtMs: 0 }));
    for (const actionId of ['skills.update', 'skills.delete'] as const) {
      expect(await h.execute(actionId, { skillId: stub.skillId, expectedRevision: item.revision }, { surface: 'ui' }))
        .toMatchObject({ ok: false, code: 'first_party_read_only' });
    }
    expect(h.order).toEqual([]);
    const exported = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.export'].parse(await h.execute('skills.export', { skillIds: [stub.skillId] }, { surface: 'ui' }));
    expect(await readSkillZipFilesV1(decodeBase64(exported.bytes, 'base64'))).toMatchObject([{ path: 'happier/SKILL.md', contentBase64: stub.files[0]!.contentBase64 }]);
    h.setRules([]);
    expect(SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.list'].parse(await list()).items.find(item => item.skillId === stub.skillId)?.rules).toEqual([]);
    const copy = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.duplicate'].parse(await h.execute('skills.duplicate', { skillId: stub.skillId }, { surface: 'ui' }));
    expect(copy.skillId).not.toBe(stub.skillId);
    expect(readSkillLockV1(h.artifacts.get(copy.skillId)!.header).provenance).toEqual({ kind: 'written' });
    expect(h.rules()).toMatchObject([{ skillId: copy.skillId, target: { t: 'allMachines' }, enabled: true }]);
  });
  it('reads bundled bytes without an Artifact and enforces current session identity for the index fallback', async () => {
    const stub = FIRST_PARTY_SKILLS_V1[0]!, digest = computePromptBundleDigestV1({ v: 1, entries: [...stub.files], createdAtMs: 0, updatedAtMs: 0 });
    const store = { read: async () => { throw new Error('Bundled content must not need an Artifact'); } };
    const read = await readSkillInLibrary({ store, request: { skillId: stub.skillId, file: 'SKILL.md' } });
    expect(SkillReadResultV1Schema.parse(read)).toMatchObject({ skillId: stub.skillId, revision: digest, provenance: { kind: 'first_party' },
      file: stub.files[0], trust: 'text_only', modified: false });
    const sessionItem = { skillId: stub.skillId, name: stub.name, digest };
    let used = false;
    const fallback = await readSkillInLibrary({ store, request: { name: 'happier', sessionId: 'session' }, sessionItems: [sessionItem],
      recordSessionUse: async item => { used = item.digest === digest; return true; } });
    expect(SkillReadResultV1Schema.parse(fallback).skillMd).toContain('happier skills --help');
    expect(used).toBe(true);
    for (const sessionItems of [[], [{ ...sessionItem, digest: 'stale' }], [{ ...sessionItem, name: 'other' }]]) {
      expect(await readSkillInLibrary({ store, request: { skillId: stub.skillId, sessionId: 'session' }, sessionItems })).toMatchObject({ ok: false, errorCode: 'not_found' });
    }
  });
  it.each([
    { markdown: 'Native instructions without frontmatter', supportingPath: 'references/note.txt', errorCode: 'invalid_skill_name' },
    { markdown, supportingPath: 'references/native:note.txt', errorCode: 'invalid_path' },
  ])('compares native bytes that adoption refuses ($errorCode) without creating content', async input => {
    const nativeFiles = [{ ...files[0]!, contentBase64: encodeBase64(new TextEncoder().encode(input.markdown), 'base64') },
      { path: input.supportingPath, contentBase64: 'AAEC/w==', contentKind: 'binary' as const, unixMode: 0o755 }];
    const h = harness(undefined, async (_machineId, path) => ({ name: 'native-sample', path, agents: ['claude'], pluginOwned: null, files: nativeFiles }));
    const identity = { machineId: 'machine', path: '/native/sample' };
    expect(SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.found.read'].parse(await h.execute('skills.found.read', identity, { surface: 'ui' })))
      .toEqual({ name: 'native-sample', files: nativeFiles });
    expect(await h.execute('skills.found.adopt', { machineId: identity.machineId, items: [{ name: 'native-sample', path: identity.path }] }, { surface: 'ui' }))
      .toEqual({ ok: false, code: input.errorCode });
    expect(h.creates()).toBe(0); expect(h.artifacts.size).toBe(0); expect(h.order).toEqual([]);
  });
  it('reads Found bytes without writes and adopts a plugin skill through the normal creation owner', async () => {
    const nativeFiles = [...files, { path: 'scripts/run.sh', contentBase64: 'eA==', contentKind: 'utf8' as const, unixMode: 0o755 }];
    // The machine filesystem/download transport is the external boundary; all library logic remains real.
    const h = harness(undefined, async () => ({ name: 'sample', path: '/native/plugins/example/skills/sample', agents: ['claude'],
      pluginOwned: { pluginName: 'example' }, files: nativeFiles }));
    const input = { machineId: 'machine', path: '/native/plugins/example/skills/sample' };
    const read = await h.execute('skills.found.read', input, { surface: 'ui' });
    expect(SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.found.read'].parse(read)).toEqual({ name: 'sample', files: nativeFiles });
    expect(h.order).toEqual([]);
    const adopted = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.found.adopt'].parse(await h.execute('skills.found.adopt', {
      machineId: input.machineId, items: [{ name: 'stale-display-name', path: input.path }],
    }, { surface: 'ui' }));
    expect(adopted).toEqual({ skillIds: ['skill-1'], includedInSessionId: null });
    expect(h.order).toEqual(['content', 'rules']);
    expect(readSkillLockV1(h.artifacts.get('skill-1')!.header).provenance).toEqual({ kind: 'machine', machineId: 'machine',
      path: input.path, agentIds: ['claude'], importedAt: 1 });
    expect(JSON.parse(h.artifacts.get('skill-1')!.body!).entries).toEqual(nativeFiles);
    expect(h.rules()).toMatchObject([{ skillId: 'skill-1', target: { t: 'allMachines' } }]);
  });
  it('refuses Agent Found reach before machine reads and keeps session-only adoption acknowledgements', async () => {
    let machineReads = 0;
    const h = harness(undefined, async (_machineId, path) => { machineReads++; return { name: 'sample', path, agents: ['claude'], pluginOwned: null, files }; });
    const input = { machineId: 'machine', items: [{ name: 'sample', path: '/native/sample' }] };
    expect(await h.execute('skills.found.adopt', { ...input, where: { kind: 'replace', rules: [] } }, { surface: 'agent', sessionId: 's' }))
      .toMatchObject({ ok: false, code: 'where_needs_rules_action' });
    expect(machineReads).toBe(0); expect(h.creates()).toBe(0);
    h.failSession(true);
    const receipt = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.found.adopt'].parse(await h.execute('skills.found.adopt', input, { surface: 'agent', sessionId: 's' }));
    expect(receipt).toEqual({ skillIds: ['skill-1'], includedInSessionId: null, incomplete: [{ skillId: 'skill-1', step: 'session_include' }] });
    expect(h.rules()).toEqual([]); expect(h.order).toEqual(['content']);
  });
  it('keeps prior Found content acknowledgements when a later write fails', async () => {
    const h = harness(undefined, async (_machineId, path) => ({ name: 'sample', path, agents: ['claude'], pluginOwned: null, files }));
    h.failRules(true); h.failCreateAt(2);
    const result = await h.execute('skills.found.adopt', { machineId: 'machine', items: [{ name: 'sample', path: '/native/one' }, { name: 'sample', path: '/native/two' }] }, { surface: 'cli' });
    expect(result).toMatchObject({ ok: false, errorCode: 'quota_exceeded', details: { skillIds: ['skill-1'], incomplete: [{ skillId: 'skill-1', step: 'rules' }] } });
    if (!result || typeof result !== 'object' || !('details' in result)) throw new Error('Expected acknowledged Found failure');
    expect(SkillInstallAcknowledgedEffectsV1Schema.parse(result.details).skillIds).toEqual(['skill-1']);
    expect([...h.artifacts.keys()]).toEqual(['skill-1']);
  });
  it('joins Account usage into the strict list output without exposing deleted-skill facts', async () => {
    const h = harness(); await h.execute('skills.create', { name: 'sample', files }, { surface: 'ui' });
    h.usage({ 'skill-1': 123, deleted: 10, 'happier:happier': 456 });
    const result = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.list'].parse(await h.execute('skills.list', {}, { surface: 'ui' }));
    expect(result.items.map(item => item.skillId)).not.toContain('deleted');
    expect(result.items.find(item => item.skillId === 'skill-1')).toMatchObject({ lastUsedAt: 123 });
    expect(result.items.find(item => item.skillId === 'happier:happier')).toMatchObject({ lastUsedAt: 456 });
    expect(result).toMatchObject({ usageObservedSince: 10 });
    h.usageUnavailable();
    const unavailable = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.list'].parse(await h.execute('skills.list', {}, { surface: 'ui' }));
    expect(unavailable.items.every(item => item.lastUsedAt === undefined)).toBe(true);
    expect(unavailable).toMatchObject({ usageObservedSince: null });
    expect(unavailable.revision).not.toBe(result.revision);
  });
  it('reports an acknowledged content identity even when its revision cannot be read back', async () => {
    const h = harness(); h.failCreatedRead(true);
    const result = await h.execute('skills.create', { name: 'sample', files }, { surface: 'ui' });
    expect(result).toMatchObject({
      ok: false, errorCode: 'created_skill_unreadable', details: { skillIds: ['skill-1'], incomplete: [{ skillId: 'skill-1', step: 'rules' }] },
    });
    if (!result || typeof result !== 'object' || !('details' in result)) throw new Error('Expected acknowledged failure details');
    expect(SkillInstallAcknowledgedEffectsV1Schema.parse(result.details).skillIds).toEqual(['skill-1']);
    expect(h.artifacts.has('skill-1')).toBe(true); expect(h.rules()).toEqual([]);
  });
  it('does not discard an acknowledged update when a legacy void store cannot read its new revision', async () => {
    const h = harness(); await h.execute('skills.create', { name: 'sample', files }, { surface: 'ui' }); h.failUpdatedRead(true);
    expect(await h.execute('skills.update', { skillId: 'skill-1', expectedRevision: '1:1', name: 'changed' }, { surface: 'ui' })).toMatchObject({
      ok: false, errorCode: 'updated_skill_unreadable', details: { skillIds: ['skill-1'] },
    });
    expect(h.artifacts.get('skill-1')!.revision).toEqual({ headerVersion: 2, bodyVersion: 2 });
  });
  it('consumes a real root GitHub producer, pins install bytes and preserves Modified edits through link choices', async () => {
    const { initial, latest, source, registry, setHead } = gitRegistryHarness();
    const producer = await registry.fetchRequest({ op: 'read', kind: 'skill', sourceId: 'repo', itemId: '' });
    if (producer.op !== 'read' || producer.item.payload.kind !== 'skill') throw new Error('Expected registry skill read');
    expect(producer.item.payload.skill.ref.repo).toBe(source.url);
    setHead(latest); const h = harness(registry);
    const install = await h.execute('skills.install', { source: { kind: 'registry', sourceId: 'repo', itemId: '', version: producer.item.summary.version } }, { surface: 'ui' });
    expect(install).toMatchObject({ skillIds: ['skill-1'] });
    expect(readSkillLockV1(h.artifacts.get('skill-1')!.header).provenance).toMatchObject({ kind: 'registry', registry: { itemId: '', ref: { commit: initial } } });
    expect(JSON.parse(h.artifacts.get('skill-1')!.body!).entries).toMatchObject(files);
    // Start the link-update scenario in its own library; Add now reuses the registry identity above.
    const linked = harness(registry);
    setHead(initial);
    await linked.execute('skills.install', { source: { kind: 'link', url: source.url } }, { surface: 'ui' });
    await linked.execute('skills.update', { skillId: 'skill-1', expectedRevision: '1:1', files: [{ kind: 'upsert', file: { ...files[0]!, contentBase64: encodeBase64(new TextEncoder().encode(markdown + '\nMine'), 'base64') } }] }, { surface: 'ui' });
    const artifact = linked.artifacts.get('skill-1')!, lock = readSkillLockV1(artifact.header);
    const newItem = await registry.readRegistryItem({ sourceId: 'repo', itemId: '', version: latest });
    if (newItem.payload.kind !== 'skill') throw new Error('Expected upstream skill');
    linked.artifacts.set('skill-1', { ...artifact, header: { ...artifact.header, skillLock: { ...lock, upstream: { state: 'update_available', latest: newItem.payload.skill.ref } } } });
    expect(await linked.execute('skills.updates.apply', { skillId: 'skill-1', expectedRevision: '2:2' }, { surface: 'ui' })).toMatchObject({ ok: false, code: 'choices_required' });
    const diff = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.updates.diff'].parse(await linked.execute('skills.updates.diff', { skillId: 'skill-1' }, { surface: 'ui' }));
    expect(diff.files).toMatchObject([{ path: 'SKILL.md', changed: true }]);
    const applied = await linked.execute('skills.updates.apply', { skillId: 'skill-1', expectedRevision: '2:2', choices: { 'SKILL.md': 'mine' } }, { surface: 'ui' });
    expect(applied).toMatchObject({ provenance: { kind: 'link', ref: { commit: latest } } });
    const listed = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.list'].parse(await linked.execute('skills.list', {}, { surface: 'ui' }));
    expect(listed.items.find(item => item.skillId === 'skill-1')).toMatchObject({ modified: true, upstream: { state: 'current' } });
    expect(linked.artifacts.get('skill-1')!.body).toContain(encodeBase64(new TextEncoder().encode(markdown + '\nMine'), 'base64'));
  });
  it.each(['manual', 'auto'] as const)('preserves %s policy through settings read/save and a later upstream head', async updatePolicy => {
    const { initial, latest, source, registry, setHead } = gitRegistryHarness();
    const h = harness(registry), caller = { surface: 'ui' as const };
    const installed = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.install'].parse(await h.execute('skills.install', {
      source: { kind: 'registry', sourceId: source.id, itemId: '', version: initial },
    }, caller));
    if (!('skillIds' in installed)) throw new Error('Expected committed skill');
    const skillId = installed.skillIds[0]!;
    await h.execute('skills.update', { skillId, expectedRevision: '1:1', updatePolicy }, caller);
    const listItem = async (state?: 'updates') => {
      const result = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.list'].parse(await h.execute('skills.list', state ? { state } : {}, caller));
      const item = result.items.find(item => item.skillId === skillId);
      if (!item) throw new Error('Expected listed skill');
      return item;
    };
    const settings = await listItem();
    const content = SkillReadResultV1Schema.parse(await readSkillInLibrary({ store: h.store, request: { skillId, includeFileContents: true } }));
    const before = readSkillLockV1(h.artifacts.get(skillId)!.header);
    expect(settings).toMatchObject({ updatePolicy, modified: false, provenance: { kind: 'registry', registry: { ref: { commit: initial } } } });
    const saved = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.update'].parse(await h.execute('skills.update',
      SKILL_ACTION_INPUT_SCHEMAS_V1['skills.update'].parse({ skillId, expectedRevision: content.revision,
        updatePolicy: settings.updatePolicy, description: settings.description,
        files: content.fileContents!.map(file => ({ kind: 'upsert', file })) }), caller));
    expect(readSkillLockV1(h.artifacts.get(skillId)!.header)).toEqual(before);
    expect(await listItem()).toMatchObject({ updatePolicy, revision: saved.revision, modified: false });

    setHead(latest);
    const producer = await registry.fetchRequest({ op: 'read', kind: 'skill', sourceId: source.id, itemId: '' });
    if (producer.op !== 'read' || producer.item.payload.kind !== 'skill') throw new Error('Expected latest registry skill');
    expect(producer.item.payload.skill.ref.commit).toBe(latest);
    const observed = await h.execute.recordRegistryUpstream(skillId, { state: 'update_available', latest: producer.item.payload.skill.ref });
    expect(observed).toMatchObject({ updatePolicy, modified: false, upstream: { state: 'update_available' } });
    expect(await listItem('updates')).toMatchObject({ updatePolicy, modified: false, upstream: { latest: { commit: latest } } });
    const diff = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.updates.diff'].parse(await h.execute('skills.updates.diff', { skillId }, caller));
    expect(diff.files).toMatchObject([{ path: 'SKILL.md', changed: true }]);
    const applied = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.updates.apply'].parse(await h.execute('skills.updates.apply',
      { skillId, expectedRevision: observed!.revision }, caller));
    expect(applied.provenance).toMatchObject({ kind: 'registry', registry: { ref: { commit: latest } } });
    expect(await listItem()).toMatchObject({ updatePolicy, revision: applied.revision, modified: false, upstream: { state: 'current' } });
    const resolved = SkillReadResultV1Schema.parse(await readSkillInLibrary({ store: h.store, request: { skillId } }));
    expect(resolved.skillMd).toBe(markdown + '\nUpstream');
    expect(readSkillLockV1(h.artifacts.get(skillId)!.header).importedDigest).not.toBe(before.importedDigest);
  });
  it('previews multiple uploaded skill folders and preserves acknowledged identities if a later content write fails', async () => {
    const h = harness(), source = { kind: 'upload', files: [...files.map(file => ({ ...file, path: 'one/' + file.path })), ...files.map(file => ({ ...file, path: 'two/' + file.path, contentBase64: encodeBase64(new TextEncoder().encode(markdown.replace('name: sample', 'name: other')), 'base64') }))] };
    expect(await h.execute('skills.install', { source, dryRun: true }, { surface: 'ui' })).toMatchObject({ items: [{ path: 'one' }, { path: 'two' }] });
    expect(h.creates()).toBe(0); h.failCreateAt(2);
    expect(await h.execute('skills.install', { source }, { surface: 'ui' })).toMatchObject({ ok: false, errorCode: 'quota_exceeded', details: { skillIds: ['skill-1'] } });
    expect([...h.artifacts.keys()]).toEqual(['skill-1']);
  });
  it('creates content then the Everywhere rule, and produces strict consumer receipts', async () => {
    const h = harness(); const receipt = await h.execute('skills.create', { name: 'sample', files }, { surface: 'ui' });
    expect(SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.create'].parse(receipt)).toMatchObject({ ok: true, skillId: 'skill-1', includedInSessionId: null });
    expect(h.order).toEqual(['content', 'rules']); expect(h.rules()).toMatchObject([{ skillId: 'skill-1', target: { t: 'allMachines' }, enabled: true }]);
    expect(SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.list'].parse(await h.execute('skills.list', {}, { surface: 'ui' })).items)
      .toEqual(expect.arrayContaining([expect.objectContaining({ name: 'sample', userInvocable: true })]));
  });
  it('duplicates through the creation owner and exports the selected canonical bytes as a portable ZIP', async () => {
    const h = harness(); await h.execute('skills.create', { name: 'sample', files, where: { kind: 'replace', rules: [] } }, { surface: 'ui' });
    const copy = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.duplicate'].parse(await h.execute('skills.duplicate', { skillId: 'skill-1' }, { surface: 'ui' }));
    expect(copy.skillId).toBe('skill-2');
    expect(h.rules()).toMatchObject([{ skillId: 'skill-2', target: { t: 'allMachines' } }]);
    expect(h.artifacts.get('skill-1')!.body).toBe(h.artifacts.get('skill-2')!.body);
    const exported = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.export'].parse(await h.execute('skills.export', { skillIds: [copy.skillId] }, { surface: 'cli' }));
    const archived = await readSkillZipFilesV1(decodeBase64(exported.bytes, 'base64'));
    expect(archived).toMatchObject([{ path: 'sample/SKILL.md', contentKind: 'utf8', unixMode: 0o644 }]);
    expect(decodeBase64(archived[0]!.contentBase64, 'base64')).toEqual(decodeBase64(JSON.parse(h.artifacts.get(copy.skillId)!.body!).entries[0].contentBase64, 'base64'));
  });
  it('limits Agent creation to its session and refuses where before any write', async () => {
    const h = harness(); expect(await h.execute('skills.create', { name: 'sample', files, where: { kind: 'replace', rules: [] } }, { surface: 'agent', sessionId: 's' })).toMatchObject({ ok: false, code: 'where_needs_rules_action' });
    expect(h.creates()).toBe(0);
    expect(await h.execute('skills.create', { name: 'sample', files }, { surface: 'agent', sessionId: 's' })).toMatchObject({ includedInSessionId: 's' });
    expect(h.rules()).toEqual([]); expect(h.includes.get('s')).toEqual(['skill-1']); expect(h.order).toEqual(['content', 'session']);
  });
  it('keeps created identity when rules or session acknowledgement fails', async () => {
    const h = harness(); h.failRules(true);
    expect(await h.execute('skills.create', { name: 'sample', files }, { surface: 'cli' })).toMatchObject({ ok: true, skillId: 'skill-1', incomplete: 'rules' });
    expect(h.rules()).toEqual([]); expect(h.creates()).toBe(1);
    h.failSession(true);
    expect(await h.execute('skills.create', { name: 'sample', files }, { surface: 'agent', sessionId: 's' })).toMatchObject({ skillId: 'skill-2', incomplete: 'session_include', includedInSessionId: null });
  });
  it('checks revision before writes, and deletion reports inert leftover rules', async () => {
    const h = harness(); await h.execute('skills.create', { name: 'sample', files }, { surface: 'ui' });
    expect(await h.execute('skills.update', { skillId: 'skill-1', expectedRevision: '1:2', name: 'new-name' }, { surface: 'ui' })).toMatchObject({ ok: false, code: 'revision_conflict', current: { revision: '1:1' } });
    h.failRules(true);
    expect(await h.execute('skills.delete', { skillId: 'skill-1', expectedRevision: '1:1' }, { surface: 'ui' })).toEqual({ deleted: true, rulesLeft: true });
    expect(h.artifacts.size).toBe(0);
    h.failRules(false);
    expect(await h.execute('skills.delete', { skillId: 'skill-1', expectedRevision: '1:1' }, { surface: 'ui' })).toEqual({ deleted: true }); expect(h.rules()).toEqual([]);
  });
  it.each([null, '{malformed'])('deletes a header-identified skill with unreadable body %s through content CAS and rules cleanup', async body => {
    const h = harness(); await h.execute('skills.create', { name: 'sample', files }, { surface: 'ui' });
    h.artifacts.set('skill-1', { ...h.artifacts.get('skill-1')!, body });
    expect(await h.execute('skills.delete', { skillId: 'skill-1', expectedRevision: '1:2' }, { surface: 'ui' })).toMatchObject({ ok: false, code: 'revision_conflict' });
    expect(h.artifacts.has('skill-1')).toBe(true);
    expect(await h.execute('skills.delete', { skillId: 'skill-1', expectedRevision: '1:1' }, { surface: 'ui' })).toEqual({ deleted: true });
    expect(h.artifacts.has('skill-1')).toBe(false); expect(h.rules()).toEqual([]);
  });
  it('upload preview names relative files the bundle will not contain, and stays advisory', async () => {
    const h = harness(); const withLink = (text: string) => [{ ...files[0]!, contentBase64: encodeBase64(new TextEncoder().encode(markdown + text), 'base64') }];
    const source = { kind: 'upload', files: withLink('\nFollow [the checklist](../../shared/checklist.md).\n') };
    expect(await h.execute('skills.install', { source, dryRun: true }, { surface: 'ui' })).toMatchObject({ items: [{ outsideReferences: ['../../shared/checklist.md'] }] });
    expect(await h.execute('skills.install', { source: { kind: 'upload', files }, dryRun: true }, { surface: 'ui' })).not.toHaveProperty('items.0.outsideReferences');
    expect(await h.execute('skills.install', { source }, { surface: 'ui' })).toMatchObject({ skillIds: ['skill-1'] });
  });
  it('upload preview is inert, reports modes, and commit Off writes no enabled rule', async () => {
    const h = harness(); const source = { kind: 'upload', files: [...files, { path: 'scripts/run.sh', contentBase64: 'eA==', contentKind: 'utf8', unixMode: 0o755 }] };
    expect(await h.execute('skills.install', { source: { kind: 'upload', files: [...files, { path: 'a:b', contentBase64: 'eA==', contentKind: 'utf8' }] } }, { surface: 'ui' }))
      .toMatchObject({ ok: false, code: 'invalid_path' });
    expect(h.creates()).toBe(0);
    expect(await h.execute('skills.install', { source, dryRun: true }, { surface: 'ui' })).toMatchObject({ items: [{ trust: 'runs_scripts', provenance: { kind: 'upload' } }] }); expect(h.creates()).toBe(0);
    expect(await h.execute('skills.install', { source, where: { kind: 'replace', rules: [] } }, { surface: 'ui' })).toMatchObject({ skillIds: ['skill-1'] }); expect(h.rules()).toEqual([]);
    expect(readSkillLockV1(h.artifacts.get('skill-1')!.header)).not.toHaveProperty('sourceFolderName');
  });

  it.each([
    { choice: 'mine', via: 'hunk' }, { choice: 'theirs', via: 'hunk' }, { choice: 'both', via: 'hunk' },
    { choice: 'both', via: 'file' }, { choice: 'mine', via: 'default' },
  ] as const)('merges template skill candidates with $choice overlap choices via $via without changing provenance', async ({ choice, via }) => {
    const h = harness();
    const file = (path: string, content: string) => ({ path, contentKind: 'utf8' as const, contentBase64: encodeBase64(new TextEncoder().encode(content), 'base64') });
    const base = file('SKILL.md', markdown + '\nshared\nanchor one\nlocal slot\nanchor two\nauthor slot\n');
    const mine = file('SKILL.md', markdown + '\nmy overlap\nanchor one\nlocal edit\nanchor two\nauthor slot\n');
    const theirs = file('SKILL.md', markdown + '\nauthor overlap\nanchor one\nlocal slot\nanchor two\nauthor edit\n');
    await h.execute('skills.create', { name: 'sample', files: [mine] }, { surface: 'ui' });
    const originalLock = readSkillLockV1(h.artifacts.get('skill-1')!.header);
    const candidate = { baseFiles: [base], files: [theirs] };
    const diff = await h.execute('skills.updates.diff', { skillId: 'skill-1', candidate }, { surface: 'ui' });
    expect(diff).toMatchObject({ revision: '1:1', files: [{ base, mine, theirs, comparison: { segments: expect.any(Array) } }] });
    const parsed = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.updates.diff'].parse(diff);
    const overlap = parsed.files[0]!.comparison!.segments.find(segment => segment.kind === 'conflict')!;
    expect(overlap).toBeDefined();
    const applied = await h.execute('skills.updates.apply', { skillId: 'skill-1', expectedRevision: '1:1', candidate,
      ...(via === 'hunk' ? { hunkChoices: { 'SKILL.md': { [overlap.index]: choice } } } : via === 'file' ? { choices: { 'SKILL.md': choice } } : {}) }, { surface: 'ui' });
    expect(applied).toMatchObject({ revision: '2:2', provenance: originalLock.provenance });
    const result = JSON.parse(h.artifacts.get('skill-1')!.body!).entries[0];
    const expectedOverlap = choice === 'mine' ? 'my overlap\n' : choice === 'theirs' ? 'author overlap\n' : 'my overlap\nauthor overlap\n';
    expect(new TextDecoder().decode(decodeBase64(result.contentBase64, 'base64'))).toBe(markdown + '\n' + expectedOverlap + 'anchor one\nlocal edit\nanchor two\nauthor edit\n');
    expect(readSkillLockV1(h.artifacts.get('skill-1')!.header)).toEqual(originalLock);
  });
  it.each(['skills.updates.diff', 'skills.updates.apply'] as const)('runs inline template %s without reading global catalogs', async actionId => {
    const h = harness();
    await h.execute('skills.create', { name: 'sample', files }, { surface: 'ui' });
    // Catalog persistence is a separate boundary; inline release bytes need only the addressed Artifact.
    h.skillRules.readCatalog = async () => { throw new Error('Global rules catalog must not be read'); };
    const readPluginSkills = vi.fn(async () => []);
    const execute = createSkillActionExecuteV1({ store: h.store, skillRules: h.skillRules,
      readPluginSkills,
      includeInSession: async () => included });
    const next = { ...files[0]!, contentBase64: encodeBase64(new TextEncoder().encode(markdown + '\nRelease update'), 'base64') };
    const input = { skillId: 'skill-1', expectedRevision: '1:1', candidate: { baseFiles: files, files: [next] } };
    if (actionId === 'skills.updates.diff') {
      expect(await execute(actionId, { skillId: input.skillId, candidate: input.candidate }, { surface: 'ui' }))
        .toMatchObject({ revision: '1:1', files: [{ mine: files[0], theirs: next, changed: true }] });
    } else {
      expect(await execute(actionId, input, { surface: 'ui' })).toMatchObject({ revision: '2:2' });
      expect(await execute(actionId, input, { surface: 'ui' })).toEqual({ ok: false, code: 'revision_conflict' });
    }
    expect(readPluginSkills).not.toHaveBeenCalled();
  });
  it('reviews every file of a removed template skill without allowing an empty skill write', async () => {
    const h = harness();
    const baseFiles = [...files, { path: 'asset.bin', contentKind: 'binary' as const, contentBase64: encodeBase64(new Uint8Array([0, 255, 1]), 'base64') }];
    await h.execute('skills.create', { name: 'sample', files: baseFiles }, { surface: 'ui' });
    const stored = h.artifacts.get('skill-1');
    const candidate = { baseFiles, files: [] };
    const diff = await h.execute('skills.updates.diff', { skillId: 'skill-1', candidate }, { surface: 'ui' });
    expect(diff).toMatchObject({ revision: '1:1', costDelta: { theirs: { descriptionTokens: 0, bodyTokens: 0 } },
      files: baseFiles.map(file => ({ path: file.path, base: file, mine: file, theirs: null, changed: true })) });
    SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.updates.diff'].parse(diff);
    expect(await h.execute('skills.updates.apply', { skillId: 'skill-1', expectedRevision: '1:1', candidate,
      choices: { 'SKILL.md': 'theirs', 'asset.bin': 'theirs' } }, { surface: 'ui' }))
      .toMatchObject({ ok: false, code: 'missing_required_entry' });
    expect(h.artifacts.get('skill-1')).toBe(stored);
  });
  it('keeps the current revision and performs zero content writes for an unchanged template candidate', async () => {
    const h = harness();
    const currentFiles = [...files, { path: 'notes.txt', contentKind: 'utf8', contentBase64: encodeBase64(new TextEncoder().encode('\ufeffNotes\r\n'), 'base64') }];
    await h.execute('skills.create', { name: 'sample', files: currentFiles }, { surface: 'ui' });
    const update = vi.spyOn(h.store, 'update');
    expect(await h.execute('skills.updates.apply', { skillId: 'skill-1', expectedRevision: '1:1', candidate: { baseFiles: currentFiles, files: currentFiles } }, { surface: 'ui' }))
      .toMatchObject({ revision: '1:1' });
    expect(update).not.toHaveBeenCalled();
  });
  it('preserves template local deletions and additions, selects binary/removal bytes, and refuses stale review revisions', async () => {
    const h = harness();
    const file = (path: string, value: string, contentKind: 'utf8' | 'binary' = 'utf8') => ({ path, contentKind, contentBase64: encodeBase64(new TextEncoder().encode(value), 'base64') });
    const base = [files[0]!, file('local-delete.txt', 'base'), file('removed.txt', 'base'), file('asset.bin', 'base', 'binary')];
    const mine = [files[0]!, file('removed.txt', 'local'), file('asset.bin', 'mine', 'binary'), file('local.txt', 'local only')];
    const candidate = { baseFiles: base, files: [files[0]!, file('local-delete.txt', 'author changed'), file('asset.bin', 'theirs', 'binary'), file('new.txt', 'author added')] };
    await h.execute('skills.create', { name: 'sample', files: mine }, { surface: 'ui' });
    expect(await h.execute('skills.updates.apply', { skillId: 'skill-1', expectedRevision: '1:1', candidate,
      choices: { 'asset.bin': 'both' } }, { surface: 'ui' })).toMatchObject({ ok: false, code: 'invalid_update_choice' });
    expect(h.artifacts.get('skill-1')!.revision.bodyVersion).toBe(1);
    await h.execute('skills.update', { skillId: 'skill-1', expectedRevision: '1:1', files: [{ kind: 'upsert', file: file('other.txt', 'another writer') }] }, { surface: 'ui' });
    expect(await h.execute('skills.updates.apply', { skillId: 'skill-1', expectedRevision: '1:1', candidate }, { surface: 'ui' })).toMatchObject({ ok: false, code: 'revision_conflict' });
    expect(await h.execute('skills.updates.apply', { skillId: 'skill-1', expectedRevision: '2:2', candidate,
      choices: { 'asset.bin': 'theirs', 'removed.txt': 'theirs' } }, { surface: 'ui' })).toMatchObject({ revision: '3:3' });
    const result = JSON.parse(h.artifacts.get('skill-1')!.body!).entries;
    expect(result).toEqual(expect.arrayContaining([files[0]!, file('asset.bin', 'theirs', 'binary'), file('local.txt', 'local only'), file('new.txt', 'author added'), file('other.txt', 'another writer')]));
    expect(result.map((entry: { path: string }) => entry.path).sort()).toEqual(['SKILL.md', 'asset.bin', 'local.txt', 'new.txt', 'other.txt']);
  });
});

describe('skills that refer to a sibling skill in the same source tree', () => {
  const skillMd = (name: string, body = '') => `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}`;
  const utf8 = (path: string, text: string) => ({ path, contentBase64: encodeBase64(new TextEncoder().encode(text), 'base64'), contentKind: 'utf8' as const });
  const bundle = {
    a: [utf8('a/SKILL.md', skillMd('a', 'Read [the setup](../b/SKILL.md) first and [the README](../README.md).')), utf8('a/notes.md', 'x')],
    b: [utf8('b/SKILL.md', skillMd('b'))],
    c: [utf8('c/SKILL.md', skillMd('c', 'Solo.'))],
  };
  const upload = (...names: (keyof typeof bundle)[]) => ({ kind: 'upload' as const, files: names.flatMap(name => bundle[name]) });
  const caller = { surface: 'ui' as const };
  const itemsOf = (result: unknown) => SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.install'].parse(result) as { items: { path: string; name: string; outsideReferences?: string[]; siblingSkills?: { path: string; references: string[] }[] }[] };

  it('marks the referenced sibling on the preview and keeps every other reference as the advisory', async () => {
    const h = harness();
    const { items } = itemsOf(await h.execute('skills.install', { source: upload('a', 'b', 'c'), dryRun: true }, caller));
    expect(items.find(item => item.path === 'a')).toMatchObject({
      outsideReferences: ['../b/SKILL.md', '../README.md'], siblingSkills: [{ path: 'b', references: ['../b/SKILL.md'] }],
    });
    expect(items.find(item => item.path === 'b')).not.toHaveProperty('siblingSkills');
    expect(items.find(item => item.path === 'c')).not.toHaveProperty('siblingSkills');
    // Without the sibling in the same tree the reference is only the advisory.
    expect(itemsOf(await h.execute('skills.install', { source: upload('a'), dryRun: true }, caller)).items[0]).not.toHaveProperty('siblingSkills');
  });

  it('adds exactly the selected skills, so an unticked sibling stays out', async () => {
    const h = harness();
    expect(await h.execute('skills.install', { source: upload('a', 'b', 'c'), selectPaths: ['a', 'b'] }, caller)).toMatchObject({ skillIds: ['skill-1', 'skill-2'] });
    expect(await h.execute('skills.install', { source: upload('a', 'b', 'c'), selectPaths: ['a'] }, caller)).toMatchObject({ skillIds: ['skill-1'] });
    expect(h.creates()).toBe(2);
  });

  it('reuses both upload identities and previews them as held without changing content or reach', async () => {
    const h = harness();
    const source = upload('a', 'b');
    expect(await h.execute('skills.install', { source }, caller)).toMatchObject({ skillIds: ['skill-1', 'skill-2'] });
    const before = [...h.artifacts.values()];
    const rules = h.rules();
    const result = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.install'].parse(await h.execute('skills.install', { source, dryRun: true }, caller));
    expect(result).toMatchObject({ items: [{ path: 'a', inLibrary: 'skill-1' }, { path: 'b', inLibrary: 'skill-2' }] });
    if (!('items' in result)) throw new Error('Expected preview');
    expect(result.items[0]).not.toHaveProperty('siblingSkills');
    expect(await h.execute('skills.install', { source, where: { kind: 'replace', rules: [] } }, caller))
      .toMatchObject({ skillIds: ['skill-1', 'skill-2'] });
    expect(h.creates()).toBe(2);
    expect([...h.artifacts.values()]).toEqual(before);
    expect(h.rules()).toEqual(rules);
    // The same identity can still be explicitly added to an Agent's current Session.
    expect(await h.execute('skills.install', { source }, { surface: 'agent', sessionId: 'session' }))
      .toMatchObject({ skillIds: ['skill-1', 'skill-2'], includedInSessionId: 'session' });
    expect(h.includes.get('session')).toEqual(['skill-1', 'skill-2']);
    expect(h.creates()).toBe(2);
  });

  it('matches uploaded content by name and digest across roots, preserving the different-content name-conflict path', async () => {
    const h = harness();
    await h.execute('skills.create', { name: 'b', files: [utf8('SKILL.md', skillMd('b'))] }, caller);
    expect(await h.execute('skills.install', { source: upload('a', 'b') }, caller))
      .toMatchObject({ skillIds: ['skill-2', 'skill-1'] });
    const relocated = { kind: 'upload', files: [utf8('other-root/SKILL.md', skillMd('b'))] };
    expect(await h.execute('skills.install', { source: relocated }, caller)).toMatchObject({ skillIds: ['skill-1'] });
    const changed = { kind: 'upload', files: [utf8('b/SKILL.md', skillMd('b', 'Different instructions.'))] };
    expect(await h.execute('skills.install', { source: changed }, caller)).toMatchObject({ skillIds: ['skill-3'] });
    expect(h.creates()).toBe(3);
    expect(h.artifacts.get('skill-1')?.body).not.toEqual(h.artifacts.get('skill-3')?.body);
  });

  it('does not create a second identity when two selected upload roots contain the same skill', async () => {
    const h = harness();
    const source = { kind: 'upload', files: [utf8('one/SKILL.md', skillMd('b')), utf8('two/SKILL.md', skillMd('b'))] };
    expect(await h.execute('skills.install', { source }, caller)).toMatchObject({ skillIds: ['skill-1'] });
    expect(h.creates()).toBe(1);
  });

  describe('from a registry item', () => {
    const repo = 'https://github.com/o/pack', commit = '1'.repeat(40);
    const itemFor = (name: 'a' | 'b') => {
      const text = (bundle[name][0] && new TextDecoder().decode(decodeBase64(bundle[name][0].contentBase64, 'base64')));
      return { summary: { sourceId: 'pack', kind: 'skill' as const, itemId: name, title: name, version: commit }, fetchedAt: 1,
        payload: { kind: 'skill' as const, skill: { ref: { kind: 'gitTree' as const, repo, path: name, commit, treeSha: '2'.repeat(40) }, skillMarkdown: text,
          files: [{ path: 'SKILL.md', size: text.length, unixMode: 0o644 as const, blobSha: '3'.repeat(40) }] } } };
    };
    const fileBytes = (name: 'a' | 'b') => [{ path: 'SKILL.md', unixMode: 0o644 as const, bytes: new TextEncoder().encode(skillMd(name, name === 'a' ? 'See [b](../b/SKILL.md).' : '')) }];
    const ports = (reads: string[]): RegistryPorts => ({
      readRegistryItem: async pointer => itemFor(pointer.itemId as 'a'),
      readRegistrySource: async () => ({ id: 'pack', title: 'Pack', format: 'git', kinds: ['skill'], url: repo, enabled: true, addedAt: 0, origin: { kind: 'user' }, removable: true }),
      filesForPointer: async pointer => fileBytes(pointer.itemId as 'a'),
      readLinkSkills: async (url, ref) => { reads.push(`${url}@${ref?.path}`); if (!ref) return [itemFor('a'), itemFor('b')];
        if (ref.path !== 'b') throw new Error('not_found'); return [itemFor('b')]; },
      fetchLinkSkillFiles: async (_url, item) => fileBytes(item.summary.itemId as 'a'),
    });
    const pointer = { kind: 'registry' as const, sourceId: 'pack', itemId: 'a', version: commit };

    it('offers the sibling at the commit the item is pinned to, installs both, and records the sibling as a link import', async () => {
      const reads: string[] = [];
      const h = harness(ports(reads));
      const { items } = itemsOf(await h.execute('skills.install', { source: pointer, dryRun: true }, caller));
      expect(items.map(item => item.path)).toEqual(['a', 'b']);
      expect(items[0]).toMatchObject({ siblingSkills: [{ path: 'b', references: ['../b/SKILL.md'] }] });
      expect(reads).toEqual([`${repo}@b`]);
      expect(h.creates()).toBe(0);
      expect(await h.execute('skills.install', { source: pointer }, caller)).toMatchObject({ skillIds: ['skill-1', 'skill-2'] });
      expect(readSkillLockV1(h.artifacts.get('skill-2')!.header).provenance).toMatchObject({ kind: 'link', url: repo, ref: { path: 'b', commit } });
    });

    it('adds only the item when the sibling is unticked', async () => {
      const h = harness(ports([]));
      expect(await h.execute('skills.install', { source: pointer, selectPaths: ['a'] }, caller)).toMatchObject({ skillIds: ['skill-1'] });
    });

    it('leaves a referred sibling the library already holds out of both the preview and the add of a whole link', async () => {
      const h = harness(ports([]));
      await h.execute('skills.install', { source: { ...pointer, itemId: 'b' } }, caller);
      const link = { kind: 'link' as const, url: repo };
      const preview = itemsOf(await h.execute('skills.install', { source: link, dryRun: true }, caller));
      expect(preview.items.find(item => item.path === 'a')).not.toHaveProperty('siblingSkills');
      expect(preview.items.find(item => item.path === 'b')).toMatchObject({ inLibrary: 'skill-1' });
      expect(await h.execute('skills.install', { source: link }, caller)).toMatchObject({ skillIds: ['skill-2', 'skill-1'] });
      expect(h.creates()).toBe(2);
    });

    it('does not add a sibling the library already holds', async () => {
      const h = harness(ports([]));
      await h.execute('skills.install', { source: pointer }, caller);
      expect(itemsOf(await h.execute('skills.install', { source: pointer, dryRun: true }, caller)).items[0])
        .toMatchObject({ path: 'a', inLibrary: 'skill-1' });
      expect(await h.execute('skills.install', { source: pointer }, caller)).toMatchObject({ skillIds: ['skill-1', 'skill-2'] });
      expect(h.creates()).toBe(2);
    });
  });
});
