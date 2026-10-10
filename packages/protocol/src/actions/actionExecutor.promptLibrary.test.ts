import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { createPromptDocInLibrary, listPromptLibrary, setPromptDocFavorite, type PromptLibraryStoredArtifact } from '../prompts/library/promptLibraryActionOperations.js';
import { getActionSpec } from './actionSpecs.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { writeSessionContextIntentV1ToMetadata } from '../sessions/context/sessionContextV1.js';
import type { StoredContentPublicShareV1 } from '../sharing/storedContentPublicShareV1.js';
import type { PromptLibraryRecordV1 } from '../prompts/library/promptLibraryRowsV1.js';
import { MemoryMutationResultV1Schema } from '../prompts/library/memoryActionsV1.js';

function createExecutor(overrides: Partial<ActionExecutorDeps> = {}) {
  return createActionExecutor({
    executionRunStart: async () => ({}),
    executionRunList: async () => ({}),
    executionRunGet: async () => ({}),
    detachedExecutionRunSend: async () => ({}),
    executionRunStop: async () => ({}),
    executionRunAction: async () => ({}),
    executionRunWait: async () => ({}),
    sessionOpen: async () => ({}),
    sessionFork: async () => ({}),
    sessionRollback: async () => ({}),
    sessionSpawnNew: async () => ({}),
    pathsListRecent: async () => ({ items: [] }),
    machinesList: async () => ({ items: [] }),
    serversList: async () => ({ items: [] }),
    reviewEnginesList: async () => ({ items: [] }),
    agentsBackendsList: async () => ({ items: [] }),
    agentsModelsList: async () => ({ items: [] }),
    sessionSendMessage: async () => ({}),
    sessionPermissionRespond: async () => ({}),
    sessionUserActionAnswer: async () => ({}),
    sessionModeSet: async () => ({}),
    sessionModesList: async () => ({ items: [] }),
    sessionTargetPrimarySet: async () => ({}),
    sessionTargetTrackedSet: async () => ({}),
    sessionList: async () => ({}),
    sessionActivityGet: async () => ({}),
    sessionRecentMessagesGet: async () => ({}),
    daemonMemorySearch: async () => ({ v: 1, ok: true as const, hits: [] }),
    daemonMemoryGetWindow: async () => ({ v: 1, snippets: [], citations: [] }),
    daemonMemoryEnsureUpToDate: async () => ({}),
    resetGlobalVoiceAgent: async () => {},
    // Routing tests exercise the domain ports, not the shared approval owner.
    isActionApprovalRequired: () => false,
    ...overrides,
  });
}

