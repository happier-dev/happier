import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { createPromptDocInLibrary, createPromptBundleInLibrary, updatePromptDocInLibrary, updatePromptBundleInLibrary, installPromptRegistryItemInLibrary, listPromptLibrary, setPromptDocFavorite, type PromptLibraryArtifactStore, type PromptLibraryStoredArtifact } from '../prompts/library/promptLibraryActionOperations.js';
import { getActionSpec } from './actionSpecs.js';
import { ActionsSettingsV1Schema, isActionEnabledByActionsSettings } from './actionSettings.js';
import { writeSessionContextIntentV1ToMetadata } from '../sessions/context/sessionContextV1.js';
import type { StoredContentPublicShareV1 } from '../sharing/storedContentPublicShareV1.js';
import type { PromptLibraryRecordV1 } from '../prompts/library/promptLibraryRowsV1.js';
import { MemoryDocReadResultV1Schema, MemoryMutationResultV1Schema } from '../prompts/library/memoryActionsV1.js';
import { MemoryDocBodyV1Schema } from '../prompts/library/memoryDocV1.js';
import { PromptDocArtifactHeaderV1Schema, PromptDocBodyV1Schema } from '../prompts/library/promptDocV2.js';
import type { ApprovalRequest } from '../approvals/approvalRequestV1.js';
import { resolvePromptStackSystemAppendBlocksV1 } from '../prompts/library/resolvePromptStackSystemAppendBlocksV1.js';
import { PromptBundleArtifactHeaderV1Schema, PromptBundleBodyV1Schema } from '../prompts/library/promptBundleSchemas.js';
import { RegistryItemV1Schema } from '../registries/registryItemsV1.js';
import { createSkillActionExecuteV1 } from '../prompts/library/skills/skillActionOperations.js';
import type { SkillRuleV1 } from '../reach/reachRuleV1.js';
import { readSkillLibraryCatalog } from '../prompts/library/skills/readSkillLibraryCatalog.js';
import { decodeBase64 } from '../crypto/base64.js';
import { computePromptBundleDigestV1 } from '../prompts/library/promptLibraryDigests.js';
import { LegacySkillRegistryInstallEffectsV1Schema } from '../prompts/library/promptLibraryActionOperations.js';
import { ApprovalRequestV2Schema } from '../approvals/approvalRequestV1.js';
import { resolveApprovalRequestApproveAdmission } from './actionApprovalPresentation.js';
import { skillFileFromBytesV1 } from '../prompts/library/skills/skillZipV1.js';

function createExecutor(overrides: Partial<ActionExecutorDeps> = {}) {
  const unavailable = async (): Promise<never> => { throw new Error('Unexpected Action dependency'); };
  return createActionExecutor({
    executionRunStart: unavailable,
    executionRunList: unavailable,
    executionRunGet: unavailable,
    detachedExecutionRunSend: unavailable,
    executionRunStop: unavailable,
    executionRunAction: unavailable,
    executionRunWait: unavailable,
    sessionOpen: unavailable,
    sessionFork: unavailable,
    sessionRollback: unavailable,
    sessionSpawnNew: unavailable,
    pathsListRecent: unavailable,
    machinesList: unavailable,
    serversList: unavailable,
    reviewEnginesList: unavailable,
    agentsBackendsList: unavailable,
    agentsModelsList: unavailable,
    sessionSendMessage: unavailable,
    sessionPermissionRespond: unavailable,
    sessionUserActionAnswer: unavailable,
    sessionModeSet: unavailable,
    sessionModesList: unavailable,
    sessionTargetPrimarySet: unavailable,
    sessionTargetTrackedSet: unavailable,
    sessionList: unavailable,
    sessionActivityGet: unavailable,
    sessionRecentMessagesGet: unavailable,
    daemonMemorySearch: unavailable,
    daemonMemoryGetWindow: unavailable,
    daemonMemoryEnsureUpToDate: unavailable,
    resetGlobalVoiceAgent: unavailable,
    ...overrides,
  });
}

const routingApprovalSettings = ActionsSettingsV1Schema.parse({ v: 1, actions: {}, approvalWaivedSurfaces: {
  'prompt_doc.create': ['ui', 'agent', 'mcp', 'cli'], 'prompt_doc.update': ['ui'],
  'prompt_bundle.update': ['ui', 'agent', 'mcp', 'cli', 'voice'],
  'prompt_registry.install': ['ui'],
} });

// Artifact and private-row persistence boundaries shared by these operation tests.
function createStoredLibrary(initial: readonly PromptLibraryStoredArtifact[] = []) {
  const artifacts = new Map(initial.map(artifact => [artifact.id, artifact]));
  let folderRecord: PromptLibraryRecordV1 = { key: 'folders', value: { v: 1,
    folders: [{ id: 'folder-1', name: 'Review' }] } };
  let folderRevision = 1;
  const store: PromptLibraryArtifactStore = {
    read: async artifactId => artifacts.get(artifactId) ?? null,
    create: async input => {
      const id = `artifact-${artifacts.size + 1}`;
      artifacts.set(id, { id, header: input.header, body: input.body, revision: { headerVersion: 1, bodyVersion: 1 } });
      return id;
    },
    update: async input => {
      const previous = artifacts.get(input.artifactId);
      if (!previous || input.expectedRevision.headerVersion !== previous.revision.headerVersion
        || input.expectedRevision.bodyVersion !== previous.revision.bodyVersion) {
        throw Object.assign(new Error('version_mismatch'), { code: 'version_mismatch' });
      }
      const revision = { headerVersion: previous.revision.headerVersion + 1, bodyVersion: previous.revision.bodyVersion + 1 };
      artifacts.set(previous.id, { ...previous, header: input.header, body: input.body, revision });
      return { revision };
    },
    organization: { serverId: 'home', assertCurrent: () => {},
      readCatalog: async () => ({ catalog: { status: 'ready', rows: [{ record: folderRecord, revision: folderRevision }], tombstones: [], diagnostics: [] } }),
      readArtifactHeader: async artifactId => {
        const artifact = artifacts.get(artifactId);
        return artifact?.header ? { header: artifact.header, owned: true } : null;
      },
      writeRecord: async input => {
        if (input.expectedRevision !== folderRevision) return { status: 'conflict', revision: folderRevision };
        folderRecord = input.record; folderRevision++;
        return { status: 'updated', revision: folderRevision, cursor: folderRevision };
      },
    },
  };
  return { store, artifacts, readOrganization: () => folderRecord };
}

function storedPromptDoc(): PromptLibraryStoredArtifact {
  return { id: 'doc-1', revision: { headerVersion: 1, bodyVersion: 1 },
    header: PromptDocArtifactHeaderV1Schema.parse({ v: 1, kind: 'prompt_doc.v2', title: 'Review prompt' }),
    body: JSON.stringify(PromptDocBodyV1Schema.parse({ v: 1, markdown: '# Review', createdAtMs: 1, updatedAtMs: 1 })) };
}

function fetchedRegistrySkill() {
  const markdown = '---\nname: frontend-design\ndescription: Design a page\n---\nInstructions';
  const files = [{ path: 'SKILL.md', contentBase64: Buffer.from(markdown).toString('base64'), contentKind: 'utf8' as const, unixMode: 0o644 }];
  const item = RegistryItemV1Schema.parse({ summary: { sourceId: 'repo', kind: 'skill', itemId: 'frontend-design', title: 'Frontend design', version: 'abc' },
    payload: { kind: 'skill', skill: { ref: { kind: 'gitTree', repo: 'https://github.com/a/b', path: 'frontend-design', commit: 'abc', treeSha: 'tree' }, skillMarkdown: markdown,
      files: [{ path: 'SKILL.md', size: Buffer.byteLength(markdown), unixMode: 0o644, blobSha: 'blob' }] } }, fetchedAt: 1 });
  return { item, files };
}