describe('createActionExecutor (prompt library actions)', () => {
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
        listArtifactHeaders: async () => ({ items: [], coverage: 'complete' as const }),
        writeRecord: async () => {
          if (writerUnavailable) throw Object.assign(new Error('private transport material'), { details: { secret: 'private transport material' } });
          return { status: 'conflict' as const, revision: 5 };
        },
      },
    };
    const executor = createExecutor({ promptDocCreate: request => createPromptDocInLibrary({ store, request }) });
    const receipt = await executor.execute('prompt_doc.create', { title: 'Created content', markdown: 'Retained content', folderId: 'folder' },
      { surface: 'cli', serverId: 'home' });
    expect(receipt).toMatchObject({ ok: false, errorCode: 'artifact_organization_failed', details: {
      artifactId: 'created', organization: { status: 'conflict', revision: 5 },
    } });
    expect(artifacts.get('created')).toMatchObject({ header: { title: 'Created content' }, body: expect.stringContaining('Retained content') });
    expect(artifacts.get('created')?.header).not.toHaveProperty('folderId');
    writerUnavailable = true;
    const unavailable = await executor.execute('prompt_doc.create', { title: 'Other content', markdown: 'Retained too', folderId: 'folder' },
      { surface: 'cli', serverId: 'home' });
    expect(unavailable).toMatchObject({ ok: false, errorCode: 'artifact_organization_failed', details: {
      artifactId: 'created-2', organization: { status: 'unavailable', reason: 'artifact_organization_unavailable' },
    } });
    expect(JSON.stringify(unavailable)).not.toContain('private transport material');
    expect(artifacts.get('created-2')?.body).toContain('Retained too');
  });
  it('reads the complete personal folder tree including empty folders through the admitted Action owner', async () => {
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
      listArtifactHeaders: async () => { throw new Error('Folder reads must not require Artifact enumeration'); },
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
      listArtifactHeaders: async () => ({ items: [], coverage: 'complete' as const }),
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
      isActionApprovalRequired: () => false,
      artifactFolders: {
        serverId: 'home', assertCurrent: () => {},
        // A host-profile resolution boundary admits its known alias, never a foreign Home.
        matchesServerId: (serverId: string) => serverId === 'home' || serverId === 'home-alias',
        readCatalog: async () => ({ catalog: { status: 'ready' as const, rows: [{ record, revision }], tombstones: [], diagnostics: [] } }),
        readArtifactHeader: async () => ({ header: sharedHeader, owned: false }),
        listArtifactHeaders: async () => ({ items: [], coverage: 'complete' as const }),
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
    let inventoryCoverage: 'complete' | 'partial' | 'unavailable' = 'complete';
    const deps = { isActionApprovalRequired: () => false, artifactFolders: {
      serverId: 'home', assertCurrent: () => { if (!current) throw Object.assign(new Error('Retired Home'), { code: 'scope-retired' }); },
      readCatalog: async () => ({ catalog: unavailable
        ? { status: 'unavailable' as const, reason: 'unreachable' as const }
        : { status: 'ready' as const, rows: [{ record, revision: 2 }], tombstones: [], diagnostics: [] } }),
      writeRecord: async () => { writes++; return { status: 'updated' as const, revision: 3, cursor: 3 }; },
      readArtifactHeader: async () => null,
      listArtifactHeaders: async () => ({ items: [], coverage: inventoryCoverage }),
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
    for (const coverage of ['partial', 'unavailable'] as const) {
      inventoryCoverage = coverage;
      expect(await executor.execute('artifact.folders.delete', { folderId: 'one', expectedRevision: 2 }, { surface: 'ui', serverId: 'home' }))
        .toMatchObject({ ok: true, result: { status: 'unavailable', reason: 'artifact_inventory_incomplete' } });
      expect(record.value.folders).toEqual([{ id: 'one', name: 'One' }]);
    }
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
      header: { v: 1, kind: 'memory_doc.v1', title: 'Memory' }, body: JSON.stringify({ v: 1, facts: [], archive: [] }) };
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
    const request = () => ({ ref: { kind: 'doc', artifactId: 'memory', serverId: 'home' }, expectedRevision: stored.revision, text: 'Prefer tea; password=secret' });
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
  it('creates memory only on first remember, reuses the reserved attachment and retains an attach-conflicted fact', async () => {
    const artifacts = new Map<string, PromptLibraryStoredArtifact>();
    let metadata: Record<string, unknown> = { bot: { kind: 'bot' }, work: { memoryEnabled: true, promptStack: [] } };
    let revision = 3;
    let creates = 0;
    let attaches = 0;
    let conflict = false;
    let ids = 0;
    const executor = createExecutor({ isActionApprovalRequired: undefined,
      memoryLibrary: { serverId: 'home', randomId: () => `fact-${++ids}`,
      store: { read: async id => artifacts.get(id) ?? null, create: async input => { creates++; const id = `memory-${creates}`;
        artifacts.set(id, { id, header: input.header, body: input.body, revision: { headerVersion: 1, bodyVersion: 1 } }); return id; },
      update: async input => { const prior = artifacts.get(input.artifactId)!;
        artifacts.set(prior.id, { ...prior, body: input.body, revision: { headerVersion: prior.revision.headerVersion + 1, bodyVersion: prior.revision.bodyVersion + 1 } }); } },
      readSession: async () => ({ metadata, revision }),
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
    expect(await executor.execute('memory.remember', request(), context)).toMatchObject({ ok: true, result: { artifactId: 'memory-1' } });
    expect(creates).toBe(1); expect(attaches).toBe(1);
    expect(JSON.parse(artifacts.get('memory-1')!.body!).index).toHaveLength(2);
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
    expect(await executor.execute('memory.remember', request(), context)).toMatchObject({ ok: true, result: { artifactId: 'memory-2' } });
    expect(creates).toBe(2);
    expect(attaches).toBe(2);
    expect(JSON.parse(artifacts.get('memory-2')!.body!).index).toHaveLength(2);
    expect(await executor.execute('memory.remember', { ...request(), expectedMetadataRevision: revision - 1 }, context))
      .toMatchObject({ ok: false, errorCode: 'version_mismatch' });
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
      body: JSON.stringify({ v: 1, facts: [], archive: [] }),
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
    expect(await executor.execute('memory.remember', request, context)).toMatchObject({ ok: true,
      result: { kind: 'approval_request_created' } });
    expect(artifacts.get('project-memory')!.revision.bodyVersion).toBe(2);
    shared = false; projectEntries = [];
    expect(await executor.execute('memory.remember', request, context)).toMatchObject({ ok: true, result: { artifactId: 'account-memory' } });
    accountEntries = [];
    expect(await executor.execute('memory.remember', request, context)).toMatchObject({ ok: true,
      result: { artifactId: 'created-1', attachment: 'attached' } });
    expect(await executor.execute('memory.remember', request, context)).toMatchObject({ ok: true, result: { artifactId: 'created-1' } });
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
        .toMatchObject({ ok: true, result: { artifactId: receipt.artifactId } });
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
      body: JSON.stringify({ v: 1, facts: [{ id: 'current', text: 'Current truth', createdAtMs: 1, sourceSessionRef: null }], archive: [] }) };
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
        listArtifactHeaders: async () => ({ items: stored ? [{ artifactId: stored.id, header: stored.header, owned: true }] : [], coverage: 'complete' as const }),
        writeRecord: async () => { throw new Error('This inventory fixture does not request organization mutations'); },
      },
    };
    const executor = createExecutor({
      promptDocCreate: async ({ signal, ...request }) => createPromptDocInLibrary({ store, request, signal }),
      promptDocFavoriteSet: async ({ signal, ...request }) => setPromptDocFavorite({ store, request, signal }),
      promptsLibraryList: async ({ signal, ...request }) => listPromptLibrary({ store, request, signal }),
    });
    for (const surface of ['agent', 'mcp', 'cli', 'ui'] as const) {
      expect(getActionSpec('prompt_doc.create').surfaces[surface]).toBe(true);
      expect(await executor.execute('prompt_doc.create', { title: 'Saved', markdown: 'Text', favorite: false }, { surface })).toMatchObject({ ok: true, result: { artifactId: 'saved' } });
      expect(await executor.execute('prompt_doc.favorite.set', { artifactId: 'saved', favorite: true }, { surface })).toMatchObject({ ok: true });
      expect(await executor.execute('prompts.library.list', {}, { surface })).toMatchObject({ ok: true, result: { coverage: 'complete', items: [{ artifactId: 'saved', favorite: true }] } });
    }
  });
  it('routes daemon prompt adapter actions through canonical deps with caller cancellation', async () => {
    const signal = new AbortController().signal;
    const daemonPromptAssetsDiscover = vi.fn(async () => ({ ok: true, items: [] }));
    const daemonPromptAssetsDelete = vi.fn(async () => ({ ok: true }));
    const daemonPromptRegistryScanSource = vi.fn(async () => ({ ok: true, items: [] }));
    const daemonPromptRegistryInstall = vi.fn(async () => ({ ok: true, installed: true }));
    const executor = createExecutor({
      daemonPromptAssetsDiscover,
      daemonPromptAssetsDelete,
      daemonPromptRegistryScanSource,
      daemonPromptRegistryInstall,
    });

    await expect(executor.execute('daemon.promptAssets.discover', {
      assetTypeId: 'agents.skill',
      scope: 'user',
    }, { surface: 'rpc', signal })).resolves.toEqual({ ok: true, result: { ok: true, items: [] } });
    await expect(executor.execute('daemon.promptAssets.delete', {
      assetTypeId: 'agents.skill',
      scope: 'user',
      externalRef: { path: 'skills/review' },
    }, { surface: 'rpc', signal })).resolves.toEqual({ ok: true, result: { ok: true } });
    await expect(executor.execute('daemon.promptRegistry.scanSource', {
      sourceId: 'skills_sh:featured',
    }, { surface: 'rpc', signal })).resolves.toEqual({ ok: true, result: { ok: true, items: [] } });
    await expect(executor.execute('daemon.promptRegistry.install', {
      sourceId: 'skills_sh:featured',
      itemId: 'review',
      installTarget: {
        assetTypeId: 'agents.skill',
        scope: 'user',
        targetName: 'review',
      },
    }, { surface: 'rpc', signal })).resolves.toEqual({ ok: true, result: { ok: true, installed: true } });

    expect(daemonPromptAssetsDiscover).toHaveBeenCalledWith({
      request: { assetTypeId: 'agents.skill', scope: 'user' },
      signal,
    });
    expect(daemonPromptAssetsDelete).toHaveBeenCalledWith({
      request: {
        assetTypeId: 'agents.skill',
        scope: 'user',
        externalRef: { path: 'skills/review' },
      },
      signal,
    });
    expect(daemonPromptRegistryScanSource).toHaveBeenCalledWith({
      request: { sourceId: 'skills_sh:featured', configuredSources: [] },
      signal,
    });
    expect(daemonPromptRegistryInstall).toHaveBeenCalledWith({
      request: {
        sourceId: 'skills_sh:featured',
        itemId: 'review',
        configuredSources: [],
        installTarget: {
          assetTypeId: 'agents.skill',
          scope: 'user',
          targetName: 'review',
        },
      },
      signal,
    });
  });

  it('routes prompt_doc.update to deps.promptDocUpdate', async () => {
    const promptDocUpdate = vi.fn(async () => ({ ok: true, artifactId: 'doc-1' }));
    const executor = createExecutor({ promptDocUpdate } as Partial<ActionExecutorDeps>);

    const res = await executor.execute('prompt_doc.update' as any, {
      artifactId: 'doc-1',
      title: 'Review prompt',
      markdown: '# Review',
      tags: ['review'],
    }, { surface: 'ui' });

    expect(res).toEqual({ ok: true, result: { ok: true, artifactId: 'doc-1' } });
    expect(promptDocUpdate).toHaveBeenCalledWith({
      artifactId: 'doc-1',
      title: 'Review prompt',
      markdown: '# Review',
      tags: ['review'],
    });
  });

  it('routes prompt_bundle.update to deps.promptBundleUpdate', async () => {
    const promptBundleUpdate = vi.fn(async () => ({ ok: true, artifactId: 'bundle-1' }));
    const executor = createExecutor({ promptBundleUpdate } as Partial<ActionExecutorDeps>);

    const res = await executor.execute('prompt_bundle.update' as any, {
      artifactId: 'bundle-1',
      title: 'Reviewer',
      skillMarkdown: '# Reviewer',
      folderId: 'folder-1',
    }, { surface: 'ui' });

    expect(res).toEqual({ ok: true, result: { ok: true, artifactId: 'bundle-1' } });
    expect(promptBundleUpdate).toHaveBeenCalledWith({
      artifactId: 'bundle-1',
      title: 'Reviewer',
      skillMarkdown: '# Reviewer',
      folderId: 'folder-1',
    });
  });

  it('routes prompt_asset.export to deps.promptAssetExport', async () => {
    const promptAssetExport = vi.fn(async () => ({ ok: true, artifactId: 'doc-1' }));
    const executor = createExecutor({ promptAssetExport } as Partial<ActionExecutorDeps>);

    const res = await executor.execute('prompt_asset.export' as any, {
      artifactId: 'doc-1',
      machineId: 'machine-1',
      assetTypeId: 'claude.command',
      scope: 'user',
      targetPath: 'review.md',
      installMode: 'symlink',
    }, { surface: 'ui' });

    expect(res).toEqual({ ok: true, result: { ok: true, artifactId: 'doc-1' } });
    expect(promptAssetExport).toHaveBeenCalledWith({
      artifactId: 'doc-1',
      machineId: 'machine-1',
      assetTypeId: 'claude.command',
      scope: 'user',
      targetPath: 'review.md',
      installMode: 'symlink',
    });
  });

  it('forwards server routing to prompt_asset.export deps', async () => {
    const promptAssetExport = vi.fn(async () => ({ ok: true, artifactId: 'doc-1' }));
    const executor = createExecutor({ promptAssetExport } as Partial<ActionExecutorDeps>);

    const res = await executor.execute('prompt_asset.export' as any, {
      artifactId: 'doc-1',
      machineId: 'machine-1',
      assetTypeId: 'claude.command',
      scope: 'user',
      targetPath: 'review.md',
    }, {
      surface: 'ui',
      serverId: 'server-1',
    });

    expect(res).toEqual({ ok: true, result: { ok: true, artifactId: 'doc-1' } });
    expect(promptAssetExport).toHaveBeenCalledWith({
      artifactId: 'doc-1',
      machineId: 'machine-1',
      assetTypeId: 'claude.command',
      scope: 'user',
      targetPath: 'review.md',
      serverId: 'server-1',
    });
  });

  it('propagates prompt_asset.export failures from deps', async () => {
    const promptAssetExport = vi.fn(async () => ({ ok: false, errorCode: 'conflict', error: 'conflict' }));
    const executor = createExecutor({ promptAssetExport } as Partial<ActionExecutorDeps>);

    const res = await executor.execute('prompt_asset.export' as any, {
      artifactId: 'doc-1',
      machineId: 'machine-1',
      assetTypeId: 'claude.command',
      scope: 'user',
      targetPath: 'review.md',
    }, { surface: 'ui' });

    expect(res).toEqual({ ok: false, errorCode: 'conflict', error: 'conflict' });
  });

  it('routes prompt_registry.install to deps.promptRegistryInstall', async () => {
    const promptRegistryInstall = vi.fn(async () => ({ ok: true, artifactId: 'bundle-1', exported: true }));
    const executor = createExecutor({ promptRegistryInstall } as Partial<ActionExecutorDeps>);

    const res = await executor.execute('prompt_registry.install' as any, {
      machineId: 'machine-1',
      sourceId: 'skills_sh:featured',
      itemId: 'skills_sh:featured:item-1',
      configuredSources: [],
      installTarget: {
        assetTypeId: 'agents.skill',
        scope: 'project',
        directory: '/tmp/project',
        targetName: 'frontend-design',
        installMode: 'symlink',
      },
    }, { surface: 'ui' });

    expect(res).toEqual({ ok: true, result: { ok: true, artifactId: 'bundle-1', exported: true } });
    expect(promptRegistryInstall).toHaveBeenCalledWith({
      machineId: 'machine-1',
      sourceId: 'skills_sh:featured',
      itemId: 'skills_sh:featured:item-1',
      configuredSources: [],
      installTarget: {
        assetTypeId: 'agents.skill',
        scope: 'project',
        directory: '/tmp/project',
        targetName: 'frontend-design',
        installMode: 'symlink',
      },
    });
  });

  it('forwards server routing to prompt_registry.install deps', async () => {
    const promptRegistryInstall = vi.fn(async () => ({ ok: true, artifactId: 'bundle-1', exported: true }));
    const executor = createExecutor({ promptRegistryInstall } as Partial<ActionExecutorDeps>);

    const res = await executor.execute('prompt_registry.install' as any, {
      machineId: 'machine-1',
      sourceId: 'skills_sh:featured',
      itemId: 'skills_sh:featured:item-1',
      configuredSources: [],
    }, {
      surface: 'ui',
      serverId: 'server-1',
    });

    expect(res).toEqual({ ok: true, result: { ok: true, artifactId: 'bundle-1', exported: true } });
    expect(promptRegistryInstall).toHaveBeenCalledWith({
      machineId: 'machine-1',
      sourceId: 'skills_sh:featured',
      itemId: 'skills_sh:featured:item-1',
      configuredSources: [],
      serverId: 'server-1',
    });
  });

  it('propagates prompt_registry.install failures from deps', async () => {
    const promptRegistryInstall = vi.fn(async () => ({ ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' }));
    const executor = createExecutor({ promptRegistryInstall } as Partial<ActionExecutorDeps>);

    const res = await executor.execute('prompt_registry.install' as any, {
      machineId: 'machine-1',
      sourceId: 'skills_sh:featured',
      itemId: 'skills_sh:featured:item-1',
      configuredSources: [],
    }, { surface: 'ui' });

    expect(res).toEqual({ ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' });
  });
});