describe('createActionExecutor (prompt library actions)', () => {
  it('keeps memory admission, writes and reads in the invoking Account Artifact store', async () => {
    let stored: PromptLibraryStoredArtifact = { id: 'memory', revision: { headerVersion: 1, bodyVersion: 1 },
      header: { v: 1, kind: 'memory_doc.v1', title: 'Memory' },
      body: JSON.stringify(MemoryDocBodyV1Schema.parse({ v: 1, index: [], topics: [] })) };
    const requesterStore: PromptLibraryArtifactStore = { read: async () => stored,
      list: async () => ({ items: [{ id: stored.id, header: stored.header, updatedAtMs: 10 }], coverage: 'complete' }),
      update: async input => { stored = { ...stored, body: input.body, revision: { headerVersion: 2, bodyVersion: 2 } }; } };
    const daemonStore: PromptLibraryArtifactStore = { read: async () => { throw new Error('Daemon credential cannot read requester content'); },
      update: async () => { throw new Error('Daemon credential cannot write requester content'); } };
    const executor = createExecutor({ memoryLibrary: { serverId: 'home', store: daemonStore,
      // Account-scoped Artifact persistence is the external transport boundary.
      ...{ storeForContext: (context: import('./actionExecutor.js').ActionExecutorContext) =>
        context.runtimeAccountId === 'requester' ? requesterStore : daemonStore },
      randomId: () => 'requester-fact', nowMs: () => 10,
      readExposure: async () => ({ grants: { artifactId: 'memory', ownerAccountId: 'requester', access: 'owner', grants: [] },
        publicShares: { publicShares: [] } }),
    } });
    const ref = { kind: 'doc', serverId: 'home', artifactId: 'memory' } as const;
    const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
      serverId: 'home', runtimeAccountId: 'requester' } as const;
    const saved = await executor.execute('memory.remember', { ref, expectedRevision: stored.revision, text: 'Use the requester store.' }, context);
    expect(saved, JSON.stringify(saved)).toMatchObject({ ok: true, result: { factId: 'requester-fact' } });
    expect(await executor.execute('memory.read', { ref }, context)).toMatchObject({ ok: true });
    expect(await executor.execute('memory.list', { serverId: 'home' }, context)).toMatchObject({ ok: true,
      result: { items: [{ artifactId: 'memory' }], coverage: 'complete' } });
    expect(JSON.parse(stored.body!).index).toEqual([expect.objectContaining({ text: 'Use the requester store.' })]);
  });
  it.each(['memory.remember', 'memory.update'] as const)('admits one Allow-mode %s once and uses its one body read for the write', async actionId => {
    const initial = { id: 'existing', text: 'Prefer green tea', createdAtMs: 1, sourceSessionRef: null };
    const { store, artifacts } = createStoredLibrary([{ id: 'memory', revision: { headerVersion: 2, bodyVersion: 7 },
      header: { v: 1, kind: 'memory_doc.v1', title: 'Memory' },
      body: JSON.stringify({ v: 1, index: [initial], topics: [] }) }]);
    let bodies = 0;
    let admissions = 0;
    const text = actionId === 'memory.remember' ? initial.text : 'Use PostgreSQL for storage';
    const executor = createExecutor({ memoryLibrary: { serverId: 'home', randomId: () => 'new-fact', nowMs: () => 10,
      store: { ...store, read: async (id, options) => { bodies++; return store.read(id, options); } },
      readExposure: async artifactId => { admissions++; return {
        grants: { artifactId, ownerAccountId: 'person', access: 'owner', grants: [] }, publicShares: { publicShares: [] },
      }; },
    } });
    const result = await executor.execute(actionId, {
      ref: { kind: 'doc', artifactId: 'memory', serverId: 'home' }, expectedRevision: artifacts.get('memory')!.revision,
      text, ...(actionId === 'memory.update' ? { factId: initial.id } : {
        duplicateChoice: { kind: 'update', factId: initial.id, expectedRevision: artifacts.get('memory')!.revision },
      }),
    }, { surface: 'agent', serverId: 'home', authority: 'account_automation', actionCaller: { kind: 'host' },
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: {}, approvalWaivedSurfaces: { [actionId]: ['agent'] } }) });
    expect(result).toMatchObject({ ok: true, result: { ok: true, factId: 'new-fact' } });
    expect(MemoryDocBodyV1Schema.parse(JSON.parse(artifacts.get('memory')!.body!)).index)
      .toContainEqual(expect.objectContaining({ id: 'new-fact', text }));
    expect({ admissions, bodies }).toEqual({ admissions: 1, bodies: 1 });
  });
  it.each(['account', 'project', 'session-account', 'session-project'] as const)(
    'reads one Memory body per %s preparation and still rejects a later revision', async destination => {
      const { store, artifacts } = createStoredLibrary([{ id: 'memory', revision: { headerVersion: 2, bodyVersion: 7 },
        header: { v: 1, kind: 'memory_doc.v1', title: 'Memory' },
        body: JSON.stringify({ v: 1, index: [], topics: [{ title: 'Payments', summary: 'Settlement policy', facts: [
          { id: 'settlement', text: 'Settlement retries reuse the original idempotency key', createdAtMs: 1, sourceSessionRef: null },
        ] }] }),
      }]);
      const reads: string[] = [];
      const entry = { id: 'memory', ref: { kind: 'doc' as const, artifactId: 'memory', serverId: 'home' },
        enabled: true, placement: 'system_append' as const };
      const executor = createExecutor({ memoryLibrary: { serverId: 'home', randomId: () => 'new-fact', nowMs: () => 10,
        store: { ...store, read: async (id, options) => { reads.push(id); return store.read(id, options); } },
        readArtifactHeaders: async refs => refs.map(ref => artifacts.get(ref.artifactId)?.header ?? null),
        readScopeContext: async () => ({ entries: [entry], safety: 'safe', attachMemory: async () => false }),
        readSession: async () => ({ metadata: { work: { memoryEnabled: true, promptStack: [] } }, revision: 3 }),
        readInheritedContext: async () => ({ projectEntries: destination === 'session-project' ? [entry] : [],
          readAccountContext: async () => ({ accountEntries: [entry], attachAccountMemory: async () => false }) }),
        readExposure: async artifactId => ({ grants: { artifactId, ownerAccountId: 'person', access: 'owner', grants: [] },
          publicShares: { publicShares: [] } }),
      } });
      const context = { surface: 'ui' as const, serverId: 'home', authority: 'present_user' as const, runtimeAccountId: 'person' };
      const target = destination === 'account' ? { scope: 'account' as const }
        : destination === 'project' ? { scope: 'project' as const, projectRef: { serverId: 'home', projectKey: 'payments' } }
        : { sessionRef: { serverId: 'home', sessionId: 'ordinary' }, expectedMetadataRevision: 3 };
      // A topic candidate must be found from that same read, not only the projected index.
      const duplicate = await executor.prepare('memory.remember', { ...target, text: 'Settlement retries reuse the idempotency key' }, context);
      expect(duplicate).toMatchObject({ kind: 'settled', result: { ok: true, result: {
        errorCode: 'memory_duplicate_choice_required', candidates: [{ factId: 'settlement', topic: 'Payments' }],
      } } });
      expect(reads).toEqual(['memory']);
      reads.length = 0;
      const prepared = await executor.prepare('memory.remember', { ...target, text: 'Prefer green tea' }, context);
      expect(prepared.kind).toBe('ready');
      expect(reads).toEqual(['memory']);
      if (prepared.kind !== 'ready') throw new Error('Expected private Memory preparation');
      const current = artifacts.get('memory')!;
      artifacts.set('memory', { ...current, revision: { headerVersion: 3, bodyVersion: 8 } });
      reads.length = 0;
      expect(await prepared.invocation.run()).toMatchObject({ ok: false, errorCode: 'version_mismatch' });
      expect(reads).not.toHaveLength(0);
      expect(artifacts.get('memory')?.body).toBe(current.body);
    },
  );
  it.each(['update', 'replace'] as const)('keeps edit A and candidate B distinct through the real Memory Action (%s)', async kind => {
    const edited = { id: 'A', text: 'Prefer green tea', createdAtMs: 1, sourceSessionRef: null, expiresAtMs: 500 };
    const candidate = { id: 'B', text: 'Use PostgreSQL for storage', createdAtMs: 2, sourceSessionRef: null, expiresAtMs: 900 };
    const { store, artifacts } = createStoredLibrary([{ id: 'memory', revision: { headerVersion: 2, bodyVersion: 7 },
      header: { v: 1, kind: 'memory_doc.v1', title: 'Memory' }, body: JSON.stringify({ v: 1, index: [edited, candidate], topics: [] }) }]);
    const executor = createExecutor({ memoryLibrary: { serverId: 'home', store, nowMs: () => 10, randomId: () => 'replacement',
      readExposure: async () => ({ grants: { artifactId: 'memory', ownerAccountId: 'person', access: 'owner', grants: [] },
        publicShares: { publicShares: [] } }),
    } });
    const context = { surface: 'ui' as const, serverId: 'home', authority: 'present_user' as const, runtimeAccountId: 'person' };
    const input = { ref: { kind: 'doc' as const, artifactId: 'memory', serverId: 'home' },
      expectedRevision: { headerVersion: 2, bodyVersion: 7 }, factId: edited.id, text: 'Prefer PostgreSQL for storage',
      ...(kind === 'update' ? { expiresAtMs: null } : {}) };
    expect(await executor.execute('memory.update', input, context)).toMatchObject({ ok: true, result: {
      ok: false, errorCode: 'memory_duplicate_choice_required', candidates: [{ factId: candidate.id }],
    } });
    const replay = { ...input, duplicateChoice: { kind, factId: candidate.id, expectedRevision: input.expectedRevision } };
    expect(await executor.execute('memory.update', replay, context)).toMatchObject({ ok: true, result: {
      ok: true, factId: 'replacement', revision: { headerVersion: 3, bodyVersion: 8 },
    } });
    const saved = artifacts.get('memory')!;
    const body = MemoryDocBodyV1Schema.parse(JSON.parse(saved.body!));
    expect(body.index).toEqual([{ id: 'replacement', text: input.text, createdAtMs: 10, sourceSessionRef: null,
      supersedes: candidate.id, ...(kind === 'replace' ? { expiresAtMs: edited.expiresAtMs } : {}) }]);
    expect(body.topics.find(topic => topic.title === 'archive')?.facts).toEqual(kind === 'update'
      ? [candidate, edited] : [edited, candidate]);
    expect(await executor.execute('memory.update', replay, context)).toMatchObject({ ok: false, errorCode: 'version_mismatch' });
    expect(artifacts.get('memory')).toBe(saved);
  });
  it('saves decisions through memory admission with host-only approval and server source disclosure metadata', async () => {
    for (const [authority, bypassApprovals, approvedBy] of [
      ['present_user', false, { accountId: 'person', atMs: 10 }],
      ['account_automation', false, null],
      ['present_user', true, null],
    ] as const) {
      const { store, artifacts } = createStoredLibrary([{ id: 'memory', revision: { headerVersion: 1, bodyVersion: 1 },
        header: { v: 1, kind: 'memory_doc.v1', title: 'Memory' }, body: JSON.stringify({ v: 1, index: [], topics: [] }) }]);
      let source: unknown;
      const executor = createExecutor({ memoryLibrary: { serverId: 'home', nowMs: () => 10, randomId: () => 'decision',
        store: { ...store, update: async input => { source = input.memoryDecisionSource; return store.update(input); } },
        readExposure: async () => ({ grants: { artifactId: 'memory', ownerAccountId: 'person', access: 'owner', grants: [] },
          publicShares: { publicShares: [] } }),
      } });
      const sourceMessageRef = { kind: 'session' as const, session: { serverId: 'home', sessionId: 'source' }, messageId: 'committed' };
      const input = { ref: { kind: 'doc' as const, artifactId: 'memory', serverId: 'home' },
        expectedRevision: { headerVersion: 1, bodyVersion: 1 }, text: 'Use PostgreSQL', reason: 'Reviewed the alternatives', sourceMessageRef };
      const context = { surface: 'ui' as const, serverId: 'home', authority, bypassApprovals, runtimeAccountId: 'person' };
      expect(await executor.execute('memory.decision.save', { ...input, approvedBy: { accountId: 'forged', atMs: 1 } }, context))
        .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
      expect(await executor.execute('memory.decision.save', input, context)).toMatchObject({ ok: true, result: { factId: 'decision' } });
      expect(source).toEqual(sourceMessageRef);
      expect(JSON.parse(artifacts.get('memory')!.body!).index[0]).toMatchObject({ text: input.text,
        decision: { reason: input.reason, sourceMessageRef, approvedBy } });
    }
  });
  it('retains a lazy first decision and its admitted source when scope attachment conflicts', async () => {
    const library = createStoredLibrary();
    let source: unknown;
    const executor = createExecutor({ memoryLibrary: { serverId: 'home', randomId: () => 'first-decision', nowMs: () => 10,
      store: { ...library.store, create: async input => { source = input.memoryDecisionSource; return library.store.create!(input); } },
      readScopeContext: async () => ({ entries: [], safety: 'safe', attachMemory: async () => false }),
      readExposure: async () => { throw new Error('No existing document'); },
    } });
    const sourceMessageRef = { kind: 'session' as const, session: { serverId: 'home', sessionId: 'source' }, messageId: 'committed' };
    expect(await executor.execute('memory.decision.save', { scope: 'account', text: 'Use PostgreSQL', reason: 'Reviewed', sourceMessageRef },
      { surface: 'ui', authority: 'present_user', runtimeAccountId: 'person', serverId: 'home' }))
      .toMatchObject({ ok: true, result: { factId: 'first-decision', attachment: 'conflict', ref: { artifactId: 'artifact-1' } } });
    expect(source).toEqual(sourceMessageRef);
    expect(JSON.parse(library.artifacts.get('artifact-1')!.body!).index[0].decision)
      .toEqual({ reason: 'Reviewed', sourceMessageRef, approvedBy: { accountId: 'person', atMs: 10 } });
  });
  it.each(['ui', 'agent', 'mcp', 'cli'] as const)('returns the same duplicate review before approval on %s and persists only the explicit current choice', async surface => {
    const original = { id: 'old', text: 'Use PostgreSQL', createdAtMs: 1, sourceSessionRef: null };
    const { store, artifacts } = createStoredLibrary([{ id: 'memory', header: { v: 1, kind: 'memory_doc.v1', title: 'Memory' },
      revision: { headerVersion: 1, bodyVersion: 1 }, body: JSON.stringify({ v: 1, index: [original], topics: [] }) }]);
    let approvals = 0;
    const executor = createExecutor({ memoryLibrary: { serverId: 'home', store, randomId: () => 'new', nowMs: () => 10,
      readExposure: async artifactId => ({ grants: { artifactId, ownerAccountId: 'owner', access: 'owner', grants: [
        { principal: { kind: 'team', teamId: 'team' }, accessLevel: 'edit', createdByAccountId: 'owner', createdAt: 1, display: { name: null } },
      ] }, publicShares: { publicShares: [] } }) },
      approvalsCreate: async () => { approvals++; return { artifactId: 'approval' }; } });
    const input = { ref: { kind: 'doc' as const, artifactId: 'memory', serverId: 'home' }, expectedRevision: artifacts.get('memory')!.revision,
      text: 'Prefer PostgreSQL' };
    const context = { surface, serverId: 'home', authority: surface === 'ui' ? 'present_user' as const : 'account_automation' as const,
      actionCaller: { kind: 'host' as const }, actionRequestId: 'remember', actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: {},
        approvalWaivedSurfaces: { 'memory.remember': [surface] } }) };
    const result = await executor.execute('memory.remember', input, context);
    expect(result).toMatchObject({ ok: true, result: { ok: false, errorCode: 'memory_duplicate_choice_required',
      ref: input.ref, revision: input.expectedRevision, candidates: [{ factId: 'old', match: 'related' }] } });
    if (!result.ok) throw new Error('Expected admitted review');
    expect(getActionSpec('memory.remember').outputSchema.parse(result.result)).toEqual(result.result);
    expect(approvals).toBe(0);
    expect(artifacts.get('memory')!.revision).toEqual(input.expectedRevision);
    const saved = await executor.execute('memory.remember', { ...input, duplicateChoice: { kind: 'replace', factId: 'old', expectedRevision: input.expectedRevision } }, context);
    expect(saved).toMatchObject({ ok: true, result: { ok: true, factId: 'new', revision: artifacts.get('memory')!.revision } });
    expect(MemoryDocBodyV1Schema.parse(JSON.parse(artifacts.get('memory')!.body!))).toMatchObject({
      index: [{ id: 'new', supersedes: 'old' }], topics: [{ title: 'archive', facts: [original] }],
    });
    expect(await executor.execute('memory.remember', { ...input, text: 'Stale intent', duplicateChoice: { kind: 'keep_both', expectedRevision: input.expectedRevision } }, context))
      .toMatchObject({ ok: false, errorCode: 'version_mismatch' });
  });
  it('reviews and replays a CLI-created skill through the spec-owned approval and real skill writer', async () => {
    const { store, artifacts } = createStoredLibrary();
    let approval: ApprovalRequest | null = null;
    let rules: SkillRuleV1[] = [];
    let revision = 1;
    const markdown = '---\nname: release-check\ndescription: Review the release\n---\nCheck the deployed version.\n';
    const files = [skillFileFromBytesV1('SKILL.md', new TextEncoder().encode(markdown), 0o644),
      skillFileFromBytesV1('scripts/check.sh', new TextEncoder().encode('#!/bin/sh\nprintf "checked"\n'), 0o755),
      skillFileFromBytesV1('asset.bin', new Uint8Array([0, 255, 1]), 0o644),
      skillFileFromBytesV1('empty.txt', new Uint8Array(), 0o644)];
    const skills = createSkillActionExecuteV1({ store, randomId: () => 'rule', nowMs: () => 4,
      skillRules: { serverId: 'home', assertCurrent: () => {}, ruleWriteContext: () => ({ nowMs: 4, newId: () => 'rule' }),
        listSkills: signal => readSkillLibraryCatalog({ list: async () => ({ coverage: 'complete', items: [...artifacts.values()].map(artifact => ({
          artifactId: artifact.id, header: artifact.header, body: artifact.body,
        })) }) }, signal),
        readCatalog: async () => ({ catalog: { status: 'ready', rows: [{ record: { key: 'skill-rules', value: { v: 1, rules } }, revision }], diagnostics: [], tombstones: [] } }),
        writeRecord: async input => { if (input.record.key === 'skill-rules') rules = input.record.value.rules; return { status: 'updated', revision: ++revision, cursor: revision }; },
      }, includeInSession: async () => ({ ok: true, state: 'on', previous: 'inherit', applyTiming: { t: 'next_turn' } }),
    });
    // Only Artifact/approval persistence and cross-process replay are boundaries.
    const approvalPorts: Partial<ActionExecutorDeps> = {
      isApprovalExecutionOriginCurrent: async ({ origin }) => origin.serverId === 'home',
      approvalsCreate: async ({ request }) => { approval = ApprovalRequestV2Schema.parse(request); return { artifactId: 'skill-proposal' }; },
      approvalsGet: async () => approval,
      approvalsUpdate: async ({ request }) => { approval = ApprovalRequestV2Schema.parse(request); return { ok: true }; },
    };
    const origin = createExecutor({ ...approvalPorts,
      skillActionExecute: ({ actionId, input, context }) => skills(actionId, input, { surface: context.surface ?? null }),
    });
    const ui = createExecutor({ ...approvalPorts,
      approvalRequestApprovedReplay: ({ artifactId }) => origin.replayApprovedApprovalRequest({ artifactId }),
    });
    const actionArgs = getActionSpec('skills.create').inputSchema.parse({ name: 'release-check', files });
    const proposed = await origin.execute('skills.create', actionArgs, { surface: 'cli', authority: 'account_automation',
      actionCaller: { kind: 'host' }, serverId: 'home', defaultSessionMachineId: 'machine-1', actionRequestId: 'create-skill' });
    expect(proposed).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(artifacts.size).toBe(0);
    const request = ApprovalRequestV2Schema.parse(approval);
    expect(request).toMatchObject({ actionId: 'skills.create', status: 'open', actionArgs });
    const admission = resolveApprovalRequestApproveAdmission(request);
    expect(admission).toMatchObject({ status: 'available' });
    expect(admission.presentation.rows).toContainEqual(expect.objectContaining({ path: 'name', value: 'release-check' }));
    const reviewed = admission.presentation.rows.find(row => row.path === 'files');
    expect(reviewed).toMatchObject({ kind: 'value' });
    if (!reviewed || reviewed.kind !== 'value') throw new Error('Missing file review');
    const review = JSON.parse(reviewed.value);
    expect(review).toContainEqual(expect.objectContaining({ path: 'SKILL.md', content: markdown }));
    expect(review).toContainEqual(expect.objectContaining({ path: 'scripts/check.sh', unixMode: 0o755, content: '#!/bin/sh\nprintf "checked"\n' }));
    expect(review).toContainEqual(expect.objectContaining({ path: 'asset.bin', contentKind: 'binary', sizeBytes: 3 }));
    expect(review).toContainEqual(expect.objectContaining({ path: 'empty.txt', content: '', sizeBytes: 0 }));
    expect(JSON.stringify(request.preview)).not.toContain(files[0]!.contentBase64);
    expect(resolveApprovalRequestApproveAdmission({ ...request, actionArgs: { name: 'release-check' } }))
      .toMatchObject({ status: 'unavailable', reason: 'context_unavailable' });
    const decided = await ui.execute('approval.request.decide', { artifactId: 'skill-proposal', decision: 'approve' },
      { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'home' });
    expect(decided).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
    expect(artifacts.size).toBe(1);
    const storedFiles = PromptBundleBodyV1Schema.parse(JSON.parse(artifacts.get('artifact-1')!.body!)).entries;
    expect(storedFiles.filter(file => file.path !== 'SKILL.md')).toEqual(files.filter(file => file.path !== 'SKILL.md'));
    expect(new TextDecoder().decode(decodeBase64(storedFiles.find(file => file.path === 'SKILL.md')!.contentBase64)))
      .toContain('Check the deployed version.');
    expect(rules).toMatchObject([{ skillId: 'artifact-1', target: { t: 'allMachines' }, enabled: true }]);
  });
  it('preserves admitted empty organization strings for domain normalization', async () => {
    const saved: string[] = [];
    const store = { read: async () => null, update: async () => {},
      create: async (input: { body: string }) => { saved.push(input.body); return 'doc'; } };
    const executor = createExecutor({ promptDocCreate: async ({ signal, ...request }) => createPromptDocInLibrary({ store, request, signal }) });
    expect(await executor.execute('prompt_doc.create', { title: 'Doc', markdown: 'Text', folderId: null, tags: ['', '  '] }, { surface: 'ui', actionsSettings: routingApprovalSettings }))
      .toMatchObject({ ok: true, result: { artifactId: 'doc' } });
    expect(saved).toHaveLength(1);
    // Empty folder strings were also admitted; the domain still owns their placement failure.
    expect(await executor.execute('prompt_doc.create', { title: 'Doc', markdown: 'Text', folderId: '', tags: [''] }, { surface: 'ui', actionsSettings: routingApprovalSettings }))
      .toMatchObject({ ok: false, error: 'artifact_organization_unavailable' });
    expect(saved).toHaveLength(1);
    expect(getActionSpec('prompt_doc.create').inputSchema.safeParse({ title: 'Doc', markdown: 'Text', folderId: '',
      createFolder: { id: '', name: 'New', expectedRevision: 'absent' } }).success).toBe(false);
  });

  it('admits one exact folder-and-document Save before either persistent effect', async () => {
    let approval: ApprovalRequest | null = null;
    let folderEnabled = true;
    let folderRevision = 3;
    let record: PromptLibraryRecordV1 = { key: 'folders', value: { v: 1, folders: [] } };
    const artifacts = new Map<string, PromptLibraryStoredArtifact>();
    const port = {
      serverId: 'home', assertCurrent: () => {},
      readCatalog: async () => ({ catalog: { status: 'ready' as const, rows: [{ record, revision: folderRevision }], tombstones: [], diagnostics: [] } }),
      writeRecord: async (input: { record: PromptLibraryRecordV1; expectedRevision: number | 'absent' }) => {
        if (input.expectedRevision !== folderRevision) return { status: 'conflict' as const, revision: folderRevision };
        record = input.record; folderRevision++;
        return { status: 'updated' as const, revision: folderRevision, cursor: folderRevision };
      },
      readArtifactHeader: async (id: string) => artifacts.has(id) ? { header: artifacts.get(id)!.header, owned: true } : null,
    };
    const store = { organization: port, read: async (id: string) => artifacts.get(id) ?? null, update: async () => {},
      create: async (input: { header: Readonly<Record<string, unknown>>; body: string }) => {
        artifacts.set('saved', { id: 'saved', ...input, revision: { headerVersion: 1, bodyVersion: 1 } }); return 'saved';
      } };
    const readSaveSettings = () => ActionsSettingsV1Schema.parse({ v: 1,
      actions: { 'artifact.folders.create': { enabled: folderEnabled, approvalRequiredSurfaces: ['ui'] } },
      approvalWaivedSurfaces: { 'prompt_doc.create': ['ui'] } });
    const executor = createExecutor({ artifactFolders: port,
      isActionEnabled: (id, context) => isActionEnabledByActionsSettings(id, readSaveSettings(), { surface: context.surface }),
      isApprovalExecutionOriginCurrent: async () => true,
      approvalsCreate: async ({ request }) => { approval = request; return { artifactId: 'save-approval' }; },
      approvalsGet: async () => approval, approvalsUpdate: async ({ request }) => { approval = request; return { ok: true }; },
      promptDocCreate: async ({ signal, ...request }) => createPromptDocInLibrary({ store, request, signal }),
    });
    const input = { title: 'Saved', markdown: 'Reviewed text', folderId: 'new-folder',
      createFolder: { id: 'new-folder', name: 'New folder', expectedRevision: 3 } };
    const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId: 'home',
      serverIdentityId: 'home', runtimeAccountId: 'owner', actionRequestId: 'save',
      get actionsSettings() { return readSaveSettings(); } };
    folderEnabled = false;
    expect(await executor.execute('prompt_doc.create', input, context)).toMatchObject({ ok: false, errorCode: 'action_disabled' });
    expect(record.value).toMatchObject({ folders: [] }); expect(artifacts.size).toBe(0);
    folderEnabled = true;
    expect(await executor.execute('prompt_doc.create', input, context)).toMatchObject({ ok: true });
    expect(approval).toMatchObject({ status: 'open', actionId: 'prompt_doc.create', actionArgs: input });
    // The inline card consumes the same demanded-child plan as dispatch;
    // a separate folder-policy branch must not hide this required step.
    expect(approval).toMatchObject({ preview: { hostReviewedChildren: { children: expect.arrayContaining([
      { action: 'artifact.folders.create', role: expect.any(String),
        input: getActionSpec('artifact.folders.create').inputSchema.parse(input.createFolder) },
    ]) } } });
    expect(record.value).toMatchObject({ folders: [] }); expect(artifacts.size).toBe(0);
    await executor.execute('approval.request.decide', { artifactId: 'save-approval', decision: 'reject' }, context);
    expect(record.value).toMatchObject({ folders: [] }); expect(artifacts.size).toBe(0);
    await executor.execute('prompt_doc.create', input, { ...context, actionRequestId: 'save-again' });
    folderEnabled = false;
    await executor.execute('approval.request.decide', { artifactId: 'save-approval', decision: 'approve' }, context);
    expect(record.value).toMatchObject({ folders: [] }); expect(artifacts.size).toBe(0);
    folderEnabled = true;
    await executor.execute('prompt_doc.create', input, { ...context, actionRequestId: 'save-final' });
    const decided = await executor.execute('approval.request.decide', { artifactId: 'save-approval', decision: 'approve' }, context);
    expect(decided, JSON.stringify(decided)).toMatchObject({ ok: true });
    expect(approval, JSON.stringify(approval)).toMatchObject({ status: 'executed' });
    expect(record.value).toMatchObject({ folders: [{ id: 'new-folder', name: 'New folder' }], artifactHeadersById: { saved: { folderId: 'new-folder' } } });
    expect(artifacts.get('saved')?.body).toContain('Reviewed text');
  });

  it('retains generic bundle update semantics and reviewed revisions on every released mutation surface', async () => {
    let stored: PromptLibraryStoredArtifact | null = null;
    const readStored = () => stored;
    const store = { read: async () => stored,
      update: async (input: { expectedRevision: PromptLibraryStoredArtifact['revision']; header: Readonly<Record<string, unknown>>; body: string }) => {
        expect(input.expectedRevision).toEqual(stored!.revision);
        stored = { id: 'bundle', header: input.header, body: input.body, revision: { headerVersion: 2, bodyVersion: 2 } };
        return { revision: stored.revision };
      } };
    const ports = { promptBundleUpdate: async (request: Parameters<typeof updatePromptBundleInLibrary>[0]['request']) => updatePromptBundleInLibrary({ store, request }) };
    const executor = createExecutor(ports);
    const entries = [{ path: 'README.md', contentBase64: 'U2tpbGw=', contentKind: 'utf8' as const },
      { path: 'support.bin', contentBase64: 'AAE=', contentKind: 'binary' as const, unixMode: 0o600 }];
    for (const surface of ['ui', 'agent', 'mcp', 'cli', 'voice'] as const) {
      const context = { surface, actionsSettings: routingApprovalSettings };
      stored = { id: 'bundle', revision: { headerVersion: 1, bodyVersion: 1 },
        header: PromptBundleArtifactHeaderV1Schema.parse({ v: 1, kind: 'prompt_bundle.v2', title: 'Bundle',
          bundleSchemaId: 'bundle.generic_v1', origin: 'user' }),
        body: JSON.stringify(PromptBundleBodyV1Schema.parse({ v: 1, entries, createdAtMs: 1, updatedAtMs: 1 })) };
      expect(readStored()?.header).toMatchObject({ origin: 'user' });
      const changed = [...entries, { path: 'extra.txt', contentBase64: 'RXh0cmE=', contentKind: 'utf8' as const },
        ...['a:b', 'CON.md', 'file '].map(path => ({ path, contentBase64: 'eA==', contentKind: 'utf8' as const }))];
      expect(await executor.execute('prompt_bundle.update', { artifactId: 'bundle', title: 'Edited', entries: changed,
        expectedRevision: { headerVersion: 1, bodyVersion: 1 } }, context))
        .toMatchObject({ ok: true, result: { revision: { headerVersion: 2, bodyVersion: 2 } } });
      expect(JSON.parse(readStored()!.body!).entries).toEqual(changed);
      expect(readStored()?.header?.bundleSchemaId).toBe('bundle.generic_v1');
      expect(await executor.execute('prompt_bundle.update', { artifactId: 'bundle', title: 'Stale', entries,
        expectedRevision: { headerVersion: 1, bodyVersion: 1 } }, context)).toMatchObject({ ok: false, errorCode: 'version_mismatch' });
      expect(JSON.parse(readStored()!.body!).entries).toEqual(changed);
    }
  });

  it('rejects forged provenance, mixed bundle edits and folder operands targeting a different assignment', () => {
    const create = getActionSpec('skills.create').inputSchema;
    const entries = [{ path: 'SKILL.md', contentBase64: 'U2tpbGw=', contentKind: 'utf8' }];
    expect(create.safeParse({ name: 'skill', files: entries, origin: 'imported' }).success).toBe(false);
    expect(create.safeParse({ name: 'skill', files: [{ ...entries[0], authority: 'host' }] }).success).toBe(false);
    expect(getActionSpec('prompt_bundle.update').inputSchema.safeParse({ artifactId: 'bundle', title: 'Skill', skillMarkdown: 'Skill', entries }).success).toBe(false);
    expect(getActionSpec('prompt_doc.create').inputSchema.safeParse({ title: 'Doc', markdown: 'Text', folderId: 'other',
      createFolder: { id: 'new', name: 'New', expectedRevision: 3 } }).success).toBe(false);
  });
  it.each(['memory.remember', 'memory.decision.save'] as const)('keeps an agent %s proposal unchanged until the existing approval owner approves it', async actionId => {
    let request: ApprovalRequest | null = null;
    let stored: PromptLibraryStoredArtifact = { id: 'memory', revision: { headerVersion: 1, bodyVersion: 1 },
      header: { v: 1, kind: 'memory_doc.v1', title: 'Memory' }, body: JSON.stringify({ v: 1, index: [], topics: [] }) };
    // Artifact and approval persistence are external boundaries; admission,
    // reviewed-target binding, approval replay and memory mutation remain real.
    const approvalPorts: Partial<ActionExecutorDeps> = {
      isApprovalExecutionOriginCurrent: async ({ origin }) => origin.serverId === 'home'
        && origin.machineId === 'machine-1' && origin.sessionId === 'lead',
      approvalsCreate: async ({ request: value }) => { request = value; return { artifactId: 'proposal' }; },
      approvalsGet: async () => request,
      approvalsUpdate: async ({ request: value }) => { request = value; return { ok: true }; },
    };
    const originExecutor = createExecutor({ ...approvalPorts, isActionApprovalRequired: undefined,
      memoryLibrary: { serverId: 'home', nowMs: () => 10, randomId: () => 'approved-fact',
        store: { read: async () => stored, update: async input => {
          stored = { ...stored, body: input.body, revision: { headerVersion: 2, bodyVersion: 2 } };
        } },
        readExposure: async () => ({ grants: { artifactId: 'memory', ownerAccountId: 'owner', access: 'owner', grants: [] },
          publicShares: { publicShares: [] } }),
      },
    });
    const uiExecutor = createExecutor({ ...approvalPorts, approvalRequestApprovedReplay: async ({ artifactId, request: approved, context }) => {
      // This port is the daemon RPC boundary. Replay, strict Artifact admission
      // and execution remain real in the separate originating executor.
      expect(approved).toMatchObject({ v: 2, status: 'approved', executionOriginV1: {
        serverId: 'home', machineId: 'machine-1', sessionId: 'lead', surface: 'agent',
      } });
      expect(context).toMatchObject({ surface: 'ui', authority: 'present_user' });
      if (actionId === 'memory.decision.save' && approved.decision) {
        // Writable Artifact metadata cannot select a different person for this same-Account replay.
        request = { ...approved, decision: { ...approved.decision, decidingAccountId: 'forged-person' } };
      }
      return originExecutor.replayApprovedApprovalRequest({ artifactId, callerAuthority: context.authority });
    } });
    const original = stored;
    const prepareWorker = () => resolvePromptStackSystemAppendBlocksV1({ surface: 'coding', memoryEnabled: true,
      scope: { serverId: 'home', accountId: 'owner', sessionId: 'worker' },
      sessionEntries: [{ id: 'session.memory', ref: { kind: 'doc', artifactId: 'memory', serverId: 'home' },
        enabled: true, placement: 'system_append' }], readArtifact: async () => stored });
    expect(await originExecutor.execute('approval.request.create', { actionId,
      actionArgs: { ref: { kind: 'doc', artifactId: 'memory', serverId: 'home' }, expectedRevision: stored.revision,
        text: 'Use the canonical Context owner.', ...(actionId === 'memory.decision.save' ? {
          reason: 'Reviewed the owner', sourceMessageRef: { kind: 'session', session: { serverId: 'home', sessionId: 'lead' }, messageId: 'committed' },
        } : {}) }, summary: 'Remember', createdBy: { surface: 'agent' } },
      { surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' },
        serverId: 'home', runtimeAccountId: 'owner', defaultSessionId: 'lead', defaultSessionMachineId: 'machine-1', actionRequestId: 'memory-proposal' }))
      .toMatchObject({ ok: true });
    expect(stored).toBe(original);
    expect((await prepareWorker()).blocks.join('\n')).not.toContain('Use the canonical Context owner.');
    expect(request).toMatchObject({ status: 'open', actionId });
    const decided = await uiExecutor.execute('approval.request.decide', { artifactId: 'proposal', decision: 'approve' },
      { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'home',
        defaultSessionId: 'lead' });
    const persistedApproval = (() : ApprovalRequest | null => request)();
    if (persistedApproval?.execution && !persistedApproval.execution.ok) {
      throw new Error(`Fixture approval execution failed: ${JSON.stringify(persistedApproval.execution)}`);
    }
    expect(decided).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
    expect(request).toMatchObject({ status: 'executed', execution: { ok: true } });
    expect(MemoryDocBodyV1Schema.parse(JSON.parse(stored.body!)).index).toEqual([expect.objectContaining({ id: 'approved-fact',
      text: 'Use the canonical Context owner.', sourceSessionRef: { serverId: 'home', sessionId: 'lead' } })]);
    if (actionId === 'memory.decision.save') {
      expect(JSON.parse(stored.body!).index[0].decision).toMatchObject({ approvedBy: {
        accountId: 'owner', atMs: persistedApproval?.decision?.decidedAtMs,
      } });
    }
    const read = await originExecutor.execute('memory.read', {
      ref: { kind: 'doc', artifactId: 'memory', serverId: 'home' },
    }, { surface: 'ui', authority: 'present_user', serverId: 'home' });
    expect(read).toMatchObject({ ok: true });
    if (!read.ok) throw new Error('Expected accepted memory read');
    expect(MemoryDocReadResultV1Schema.parse(read.result)).toMatchObject({
      artifactId: 'memory', revision: { headerVersion: 2, bodyVersion: 2 },
      body: { index: [expect.objectContaining({ id: 'approved-fact', text: 'Use the canonical Context owner.' })] },
    });
    expect(request).toMatchObject({ status: 'executed' });
    expect((await prepareWorker()).blocks.join('\n')).toContain('Use the canonical Context owner.');
    const applied = stored;
    expect(await uiExecutor.execute('approval.request.decide', { artifactId: 'proposal', decision: 'approve' },
      { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'home',
        defaultSessionId: 'lead' })).toMatchObject({ ok: true });
    expect(stored).toBe(applied);
  });
  it('F8 edits the captured Account stack through semantic Actions without replacing neighboring entries', async () => {
    const neighbor = { id: 'neighbor', ref: { kind: 'bundle' as const, artifactId: 'skill' }, enabled: true,
      placement: 'skill_instructions' as const };
    let record: PromptLibraryRecordV1 = { key: 'coding', value: { v: 1, scope: { kind: 'coding' }, entries: [neighbor] } };
    let revision = 4;
    let writes = 0;
    const executor = createExecutor({ isActionApprovalRequired: undefined, promptStacks: {
      serverId: 'home', assertCurrent: () => {},
      readCatalog: async () => ({ catalog: { status: 'ready' as const, rows: [{ record, revision }], tombstones: [], diagnostics: [] } }),
      writeRecord: async (input: { record: PromptLibraryRecordV1; expectedRevision: number | 'absent' }) => {
        if (input.expectedRevision !== revision) return { status: 'conflict' as const, revision };
        record = input.record; writes++; revision++;
        return { status: 'updated' as const, revision, cursor: revision };
      },
    } });
    const context = { surface: 'cli' as const, serverId: 'home' };
    const entry = { id: 'doc', ref: { kind: 'doc', artifactId: 'document' }, enabled: true, placement: 'system_append' };
    expect(await executor.execute('prompts.stack.update', { surface: 'coding', expectedRevision: 4,
      intent: { kind: 'attach', entry } }, context)).toMatchObject({ ok: true, result: { status: 'updated', revision: 5 } });
    for (const intent of [
      { kind: 'set_enabled', entryId: 'doc', enabled: false },
      { kind: 'set_budget', entryId: 'doc', maxChars: 120 },
      { kind: 'set_budget', entryId: 'doc', maxChars: null },
      { kind: 'reorder', entryId: 'doc', siblingId: 'neighbor', position: 'before' },
    ]) expect(await executor.execute('prompts.stack.update', { surface: 'coding', expectedRevision: revision, intent }, context))
      .toMatchObject({ ok: true, result: { status: 'updated' } });
    expect(record.value).toMatchObject({ entries: [{ ...entry, enabled: false }, neighbor] });
    expect(record.value).toMatchObject({ entries: [expect.not.objectContaining({ maxChars: expect.anything() }), neighbor] });
    expect(await executor.execute('prompts.stack.update', { surface: 'coding', expectedRevision: 4,
      intent: { kind: 'detach', entryId: 'neighbor' } }, context)).toMatchObject({ ok: true, result: { status: 'conflict', revision } });
    expect(await executor.execute('prompts.stack.update', { surface: 'coding', expectedRevision: revision,
      intent: { kind: 'detach', entryId: 'doc' } }, context)).toMatchObject({ ok: true, result: { status: 'updated' } });
    expect(record.value).toMatchObject({ entries: [neighbor] });
    expect(writes).toBe(6);
    expect(await executor.execute('prompts.stack.update', { surface: 'coding', expectedRevision: revision,
      intent: { kind: 'detach', entryId: 'neighbor' } }, { ...context, serverId: 'foreign' }))
      .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    expect(writes).toBe(6);
  });
  it('F8 uses retained source only before activation and never reseeds an active deleted stack', async () => {
    const retained = { id: 'retained', ref: { kind: 'doc' as const, artifactId: 'source-doc' }, enabled: true,
      placement: 'composer_insert' as const };
    let deleted = false;
    let unavailable = false;
    const writes: { record: PromptLibraryRecordV1; expectedRevision: number | 'absent'; sourceSettingsVersion?: number }[] = [];
    const executor = createExecutor({ isActionApprovalRequired: undefined, promptStacks: {
      serverId: 'home', assertCurrent: () => {},
      readCatalog: async () => ({ catalog: unavailable ? { status: 'unavailable' as const, reason: 'encryption-material-unavailable' as const }
        : { status: 'ready' as const, rows: [], tombstones: deleted ? [{ key: 'coding' as const, revision: 8 }] : [], diagnostics: [] },
        rawSettings: { promptStacksV1: { v: 1, surfaces: { coding: [retained], voice: [], profilesById: {} } } }, sourceSettingsVersion: 7 }),
      writeRecord: async input => { writes.push(input); return { status: 'updated' as const, revision: 9, cursor: 9 }; },
    } });
    const context = { surface: 'cli' as const, serverId: 'home' };
    expect(await executor.execute('prompts.stack.update', { surface: 'coding', expectedRevision: 'absent',
      intent: { kind: 'set_enabled', entryId: retained.id, enabled: false } }, context))
      .toMatchObject({ ok: true, result: { status: 'updated' } });
    expect(writes[0]).toEqual({ record: { key: 'coding', value: { v: 1, scope: { kind: 'coding' },
      entries: [{ ...retained, enabled: false }] } }, expectedRevision: 'absent', sourceSettingsVersion: 7 });
    deleted = true;
    expect(await executor.execute('prompts.stack.update', { surface: 'coding', expectedRevision: 8,
      intent: { kind: 'set_enabled', entryId: retained.id, enabled: true } }, context))
      .toMatchObject({ ok: true, result: { status: 'invalid', reason: 'entry_not_found' } });
    unavailable = true;
    expect(await executor.execute('prompts.stack.update', { surface: 'coding', expectedRevision: 8,
      intent: { kind: 'detach', entryId: retained.id } }, context))
      .toMatchObject({ ok: true, result: { status: 'unavailable', reason: 'encryption-material-unavailable' } });
    expect(writes).toHaveLength(1);
  });
  it('reports a created Artifact receipt when its separate personal organization CAS conflicts', async () => {
    const artifacts = new Map<string, PromptLibraryStoredArtifact>();
    let writerUnavailable = false;
    const record: PromptLibraryRecordV1 = { key: 'folders', value: { v: 1, folders: [{ id: 'folder', name: 'Folder' }] } };
    const store = {
      read: async (artifactId: string) => artifacts.get(artifactId) ?? null,
      create: async (content: { header: Readonly<Record<string, unknown>>; body: string }) => {
        const artifactId = artifacts.size === 0 ? 'created' : `created-${artifacts.size + 1}`;
        artifacts.set(artifactId, { id: artifactId, ...content, revision: { headerVersion: 1, bodyVersion: 1 } });
        return artifactId;
      },
      update: async () => {},
      organization: {
        serverId: 'home', assertCurrent: () => {},
        readCatalog: async () => ({ catalog: { status: 'ready' as const, rows: [{ record, revision: 4 }], tombstones: [], diagnostics: [] } }),
        readArtifactHeader: async (artifactId: string) => {
          const artifact = artifacts.get(artifactId);
          return artifact ? { header: artifact.header, owned: true } : null;
        },
        writeRecord: async () => {
          if (writerUnavailable) throw Object.assign(new Error('private transport material'), { details: { secret: 'private transport material' } });
          return { status: 'conflict' as const, revision: 5 };
        },
      },
    };
    const executor = createExecutor({ promptDocCreate: request => createPromptDocInLibrary({ store, request }) });
    const receipt = await executor.execute('prompt_doc.create', { title: 'Created content', markdown: 'Retained content', folderId: 'folder' },
      { surface: 'cli', serverId: 'home', actionsSettings: routingApprovalSettings });
    expect(receipt).toMatchObject({ ok: false, errorCode: 'artifact_organization_failed', details: {
      artifactId: 'created', organization: { status: 'conflict', revision: 5 },
    } });
    expect(artifacts.get('created')).toMatchObject({ header: { title: 'Created content' }, body: expect.stringContaining('Retained content') });
    expect(artifacts.get('created')?.header).not.toHaveProperty('folderId');
    writerUnavailable = true;
    const unavailable = await executor.execute('prompt_doc.create', { title: 'Other content', markdown: 'Retained too', folderId: 'folder' },
      { surface: 'cli', serverId: 'home', actionsSettings: routingApprovalSettings });
    expect(unavailable).toMatchObject({ ok: false, errorCode: 'artifact_organization_failed', details: {
      artifactId: 'created-2', organization: { status: 'unavailable', reason: 'artifact_organization_unavailable' },
    } });
    expect(JSON.stringify(unavailable)).not.toContain('private transport material');
    expect(artifacts.get('created-2')?.body).toContain('Retained too');
  });
  it('reads the complete personal folder tree including empty folders through the admitted Action owner', async () => {
    for (const id of ['artifact.folders.list', 'artifact.folders.read'] as const) {
      expect(getActionSpec(id).approval.result).toBe('none');
    }
    let unavailable = false;
    let current = true;
    const record: PromptLibraryRecordV1 = { key: 'folders', value: { v: 1, folders: [
      { id: 'parent', name: 'Parent' }, { id: 'empty', name: 'Empty child', parentId: 'parent' },
    ], artifactHeadersById: { private: { folderId: 'parent', tags: ['Personal'] } } } };
    const executor = createExecutor({ artifactFolders: {
      serverId: 'home', assertCurrent: () => { if (!current) throw Object.assign(new Error('Retired Home'), { code: 'scope-retired' }); },
      readCatalog: async () => ({ catalog: unavailable
        ? { status: 'unavailable' as const, reason: 'encryption-material-unavailable' as const }
        : { status: 'ready' as const, rows: [{ record, revision: 7 }], tombstones: [], diagnostics: [] } }),
      writeRecord: async () => { throw new Error('A folder read must not mutate its catalog'); },
      readArtifactHeader: async () => { throw new Error('Folder reads must include empty folders independently of Artifact availability'); },
    } });
    for (const surface of ['ui', 'agent', 'mcp', 'cli', 'rpc'] as const) {
      const context = { surface, serverId: 'home' };
      expect(await executor.execute('artifact.folders.read', { folderId: 'empty' }, context)).toEqual({ ok: true, result: {
        status: 'ready', item: { id: 'empty', name: 'Empty child', parentId: 'parent' }, revision: 7, coverage: 'complete',
      } });
      expect(await executor.execute('artifact.folders.list', {}, context)).toEqual({ ok: true, result: {
        status: 'ready', items: [{ id: 'parent', name: 'Parent', parentId: null }, { id: 'empty', name: 'Empty child', parentId: 'parent' }],
        revision: 7, coverage: 'complete', nextCursor: null,
      } });
    }
    expect(await executor.execute('artifact.folders.read', { folderId: 'missing' }, { surface: 'cli', serverId: 'home' }))
      .toEqual({ ok: true, result: { status: 'not_found', revision: 7, coverage: 'complete' } });
    expect(await executor.execute('artifact.folders.list', {}, { surface: 'agent', serverId: 'foreign' }))
      .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    unavailable = true;
    expect(await executor.execute('artifact.folders.list', {}, { surface: 'agent', serverId: 'home' }))
      .toEqual({ ok: true, result: { status: 'unavailable', reason: 'encryption-material-unavailable' } });
    unavailable = false;
    current = false;
    expect(await executor.execute('artifact.folders.read', { folderId: 'empty' }, { surface: 'agent', serverId: 'home' }))
      .toMatchObject({ ok: false });
  });

  it('distinguishes an authoritative empty folder tree from unavailable or incomplete folder data', async () => {
    let catalog: import('../prompts/library/promptLibraryCatalogV1.js').PromptLibraryCatalogSnapshotV1 = {
      status: 'ready', rows: [], tombstones: [{ key: 'folders', revision: 9 }], diagnostics: [],
    };
    const executor = createExecutor({ artifactFolders: {
      serverId: 'home', assertCurrent: () => {}, readCatalog: async () => ({ catalog }),
      writeRecord: async () => { throw new Error('read-only'); }, readArtifactHeader: async () => null,
    } });
    const context = { surface: 'cli' as const, serverId: 'home' };
    expect(await executor.execute('artifact.folders.list', {}, context))
      .toEqual({ ok: true, result: { status: 'ready', items: [], revision: 9, coverage: 'complete', nextCursor: null } });
    catalog = { status: 'partial', rows: [], tombstones: [], diagnostics: [{ key: 'folders', revision: 9, reason: 'invalid-stored-content' }] };
    expect(await executor.execute('artifact.folders.list', {}, context))
      .toMatchObject({ ok: true, result: { status: 'unavailable' } });
    expect(await executor.execute('artifact.folders.list', { cursor: 'invented' }, context)).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(await executor.execute('artifact.folders.read', { folderId: 'empty', payload: {} }, context)).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
  });

  it('organizes every Artifact kind in the private folder row through safe Actions without changing shared content', async () => {
    let record: PromptLibraryRecordV1 = { key: 'folders', value: { v: 1, folders: [] } };
    let revision = 1;
    const sharedHeader = { v: 1, kind: 'document.v1', title: 'Recipient document', folderId: 'owner-folder', tags: ['Owner private'] };
    const deps = {
      artifactFolders: {
        serverId: 'home', assertCurrent: () => {},
        // A host-profile resolution boundary admits its known alias, never a foreign Home.
        matchesServerId: (serverId: string) => serverId === 'home' || serverId === 'home-alias',
        readCatalog: async () => ({ catalog: { status: 'ready' as const, rows: [{ record, revision }], tombstones: [], diagnostics: [] } }),
        readArtifactHeader: async () => ({ header: sharedHeader, owned: false }),
        writeRecord: async (request: { record: PromptLibraryRecordV1; expectedRevision: number | 'absent' }) => {
          if (request.expectedRevision !== revision) return { status: 'conflict' as const, revision };
          record = request.record; revision++;
          return { status: 'updated' as const, revision, cursor: revision };
        },
      },
    };
    const executor = createExecutor(deps);
    for (const surface of ['agent', 'mcp', 'cli', 'ui'] as const) {
      const context = { surface, serverId: surface === 'ui' ? 'home-alias' : 'home' };
      const id = `folder-${surface}`;
      const created = await executor.execute('artifact.folders.create', { id, name: surface, expectedRevision: revision }, context);
      expect(created.ok, JSON.stringify(created)).toBe(true);
      expect(created).toMatchObject({ ok: true, result: { status: 'updated', revision: revision } });
      expect(await executor.execute('artifact.folder.set', { artifactId: 'shared', folderId: id, expectedRevision: revision }, context))
        .toMatchObject({ ok: true });
      expect(record).toMatchObject({ key: 'folders', value: { artifactHeadersById: { shared: { folderId: id } } } });
      if (record.key !== 'folders') throw new Error('Wrong catalog owner');
      expect(record.value.artifactHeadersById?.shared.tags).toBeUndefined();
      expect(await executor.execute('artifact.folders.rename', { folderId: id, name: `Renamed ${surface}`, expectedRevision: revision }, context))
        .toMatchObject({ ok: true });
      expect(await executor.execute('artifact.folders.move', { folderId: id, parentId: null, expectedRevision: revision }, context))
        .toMatchObject({ ok: true });
      expect(await executor.execute('artifact.folders.delete', { folderId: id, expectedRevision: revision }, context)).toMatchObject({ ok: true });
      expect(record).toMatchObject({ key: 'folders', value: { folders: [], artifactHeadersById: { shared: { folderId: null } } } });
    }
    expect(sharedHeader).toEqual({ v: 1, kind: 'document.v1', title: 'Recipient document', folderId: 'owner-folder', tags: ['Owner private'] });
    for (const id of ['artifact.folders.create', 'artifact.folders.rename', 'artifact.folders.move', 'artifact.folders.delete', 'artifact.folder.set'] as const) {
      const spec = getActionSpec(id);
      expect(spec.safety).toBe('safe');
      expect(spec.inputSchema.safeParse({ expectedRevision: 1, payload: {} }).success).toBe(false);
    }
  });

  it('refuses stale, incomplete, foreign-Home and cancelled folder changes before any private write', async () => {
    const record: PromptLibraryRecordV1 = { key: 'folders', value: { v: 1, folders: [{ id: 'one', name: 'One' }] } };
    let unavailable = false;
    let current = true;
    let writes = 0;
    const deps = { artifactFolders: {
      serverId: 'home', assertCurrent: () => { if (!current) throw Object.assign(new Error('Retired Home'), { code: 'scope-retired' }); },
      readCatalog: async () => ({ catalog: unavailable
        ? { status: 'unavailable' as const, reason: 'unreachable' as const }
        : { status: 'ready' as const, rows: [{ record, revision: 2 }], tombstones: [], diagnostics: [] } }),
      writeRecord: async () => { writes++; return { status: 'updated' as const, revision: 3, cursor: 3 }; },
      readArtifactHeader: async () => null,
    } };
    const executor = createExecutor(deps);
    const request = { folderId: 'one', name: 'Changed', expectedRevision: 1 };
    const renamed = await executor.execute('artifact.folders.rename', request, { surface: 'ui', serverId: 'home' });
    expect(renamed.ok, JSON.stringify(renamed)).toBe(true);
    expect(renamed).toMatchObject({ ok: true, result: { status: 'conflict', revision: 2 } });
    unavailable = true;
    expect(await executor.execute('artifact.folders.rename', { ...request, expectedRevision: 2 }, { surface: 'ui', serverId: 'home' }))
      .toMatchObject({ ok: true, result: { status: 'unavailable', reason: 'unreachable' } });
    unavailable = false;
    expect(await executor.execute('artifact.folders.rename', { ...request, expectedRevision: 2 }, { surface: 'ui', serverId: 'foreign' }))
      .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    const controller = new AbortController(); controller.abort();
    await executor.execute('artifact.folders.rename', { ...request, expectedRevision: 2 }, { surface: 'ui', serverId: 'home', signal: controller.signal });
    current = false;
    await executor.execute('artifact.folders.rename', { ...request, expectedRevision: 2 }, { surface: 'ui', serverId: 'home' });
    expect(writes).toBe(0);
  });
  it('admits private memory, asks for shared memory and sanitizes approval custody before any write', async () => {
    let stored: PromptLibraryStoredArtifact = { id: 'memory', revision: { headerVersion: 1, bodyVersion: 1 },
      header: { v: 1, kind: 'memory_doc.v1', title: 'Memory' }, body: JSON.stringify(MemoryDocBodyV1Schema.parse({ v: 1, index: [], topics: [] })) };
    let shared = false;
    let writes = 0;
    let approvalInput: unknown;
    let publication: StoredContentPublicShareV1 | null = null;
    let publicationAvailable = true;
    const executor = createExecutor({ isActionApprovalRequired: undefined,
      memoryLibrary: { serverId: 'home', nowMs: () => 10, randomId: () => `fact-${writes}`,
      store: { read: async () => stored, update: async input => { writes++; stored = { ...stored, body: input.body,
        revision: { headerVersion: 1 + writes, bodyVersion: 1 + writes } }; } },
      readExposure: async () => ({ grants: { artifactId: 'memory', ownerAccountId: 'owner', access: 'owner',
        grants: shared ? [{ principal: { kind: 'account', accountId: 'other' }, accessLevel: 'edit', createdByAccountId: 'owner', createdAt: 1, display: { name: null } }] : [] },
        publicShares: publicationAvailable ? { publicShares: publication ? [publication] : [] } : null }),
    }, approvalsCreate: async args => { approvalInput = args.request; return { artifactId: 'approval' }; } });
    const request = () => ({ ref: { kind: 'doc', artifactId: 'memory', serverId: 'home' }, expectedRevision: stored.revision, text: 'Prefer tea; password=secret',
      ...(writes ? { duplicateChoice: { kind: 'keep_both', expectedRevision: stored.revision } } : {}) });
    const context = { surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' },
      actionRequestId: 'request', defaultSessionId: 'session', serverId: 'home' } as const;
    expect(await executor.execute('memory.remember', request(), context)).toMatchObject({ ok: true, result: { factId: 'fact-0' } });
    expect(JSON.parse(stored.body!).index[0]).toMatchObject({ text: 'Prefer tea; password: [REDACTED]', sourceSessionRef: { serverId: 'home', sessionId: 'session' } });
    shared = true;
    await executor.execute('memory.remember', request(), context);
    expect(writes).toBe(1);
    expect(JSON.stringify(approvalInput)).not.toContain('password=secret');
    expect(JSON.stringify(approvalInput)).toContain('[REDACTED]');
    expect(await executor.execute('memory.remember', { ...request(), ref: { kind: 'doc', artifactId: 'memory', serverId: 'other-home' } }, context))
      .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    shared = false;
    const prepared = await executor.prepare('memory.remember', request(), context);
    if (prepared.kind !== 'ready') throw new Error('Private memory preparation refused');
    shared = true;
    expect(await prepared.invocation.run()).toMatchObject({ ok: false, errorCode: 'approval_stale' });
    expect(writes).toBe(1);
    const waived = { ...context, actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: {},
      approvalWaivedSurfaces: { 'memory.remember': ['agent'] } }) };
    expect(await executor.execute('memory.remember', request(), waived)).toMatchObject({ ok: true });
    expect(writes).toBe(2);
    const explicit = await executor.execute('approval.request.create', { actionId: 'memory.remember', actionArgs: request(),
      summary: 'Remember', createdBy: { surface: 'agent' } }, context);
    expect(explicit).toMatchObject({ ok: true });
    expect(JSON.stringify(approvalInput)).not.toContain('password=secret');
    shared = false;
    publication = { id: 'publication', subject: { kind: 'artifact', id: 'memory' }, expiresAt: 10,
      maxUses: 1, useCount: 1, isConsentRequired: false, createdAt: 1, updatedAt: 1, keyDerivation: 'fragment_v1' };
    expect(await executor.execute('memory.remember', request(), context)).toMatchObject({ ok: true, result: { factId: 'fact-2' } });
    expect(writes).toBe(3);
    publication = { ...publication, expiresAt: 11 };
    await executor.execute('memory.remember', request(), context);
    expect(writes).toBe(3); // Exhausted admission does not revoke already-issued public viewer tokens.
    publication = null;
    publicationAvailable = false;
    expect(await executor.execute('memory.remember', request(), context))
      .toMatchObject({ ok: false, errorCode: 'memory_exposure_unavailable' });
    expect(writes).toBe(3);
    publicationAvailable = true;
    const required = { ...context, actionsSettings: ActionsSettingsV1Schema.parse({ v: 1,
      actions: { 'memory.remember': { approvalRequiredSurfaces: ['agent'] } } }) };
    expect(await executor.execute('memory.remember', request(), required))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(writes).toBe(3);
  });

  it('restores archived memory through the admitted update Action and asks before shared restore', async () => {
    const original = { id: 'original', text: 'Build with the repository script.', createdAtMs: 1, expiresAtMs: 100,
      sourceSessionRef: { serverId: 'source-home', sessionId: 'source-session' } };
    let stored: PromptLibraryStoredArtifact = { id: 'memory', revision: { headerVersion: 1, bodyVersion: 1 },
      header: { v: 1, kind: 'memory_doc.v1', title: 'Memory' }, body: JSON.stringify({ v: 1, index: [],
        topics: [{ title: 'Build', summary: 'Build details', facts: [] }, { title: 'archive', summary: 'History', facts: [original] }] }) };
    let shared = false;
    const executor = createExecutor({ isActionApprovalRequired: undefined,
      memoryLibrary: { serverId: 'home', nowMs: () => 10, randomId: () => 'wrong-new-id',
        store: { read: async () => stored, update: async input => {
          stored = { ...stored, body: input.body,
            revision: { headerVersion: stored.revision.headerVersion + 1, bodyVersion: stored.revision.bodyVersion + 1 } };
        } },
        readExposure: async () => ({ grants: { artifactId: 'memory', ownerAccountId: 'owner', access: 'owner',
          grants: shared ? [{ principal: { kind: 'account', accountId: 'other' }, accessLevel: 'edit',
            createdByAccountId: 'owner', createdAt: 1, display: { name: null } }] : [] }, publicShares: { publicShares: [] } }),
      }, approvalsCreate: async () => ({ artifactId: 'approval' }),
    });
    const ref = { kind: 'doc' as const, artifactId: 'memory', serverId: 'home' };
    const restore = () => ({ ref, expectedRevision: stored.revision, factId: original.id,
      topic: 'archive', restore: true, restoreTopic: 'Build' });
    const context = { surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' },
      actionRequestId: 'request', defaultSessionId: 'current-session', serverId: 'home' } as const;
    expect(await executor.execute('memory.update', restore(), context)).toMatchObject({ ok: true, result: { factId: original.id } });
    expect(JSON.parse(stored.body!)).toMatchObject({ topics: [{ title: 'Build', facts: [original] }, { title: 'archive', facts: [] }] });
    expect(await executor.execute('memory.forget', { ref, expectedRevision: stored.revision, factId: original.id, topic: 'Build' }, context))
      .toMatchObject({ ok: true });
    shared = true;
    const archived = stored;
    expect(await executor.execute('memory.update', restore(), context))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(stored).toBe(archived);
  });
  it('keeps Session memory admission field-scoped while active-runtime revisions advance', async () => {
    const { store, artifacts } = createStoredLibrary([{ id: 'memory', header: { v: 1, kind: 'memory_doc.v1', title: 'Memory' },
      body: JSON.stringify(MemoryDocBodyV1Schema.parse({ v: 1, index: [], topics: [] })), revision: { headerVersion: 1, bodyVersion: 1 } }]);
    let revision = 4;
    let enabled = true;
    let selected = 'memory';
    const executor = createExecutor({ isActionApprovalRequired: undefined, memoryLibrary: { serverId: 'home', randomId: () => 'active-session-fact',
      store,
      readSession: async () => ({ revision: ++revision, metadata: { bot: { kind: 'bot' }, work: { memoryEnabled: enabled,
        promptStack: [{ id: 'session.memory', ref: { kind: 'doc', artifactId: selected, serverId: 'home' }, enabled: true, placement: 'system_append' }],
        sessionRolesV1: { overrides: {}, sessionRoles: {}, notes: `Runtime revision ${revision}` },
      } } }),
      readExposure: async artifactId => ({ grants: { artifactId, ownerAccountId: 'owner', access: 'owner', grants: [] }, publicShares: { publicShares: [] } }),
    } });
    const context = { surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' }, defaultSessionId: 'session', serverId: 'home' } as const;
    const request = { sessionRef: { serverId: 'home', sessionId: 'session' }, expectedMetadataRevision: 4, text: 'Remember this active Session fact' };
    const remembered = await executor.execute('memory.remember', request, context);
    expect(remembered, JSON.stringify(remembered)).toMatchObject({ ok: true, result: { artifactId: 'memory' } });
    const reviewed = { ...request, text: 'Do not redirect this reviewed proposal', reviewedTarget: {
      ref: { kind: 'doc', artifactId: 'memory', serverId: 'home' }, expectedRevision: artifacts.get('memory')!.revision,
    } };
    const before = artifacts.get('memory');
    selected = 'other-memory';
    expect(await executor.execute('memory.remember', reviewed, context)).toMatchObject({ ok: false, errorCode: 'approval_stale' });
    expect(artifacts.get('memory')).toBe(before);
    selected = 'memory'; enabled = false;
    expect(await executor.execute('memory.remember', reviewed, context)).toMatchObject({ ok: false, errorCode: 'action_disabled' });
    expect(artifacts.get('memory')).toBe(before);
  });

  it('creates memory only on first remember, reuses the reserved attachment and retains an attach-conflicted fact', async () => {
    const artifacts = new Map<string, PromptLibraryStoredArtifact>();
    let metadata: Record<string, unknown> = { bot: { kind: 'bot' }, work: { memoryEnabled: true, promptStack: [] } };
    let revision = 3;
    let creates = 0;
    let attaches = 0;
    let conflict = false;
    let ids = 0;
    let sessionAdmissions = 0;
    const executor = createExecutor({ isActionApprovalRequired: undefined,
      memoryLibrary: { serverId: 'home', randomId: () => `fact-${++ids}`,
      store: { read: async id => artifacts.get(id) ?? null, create: async input => { creates++; const id = `memory-${creates}`;
        artifacts.set(id, { id, header: input.header, body: input.body, revision: { headerVersion: 1, bodyVersion: 1 } }); return id; },
      update: async input => { const prior = artifacts.get(input.artifactId)!;
        artifacts.set(prior.id, { ...prior, body: input.body, revision: { headerVersion: prior.revision.headerVersion + 1, bodyVersion: prior.revision.bodyVersion + 1 } }); } },
      readSession: async () => { sessionAdmissions++; return { metadata, revision }; },
      readExposure: async artifactId => ({ grants: { artifactId, ownerAccountId: 'owner', access: 'owner', grants: [] }, publicShares: { publicShares: [] } }),
    }, sessionStateFieldSet: async write => {
      if (write.fieldId !== 'intent.context') throw new Error('Wrong writer');
      if (conflict || write.expectedMetadataRevision !== revision) return { ok: false, errorCode: 'conflict' };
      metadata = writeSessionContextIntentV1ToMetadata(metadata, write.value); revision++; attaches++;
      return { ok: true };
    } });
    const context = { surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' }, defaultSessionId: 'session', serverId: 'home' } as const;
    const request = () => ({ sessionRef: { serverId: 'home', sessionId: 'session' }, expectedMetadataRevision: revision, text: 'Preference' });
    const first = await executor.execute('memory.remember', request(), context);
    expect(first).toMatchObject({ ok: true, result: { artifactId: 'memory-1', attachment: 'attached' } });
    expect(sessionAdmissions).toBe(1);
    expect(await executor.execute('memory.remember', request(), context)).toMatchObject({ ok: true, result: {
      ok: false, errorCode: 'memory_duplicate_choice_required', ref: { artifactId: 'memory-1' } } });
    expect(creates).toBe(1); expect(attaches).toBe(1);
    expect(JSON.parse(artifacts.get('memory-1')!.body!).index).toHaveLength(1);
    metadata = { bot: { kind: 'bot' }, work: { memoryEnabled: true, promptStack: [] } }; revision++; conflict = true;
    const conflicted = await executor.execute('memory.remember', request(), context);
    expect(conflicted).toMatchObject({ ok: true, result: { artifactId: 'memory-2', attachment: 'conflict' } });
    expect(JSON.parse(artifacts.get('memory-2')!.body!).index).toHaveLength(1);
    expect(attaches).toBe(1);
    if (!conflicted.ok) throw new Error('Expected the retained creation receipt');
    const receipt = MemoryMutationResultV1Schema.parse(conflicted.result);
    if (!receipt.ref) throw new Error('Missing the created document reference');
    conflict = false;
    // Recover the actual created document through the existing context Action, not another create/retry mechanism.
    expect(await executor.execute('session.context.update', {
      sessionId: 'session', serverId: 'home', expectedMetadataRevision: revision,
      intent: { kind: 'attach', entry: { id: 'session.memory', ref: receipt.ref, enabled: true, placement: 'system_append' } },
    }, context)).toMatchObject({ ok: true });
    expect(await executor.execute('memory.remember', request(), context)).toMatchObject({ ok: true, result: {
      ok: false, errorCode: 'memory_duplicate_choice_required', ref: { artifactId: 'memory-2' } } });
    expect(creates).toBe(2);
    expect(attaches).toBe(2);
    expect(JSON.parse(artifacts.get('memory-2')!.body!).index).toHaveLength(1);
    expect(await executor.execute('memory.remember', { ...request(), expectedMetadataRevision: revision - 1 }, context))
      .toMatchObject({ ok: true, result: { ok: false, errorCode: 'memory_duplicate_choice_required' } });
    expect(creates).toBe(2);
    metadata = { work: { memoryEnabled: false, promptStack: [] } }; revision++;
    expect(await executor.execute('memory.remember', request(), { ...context, surface: 'cli' }))
      .toMatchObject({ ok: false, errorCode: 'action_disabled' });
    expect(creates).toBe(2);
    expect(artifacts.size).toBe(2);
  });
  it('remembers ordinary Session facts in existing Project memory, otherwise Account memory, without a Session-only default', async () => {
    const artifacts = new Map<string, PromptLibraryStoredArtifact>(['project-memory', 'account-memory'].map(id => [id, {
      id, header: { v: 1, kind: 'memory_doc.v1', title: id }, revision: { headerVersion: 1, bodyVersion: 1 },
      body: JSON.stringify(MemoryDocBodyV1Schema.parse({ v: 1, index: [], topics: [] })),
    }]));
    const entry = (artifactId: string) => ({ id: artifactId, ref: { kind: 'doc' as const, artifactId, serverId: 'home' },
      enabled: true, placement: 'system_append' as const });
    let projectEntries = [entry('project-memory')];
    let accountEntries = [entry('account-memory')];
    let creates = 0;
    let sessionAttachments = 0;
    let accountAttachments = 0;
    let shared = false;
    const metadata = { work: { memoryEnabled: true, promptStack: [] } };
    const executor = createExecutor({ isActionApprovalRequired: undefined,
      memoryLibrary: { serverId: 'home', randomId: () => `fact-${artifacts.get('project-memory')?.revision.bodyVersion}-${creates}`,
        store: { read: async id => artifacts.get(id) ?? null,
          create: async input => { const id = `created-${++creates}`;
            artifacts.set(id, { id, header: input.header, body: input.body, revision: { headerVersion: 1, bodyVersion: 1 } }); return id; },
          update: async input => { const current = artifacts.get(input.artifactId)!;
            artifacts.set(current.id, { ...current, body: input.body, revision: {
              headerVersion: current.revision.headerVersion + 1, bodyVersion: current.revision.bodyVersion + 1 } }); },
        },
        readSession: async () => ({ metadata, revision: 3 }),
        readArtifactHeaders: async refs => refs.map(ref => artifacts.get(ref.artifactId)?.header ?? null),
        ...{ readInheritedContext: async () => ({ projectEntries, readAccountContext: async () => ({ accountEntries,
          attachAccountMemory: async (ref: Readonly<{ kind: 'doc'; artifactId: string; serverId?: string }>) => {
            accountEntries = [...accountEntries, entry(ref.artifactId)]; accountAttachments++; return true;
          } }) }) },
        readExposure: async artifactId => ({ grants: { artifactId, ownerAccountId: 'owner', access: 'owner',
          grants: shared ? [{ principal: { kind: 'team', teamId: 'team' }, accessLevel: 'edit', createdByAccountId: 'owner',
            createdAt: 1, display: { name: null } }] : [] }, publicShares: { publicShares: [] } }),
      },
      sessionStateFieldSet: async () => { sessionAttachments++; return { ok: true }; },
      approvalsCreate: async () => ({ artifactId: 'approval' }),
    });
    const request = { sessionRef: { serverId: 'home', sessionId: 'ordinary' }, expectedMetadataRevision: 3, text: 'Stable preference' };
    const context = { surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' },
      defaultSessionId: 'ordinary', serverId: 'home', actionRequestId: 'request' } as const;
    expect(await executor.execute('memory.remember', request, context)).toMatchObject({ ok: true, result: { artifactId: 'project-memory' } });
    expect(creates).toBe(0);
    shared = true;
    expect(await executor.execute('memory.remember', { ...request, reviewedTarget: {
      ref: { kind: 'doc', artifactId: 'project-memory', serverId: 'home' }, expectedRevision: artifacts.get('project-memory')!.revision },
      duplicateChoice: { kind: 'keep_both', expectedRevision: artifacts.get('project-memory')!.revision },
    }, context)).toMatchObject({ ok: true,
      result: { kind: 'approval_request_created' } });
    expect(artifacts.get('project-memory')!.revision.bodyVersion).toBe(2);
    shared = false; projectEntries = [];
    expect(await executor.execute('memory.remember', request, context)).toMatchObject({ ok: true, result: { artifactId: 'account-memory' } });
    accountEntries = [];
    expect(await executor.execute('memory.remember', request, context)).toMatchObject({ ok: true,
      result: { artifactId: 'created-1', attachment: 'attached' } });
    expect(await executor.execute('memory.remember', request, context)).toMatchObject({ ok: true, result: {
      ok: false, errorCode: 'memory_duplicate_choice_required', ref: { artifactId: 'created-1' } } });
    expect(creates).toBe(1); expect(accountAttachments).toBe(1); expect(sessionAttachments).toBe(0);
    expect(metadata.work.promptStack).toEqual([]);
  });
  it('creates and reuses explicit Account and Project scope memory without a Session, asking before shared creation', async () => {
    const artifacts = new Map<string, PromptLibraryStoredArtifact>();
    const entries = new Map<string, { id: string; ref: { kind: 'doc'; artifactId: string; serverId: string }; enabled: boolean; placement: 'system_append' }[]>();
    let creates = 0;
    let ids = 0;
    let shared = false;
    let conflict = false;
    let approvedInput: unknown;
    const executor = createExecutor({ isActionApprovalRequired: undefined,
      memoryLibrary: { serverId: 'home', randomId: () => `scope-fact-${++ids}`,
        store: { read: async id => artifacts.get(id) ?? null,
          create: async input => { const id = `scope-memory-${++creates}`;
            artifacts.set(id, { id, ...input, revision: { headerVersion: 1, bodyVersion: 1 } }); return id; },
          update: async input => { const old = artifacts.get(input.artifactId)!;
            artifacts.set(old.id, { ...old, body: input.body, revision: {
              headerVersion: old.revision.headerVersion + 1, bodyVersion: old.revision.bodyVersion + 1 } }); },
        },
        readArtifactHeaders: async refs => refs.map(ref => artifacts.get(ref.artifactId)?.header ?? null),
        ...{ readScopeContext: async (target: { scope: 'account' } | { scope: 'project'; projectRef: { serverId: string; projectKey: string } }) => {
          const key = target.scope === 'account' ? 'account' : target.projectRef.projectKey;
          return { entries: entries.get(key) ?? [], safety: shared ? 'danger' as const : 'safe' as const,
            attachMemory: async (ref: { kind: 'doc'; artifactId: string; serverId?: string }) => {
              if (conflict) return false;
              entries.set(key, [{ id: `${key}.memory`, ref: { ...ref, serverId: ref.serverId ?? 'home' }, enabled: true, placement: 'system_append' }]);
              return true;
            } };
        } },
        readExposure: async artifactId => ({ grants: { artifactId, ownerAccountId: 'owner', access: 'owner', grants: [] },
          publicShares: { publicShares: [] } }),
      }, approvalsCreate: async args => { approvedInput = args.request; return { artifactId: 'approval' }; },
    });
    const context = { surface: 'agent', serverId: 'home', authority: 'account_automation', actionCaller: { kind: 'host' }, actionRequestId: 'scope-request' } as const;
    for (const target of [{ scope: 'account' }, { scope: 'project', projectRef: { serverId: 'home', projectKey: 'personal' } }] as const) {
      const first = await executor.execute('memory.remember', { ...target, text: 'First fact', topic: 'Preferences' }, context);
      expect(first, JSON.stringify(first)).toMatchObject({ ok: true, result: { attachment: 'attached' } });
      if (!first.ok) throw new Error('Expected scope creation');
      const receipt = MemoryMutationResultV1Schema.parse(first.result);
      expect(await executor.execute('memory.remember', { ...target, text: 'Second fact' }, context))
        .toMatchObject({ ok: true, result: { ok: true, artifactId: receipt.artifactId } });
      expect(JSON.parse(artifacts.get(receipt.artifactId)!.body!).index).toMatchObject([{ text: 'Second fact' }]);
      expect(JSON.parse(artifacts.get(receipt.artifactId)!.body!).topics[0].facts[0].sourceSessionRef).toBeNull();
    }
    expect(creates).toBe(2);
    const retargeted = await executor.prepare('memory.remember', { scope: 'project', projectRef: { serverId: 'home', projectKey: 'personal' }, text: 'Reviewed target' }, context);
    if (retargeted.kind !== 'ready') throw new Error('Private scope preparation refused');
    const personalEntries = entries.get('personal')!;
    entries.set('personal', entries.get('account')!);
    expect(await retargeted.invocation.run()).toMatchObject({ ok: false, errorCode: 'approval_stale' });
    entries.set('personal', personalEntries);
    shared = true;
    const sharedRequest = { scope: 'project', projectRef: { serverId: 'home', projectKey: 'shared' }, text: 'Shared fact' };
    expect(await executor.execute('memory.remember', sharedRequest, context))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(creates).toBe(2);
    expect(JSON.stringify(approvedInput)).toContain('reviewedTarget');
    expect(await executor.execute('memory.remember', { ...sharedRequest, reviewedTarget: null }, { ...context, bypassApprovals: true }))
      .toMatchObject({ ok: true, result: { attachment: 'attached' } });
    expect(creates).toBe(3);
    shared = false;
    const privateDraft = await executor.prepare('memory.remember', { scope: 'project', projectRef: { serverId: 'home', projectKey: 'newly-shared' }, text: 'Private draft' }, context);
    if (privateDraft.kind !== 'ready') throw new Error('Private scope preparation refused');
    shared = true;
    expect(await privateDraft.invocation.run()).toMatchObject({ ok: false, errorCode: 'approval_stale' });
    expect(creates).toBe(3);
    shared = false; conflict = true;
    expect(await executor.execute('memory.remember', { scope: 'project', projectRef: { serverId: 'home', projectKey: 'conflict' }, text: 'Retained fact' }, context))
      .toMatchObject({ ok: true, result: { artifactId: 'scope-memory-4', attachment: 'conflict' } });
    expect(artifacts.get('scope-memory-4')!.body).toContain('Retained fact');
    expect(await executor.execute('memory.remember', { ...sharedRequest, projectRef: { serverId: 'foreign', projectKey: 'shared' } }, context))
      .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    expect(creates).toBe(4);
  });
  it('returns the currently admitted memory version on a reviewed write conflict without changing it', async () => {
    const revision = { headerVersion: 4, bodyVersion: 7 };
    let stored: PromptLibraryStoredArtifact = { id: 'memory', revision, header: { v: 1, kind: 'memory_doc.v1', title: 'Memory' },
      body: JSON.stringify(MemoryDocBodyV1Schema.parse({ v: 1, index: [{ id: 'current', text: 'Current truth', createdAtMs: 1, sourceSessionRef: null }], topics: [] })) };
    let writes = 0;
    const executor = createExecutor({ memoryLibrary: { serverId: 'home', randomId: () => 'replacement',
      store: { read: async () => stored, update: async () => {
        writes++;
        // External Artifact CAS loses to another writer; its next read is the current admitted version.
        stored = { ...stored, revision: { headerVersion: 5, bodyVersion: 8 },
          body: JSON.stringify({ v: 1, index: [{ id: 'current', text: 'Concurrent truth', createdAtMs: 2, sourceSessionRef: null }], topics: [] }) };
        throw Object.assign(new Error('conflict'), { code: 'version_mismatch' });
      } },
      readExposure: async artifactId => ({ grants: { artifactId, ownerAccountId: 'owner', access: 'owner', grants: [] },
        publicShares: { publicShares: [] } }),
    } });
    expect(await executor.execute('memory.update', { ref: { kind: 'doc', artifactId: 'memory', serverId: 'home' },
      expectedRevision: { headerVersion: 1, bodyVersion: 1 }, factId: 'current', text: 'Reviewed draft' }, { surface: 'cli', serverId: 'home' }))
      .toMatchObject({ ok: false, errorCode: 'version_mismatch', details: { current: { artifactId: 'memory', revision } } });
    expect(writes).toBe(0);
    expect(stored.body).toContain('Current truth');
    expect(stored.body).not.toContain('Reviewed draft');
    expect(await executor.execute('memory.update', { ref: { kind: 'doc', artifactId: 'memory', serverId: 'home' },
      expectedRevision: revision, factId: 'current', text: 'Reviewed draft' }, { surface: 'cli', serverId: 'home' }))
      .toMatchObject({ ok: false, errorCode: 'version_mismatch', details: { current: {
        artifactId: 'memory', revision: { headerVersion: 5, bodyVersion: 8 },
        body: { v: 1, index: [{ id: 'current', text: 'Concurrent truth' }], topics: [] },
      } } });
    expect(writes).toBe(1);
    expect(stored.body).not.toContain('Reviewed draft');
  });
  it('creates, inventories, and favourites through real library operations on agent, MCP, CLI and UI surfaces', async () => {
    let stored: PromptLibraryStoredArtifact | null = null;
    const folderRecord: PromptLibraryRecordV1 = { key: 'folders', value: { v: 1, folders: [] } };
    const store = { read: async () => stored,
      create: async ({ header, body }: { header: Readonly<Record<string, unknown>>; body: string }) => {
        stored = { id: 'saved', header, body, revision: { headerVersion: 1, bodyVersion: 1 } }; return 'saved';
      },
      update: async ({ header, body }: { header: Readonly<Record<string, unknown>>; body: string }) => { stored = { ...stored!, header, body }; },
      list: async () => ({ items: stored ? [{ id: stored.id, header: stored.header, owned: true, updatedAtMs: 1 }] : [], coverage: 'complete' as const }),
      organization: {
        serverId: 'home', assertCurrent: () => {},
        readCatalog: async () => ({ catalog: { status: 'ready' as const, rows: [{ record: folderRecord, revision: 1 }], tombstones: [], diagnostics: [] } }),
        readArtifactHeader: async () => stored ? { header: stored.header, owned: true } : null,
        writeRecord: async () => { throw new Error('This inventory fixture does not request organization mutations'); },
      },
    };
    const executor = createExecutor({
      promptDocCreate: async ({ signal, ...request }) => createPromptDocInLibrary({ store, request, signal }),
      promptDocFavoriteSet: async ({ signal, ...request }) => setPromptDocFavorite({ store, request, signal }),
      promptsLibraryList: async ({ signal, ...request }) => listPromptLibrary({ store, request, signal }),
    });
    for (const surface of ['agent', 'mcp', 'cli', 'ui'] as const) {
      const context = { surface, actionsSettings: routingApprovalSettings };
      expect(getActionSpec('prompt_doc.create').surfaces[surface]).toBe(true);
      expect(await executor.execute('prompt_doc.create', { title: 'Saved', markdown: 'Text', favorite: false }, context)).toMatchObject({ ok: true, result: { artifactId: 'saved' } });
      expect(await executor.execute('prompt_doc.favorite.set', { artifactId: 'saved', favorite: true }, context)).toMatchObject({ ok: true });
      expect(await executor.execute('prompts.library.list', {}, context)).toMatchObject({ ok: true, result: { coverage: 'complete', items: [{ artifactId: 'saved', favorite: true }] } });
    }
  });
  it('routes machine installation through its transport and validates its strict result without losing partial effects', async () => {
    const signal = new AbortController().signal;
    const receipt = { root: '/skills', path: '/skills/review', digest: 'sha256:' + 'a'.repeat(64) };
    const requests: Readonly<{ actionId: string; input: unknown; signal?: AbortSignal }>[] = [];
    const machineResponses = new Map<string, unknown>([
      ['skills.machine.install', { receipts: [receipt] }],
      ['skills.machine.uninstall', { removed: [receipt.path] }],
    ]);
    // Machine process transport boundary; real filesystem/receipt composition is CLI-owned.
    const executor = createExecutor({ skillMachineActionExecute: async ({ actionId, input, context }) => {
      requests.push({ actionId, input, signal: context.signal });
      return machineResponses.get(actionId);
    } });
    const context = { surface: 'ui', signal, bypassApprovals: true } as const;
    expect(await executor.execute('skills.machine.install', { skillId: 'skill', machineId: 'machine', agents: ['codex'] }, context))
      .toEqual({ ok: true, result: { receipts: [receipt] } });
    expect(await executor.execute('skills.machine.uninstall', { skillId: 'skill', machineId: 'machine' }, context))
      .toEqual({ ok: true, result: { removed: [receipt.path] } });
    expect(requests).toEqual([
      { actionId: 'skills.machine.install', input: { skillId: 'skill', machineId: 'machine', agents: ['codex'] }, signal },
      { actionId: 'skills.machine.uninstall', input: { skillId: 'skill', machineId: 'machine' }, signal },
    ]);
    machineResponses.set('skills.machine.install', { receipts: [receipt], privateField: true });
    expect(await executor.execute('skills.machine.install', { skillId: 'skill', machineId: 'machine' }, context))
      .toMatchObject({ ok: false, errorCode: 'invalid_action_output' });
    const partial = { ok: false, errorCode: 'native_conflict', error: 'native_conflict', details: { receipts: [receipt] } };
    machineResponses.set('skills.machine.install', partial);
    expect(await executor.execute('skills.machine.install', { skillId: 'skill', machineId: 'machine' }, context)).toEqual(partial);
    expect(await createExecutor().execute('skills.machine.install', { skillId: 'skill', machineId: 'machine' }, context))
      .toMatchObject({ ok: false, errorCode: 'unsupported_action' });
  });

  it('persists reviewed prompt edits and personal tags through the real document operation', async () => {
    const original: PromptLibraryStoredArtifact = { id: 'doc-1', revision: { headerVersion: 1, bodyVersion: 1 },
      header: PromptDocArtifactHeaderV1Schema.parse({ v: 1, kind: 'prompt_doc.v2', title: 'Original' }),
      body: JSON.stringify(PromptDocBodyV1Schema.parse({ v: 1, markdown: 'Original', createdAtMs: 1, updatedAtMs: 1 })) };
    const { store, artifacts, readOrganization } = createStoredLibrary([original]);
    const executor = createExecutor({ promptDocUpdate: async ({ signal, ...request }) => updatePromptDocInLibrary({ store, request, signal }) });
    const res = await executor.execute('prompt_doc.update', {
      artifactId: 'doc-1',
      title: 'Review prompt',
      markdown: '# Review',
      tags: ['review'],
      expectedRevision: original.revision,
    }, { surface: 'ui', actionsSettings: routingApprovalSettings });
    const stored = artifacts.get('doc-1')!;
    expect(res).toEqual({ ok: true, result: { ok: true, artifactId: 'doc-1', revision: { headerVersion: 2, bodyVersion: 2 } } });
    expect(PromptDocArtifactHeaderV1Schema.parse(stored.header)).toMatchObject({ title: 'Review prompt' });
    expect(PromptDocBodyV1Schema.parse(JSON.parse(stored.body!))).toMatchObject({ markdown: '# Review', createdAtMs: 1 });
    expect(readOrganization().value).toMatchObject({ artifactHeadersById: { 'doc-1': { tags: ['review'] } } });
    expect(stored.header).not.toHaveProperty('tags');
    const accepted = stored;
    expect(await executor.execute('prompt_doc.update', { artifactId: 'doc-1', title: 'Stale', markdown: 'Stale',
      expectedRevision: { headerVersion: 1, bodyVersion: 1 } }, { surface: 'ui', actionsSettings: routingApprovalSettings }))
      .toMatchObject({ ok: false, errorCode: 'version_mismatch' });
    expect(artifacts.get('doc-1')).toBe(accepted);
  });

  it('updates the stored skill and personal folder through the real bundle operation', async () => {
    const original: PromptLibraryStoredArtifact = { id: 'bundle-1', revision: { headerVersion: 1, bodyVersion: 1 },
      header: PromptBundleArtifactHeaderV1Schema.parse({ v: 1, kind: 'prompt_bundle.v2', title: 'Old', bundleSchemaId: 'skills.skill_md_v1' }),
      body: JSON.stringify(PromptBundleBodyV1Schema.parse({ v: 1, createdAtMs: 1, updatedAtMs: 1, entries: [
        { path: 'SKILL.md', contentBase64: 'T2xk', contentKind: 'utf8' },
        { path: 'support.bin', contentBase64: 'AAE=', contentKind: 'binary' },
      ] })) };
    const { store, artifacts, readOrganization } = createStoredLibrary([original]);
    const executor = createExecutor({ promptBundleUpdate: ({ signal, ...request }) => updatePromptBundleInLibrary({ store, request, signal }) });
    const res = await executor.execute('prompt_bundle.update', {
      artifactId: 'bundle-1',
      title: 'Reviewer',
      skillMarkdown: '# Reviewer',
      folderId: 'folder-1',
    }, { surface: 'ui', actionsSettings: routingApprovalSettings });

    expect(res).toEqual({ ok: true, result: { ok: true, artifactId: 'bundle-1', revision: { headerVersion: 2, bodyVersion: 2 } } });
    const stored = artifacts.get('bundle-1')!;
    expect(PromptBundleArtifactHeaderV1Schema.parse(stored.header)).toMatchObject({ title: 'Reviewer' });
    const body = PromptBundleBodyV1Schema.parse(JSON.parse(stored.body!));
    expect(new TextDecoder().decode(decodeBase64(body.entries.find(entry => entry.path === 'SKILL.md')!.contentBase64, 'base64'))).toBe('# Reviewer');
    expect(body.entries.find(entry => entry.path === 'support.bin')).toEqual({ path: 'support.bin', contentBase64: 'AAE=', contentKind: 'binary' });
    expect(readOrganization().value).toMatchObject({ artifactHeadersById: { 'bundle-1': { folderId: 'folder-1' } } });
    expect(stored.header).not.toHaveProperty('folderId');
  });

  it.each(['ui', 'agent', 'mcp'] as const)('PARITY2 asks before %s registry installation without writing library data', async (surface) => {
    const promptRegistryInstall = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({ promptRegistryInstall,
      approvalsCreate: async () => ({ artifactId: 'registry-approval' }),
    });
    const result = await executor.execute('prompt_registry.install', { machineId: 'machine-1', sourceId: 'repo', itemId: 'frontend-design' }, {
      surface, authority: 'account_automation', serverId: 'home', actionRequestId: `registry-${surface}`,
    });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true,
      result: { kind: 'approval_request_created', artifactId: 'registry-approval' } });
    expect(promptRegistryInstall).not.toHaveBeenCalled();
  });

  it.each(['ui', 'agent', 'mcp'] as const)('PARITY2 keeps %s waived registry installation pinned and partial-effect aware', async (surface) => {
    const { store, artifacts } = createStoredLibrary(), fetched = fetchedRegistrySkill();
    let rules: SkillRuleV1[] = [], revision = 1, readBackUnavailable = false;
    const skills = createSkillActionExecuteV1({ store: { ...store, read: async (id, options) => readBackUnavailable && artifacts.has(id) ? null : store.read(id, options),
        // Held-source detection is not this test's subject: once read-back is unavailable the index holds nothing, so the repeat install is a fresh effect.
        list: async () => ({ coverage: 'complete', items: readBackUnavailable ? [] : [...artifacts.values()].map(artifact => ({ id: artifact.id, header: artifact.header, updatedAtMs: 1 })) }) },
      randomId: () => 'rule', nowMs: () => 4,
      skillRules: { serverId: 'home', assertCurrent: () => {}, ruleWriteContext: () => ({ nowMs: 4, newId: () => 'rule' }),
        listSkills: signal => readSkillLibraryCatalog({ list: async () => ({ coverage: 'complete', items: [...artifacts.values()].map(artifact => ({
          artifactId: artifact.id, header: artifact.header, body: artifact.body,
        })) }) }, signal),
        readCatalog: async () => ({ catalog: { status: 'ready', rows: [{ record: { key: 'skill-rules', value: { v: 1, rules } }, revision }], diagnostics: [], tombstones: [] } }),
        writeRecord: async input => { if (input.record.key === 'skill-rules') rules = input.record.value.rules; return { status: 'updated', revision: ++revision, cursor: revision }; },
      },
      includeInSession: async () => ({ ok: true, state: 'on', previous: 'inherit', applyTiming: { t: 'next_turn' } }),
      readRegistryItem: async () => fetched.item,
      readRegistrySource: async () => ({ id: 'repo', title: 'Repo', url: 'https://github.com/a/b', format: 'git', kinds: ['skill'], enabled: true, addedAt: 1, origin: { kind: 'user' }, removable: true }),
      fetchRegistrySkillFiles: async () => fetched.files.map(file => ({ path: file.path, unixMode: 0o644, bytes: decodeBase64(file.contentBase64) })),
    });
    const executor = createExecutor({ promptRegistryInstall: async ({ signal, ...request }, context) => {
      expect(request).not.toHaveProperty('installTarget');
      return installPromptRegistryItemInLibrary({ request, signal, fetchItem: async () => fetched.item,
        installLibrary: pointer => skills('skills.install', { source: { kind: 'registry', ...pointer } }, { surface: context.surface ?? null }) });
    } });
    const input = { machineId: 'machine-1', sourceId: 'repo', itemId: 'frontend-design',
      installTarget: { assetTypeId: 'agents.skill', scope: 'project', directory: '/tmp/project', targetName: 'frontend-design', installMode: 'copy' },
      configuredSources: [{ arbitraryOldAccountDeclarations: true }] };
    const context = { surface, actionsSettings: ActionsSettingsV1Schema.parse({
      ...routingApprovalSettings, approvalWaivedSurfaces: { ...routingApprovalSettings.approvalWaivedSurfaces,
        'prompt_registry.install': [surface] },
    }) };
    const result = await executor.execute('prompt_registry.install', input, context);
    expect(result).toMatchObject({ ok: true, result: { ok: true, artifactId: 'artifact-1', exported: false, skillIds: ['artifact-1'] } });
    expect(artifacts.get('artifact-1')?.header).toMatchObject({ skillLock: { provenance: { kind: 'registry', registry: { ref: { commit: 'abc' } } } } });
    if (surface === 'agent') expect(rules).toEqual([]);
    else expect(rules).toMatchObject([{ skillId: 'artifact-1', enabled: true }]);
    if (!result.ok) throw new Error('Expected retained library installation');
    expect(result.result).not.toHaveProperty('nextPromptExternalLinks');
    readBackUnavailable = true;
    const partial = await executor.execute('prompt_registry.install', input, context);
    expect(partial).toMatchObject({ ok: false, errorCode: 'created_skill_unreadable',
      details: { skillIds: ['artifact-2'], incomplete: surface === 'agent' ? [] : [{ skillId: 'artifact-2', step: 'rules' }] } });
    if (partial.ok) throw new Error('Expected retained partial failure');
    expect(LegacySkillRegistryInstallEffectsV1Schema.parse(partial.details)).toMatchObject({ skillIds: ['artifact-2'] });
    expect(artifacts.has('artifact-2')).toBe(true);
  });
});
