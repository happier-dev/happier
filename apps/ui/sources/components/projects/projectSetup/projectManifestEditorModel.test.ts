import { afterEach, describe, expect, it } from 'vitest';
import { readProjectManifestDocument } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestDocument';
// Keep the pure draft owner independent of the testkit barrel's rendered surface graph.
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { buildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import { workspaceFileEditorDraftCache } from '@/components/workspaces/files/details/workspaceFileDetails/workspaceFileEditorDraftCache';

import {
  createProjectManifestEditorModel,
  type ProjectManifestEditorActions,
} from './projectManifestEditorModel';

const workspace = {
  serverId: 'home',
  workspaceId: 'workspace',
  machineId: 'machine',
  rootPath: '/project',
};
const filePath = '.happier/project.json';
const originalHash = 'a'.repeat(64);
const outsideHash = 'b'.repeat(64);
const savedHash = 'c'.repeat(64);
const initialBytes =
  '{\n  "version": 1,\n  "future": {"keep": [1, 2]},\n  "scripts": {\n    "build": {"source": {"kind":"command", "command":"old", "futureSource":true}, "futureEntry":{"ok":true}},\n    "test": {"source":{"kind":"native", "tool":"package_script", "file":"package.json", "target":"test"}}\n  }\n}\n';
const present = (bytes: string, hash = originalHash) => ({
  basis: { kind: 'present' as const, hash },
  document: readProjectManifestDocument(bytes),
});
const absent = { basis: { kind: 'absent' as const }, document: null };
function saved(bytes: string, hash: string) {
  const document = readProjectManifestDocument(bytes);
  if (document.status !== 'valid')
    throw new Error(
      'The Action transport cannot report an invalid saved document',
    );
  return {
    status: 'saved' as const,
    basis: { kind: 'present' as const, hash },
    document,
  };
}

function boundary(initial = present(initialBytes)) {
  const writes: Parameters<ProjectManifestEditorActions['update']>[0][] = [];
  let disk = initial;
  const actions: ProjectManifestEditorActions = {
    async update(request) {
      writes.push(request);
      disk = present(request.bytes, String(writes.length).padStart(64, '0'));
      return saved(request.bytes, disk.basis.hash);
    },
  };
  return { actions, writes, read: () => disk };
}

afterEach(() => {
  for (const accountId of ['alice', 'bob'])
    workspaceFileEditorDraftCache.setDraft({
      accountId,
      workspaceCacheKey: buildWorkspaceCacheKey(workspace),
      filePath,
      draft: null,
    });
});

describe('project manifest editor model', () => {
  it('shares a lossless Form/raw draft and saves reference imports, removal and declaration order through one Action', async () => {
    const transport = boundary();
    const model = createProjectManifestEditorModel({
      workspace,
      expectedAccountId: 'alice',
      definition: transport.read(),
      actions: transport.actions,
    });
    model.edit([
      {
        kind: 'set',
        path: ['scripts', 'build', 'source', 'command'],
        value: 'new',
      },
    ]);
    model.importNative({
      usage: 'script',
      name: 'deploy',
      source: {
        kind: 'pluginNative',
        adapter: { pluginId: 'example.pixi', localId: 'tasks' },
        file: 'pixi.toml',
        target: 'deploy',
      },
    });
    model.importEnvironment({
      kind: 'pluginToolchain',
      adapter: { pluginId: 'example.pixi', localId: 'environment' },
      configPath: 'pixi.toml',
    });
    model.removeDeclaration('scripts', 'test');
    model.reorderDeclarations('scripts', ['deploy', 'build']);
    expect(model.getSnapshot().draft.status).toBe('valid');
    expect(transport.writes).toHaveLength(0);
    expect(model.setMode('raw')).toBe(true);
    const intendedBytes = model.getSnapshot().draft.bytes;
    expect(intendedBytes).toContain('"future": {"keep": [1, 2]}');
    expect(intendedBytes).toContain('"command":"new", "futureSource":true');
    expect(intendedBytes).toContain('"futureEntry":{"ok":true}');
    const result = await model.save();
    expect(result?.status).toBe('saved');
    expect(transport.writes).toEqual([
      {
        workspace,
        expectedBasis: { kind: 'present', hash: originalHash },
        bytes: intendedBytes,
      },
    ]);
    const reopened = createProjectManifestEditorModel({
      workspace,
      expectedAccountId: 'alice',
      definition: transport.read(),
      actions: transport.actions,
    });
    const document = reopened.getSnapshot().draft;
    if (document.status !== 'valid')
      throw new Error('Expected usable document');
    expect(Object.keys(document.manifest.scripts ?? {})).toEqual([
      'deploy',
      'build',
    ]);
    expect(document.manifest.scripts?.deploy.source).toEqual({
      kind: 'pluginNative',
      adapter: { pluginId: 'example.pixi', localId: 'tasks' },
      file: 'pixi.toml',
      target: 'deploy',
    });
    expect(document.manifest.environment).toEqual({
      kind: 'pluginToolchain',
      adapter: { pluginId: 'example.pixi', localId: 'environment' },
      configPath: 'pixi.toml',
    });
    expect(
      document.diagnostics.filter((d) => d.code === 'unrecognized_key'),
    ).toHaveLength(3);
    expect(reopened.getSnapshot().dirty).toBe(false);
  });

  it('retains invalid bytes across Back, disables Form and saving, and submits exact repaired raw bytes', async () => {
    const transport = boundary();
    const model = createProjectManifestEditorModel({
      workspace,
      expectedAccountId: 'alice',
      definition: transport.read(),
      actions: transport.actions,
    });
    model.setMode('raw');
    model.setRaw('{\n  "version":');
    expect(model.getSnapshot().draft.bytes).toBe('{\n  "version":');
    expect(model.setMode('form')).toBe(false);
    expect(await model.save()).toBeNull();
    expect(transport.writes).toHaveLength(0);
    const reopened = createProjectManifestEditorModel({
      workspace,
      expectedAccountId: 'alice',
      definition: transport.read(),
      actions: transport.actions,
    });
    expect(reopened.getSnapshot()).toMatchObject({
      mode: 'raw',
      formEnabled: false,
      dirty: true,
      draft: { bytes: '{\n  "version":' },
    });
    const exactBytes = ' { "version" : 1, "future" : [true, null] } \n\n';
    reopened.setRaw(exactBytes);
    expect(reopened.setMode('form')).toBe(true);
    await reopened.save();
    expect(transport.writes[0].bytes).toBe(exactBytes);
  });

  it('preserves the draft and current outside edit until explicit reload or review of the new basis', async () => {
    const current = present('{"version":1,"future":"external"}', outsideHash);
    const writes: Parameters<ProjectManifestEditorActions['update']>[0][] = [];
    const actions: ProjectManifestEditorActions = {
      async update(request) {
        writes.push(request);
        return writes.length === 1
          ? { status: 'conflict', current }
          : saved(request.bytes, savedHash);
      },
    };
    const model = createProjectManifestEditorModel({
      workspace,
      expectedAccountId: 'alice',
      definition: present(initialBytes),
      actions,
    });
    model.setRaw('{"version":1,"future":"draft"}');
    expect((await model.save())?.status).toBe('conflict');
    expect(model.getSnapshot()).toMatchObject({
      draft: { bytes: '{"version":1,"future":"draft"}' },
      conflict: current,
      dirty: true,
    });
    expect(await model.save()).toBeNull();
    model.reviewCurrentBasis();
    expect(model.getSnapshot().draft.bytes).toBe(
      '{"version":1,"future":"draft"}',
    );
    await model.save();
    expect(writes[1].expectedBasis).toEqual({
      kind: 'present',
      hash: outsideHash,
    });
    model.setRaw('{"version":1,"future":"another draft"}');
    model.receiveDefinition(current);
    model.reloadCurrent();
    expect(model.getSnapshot()).toMatchObject({
      draft: current.document,
      conflict: null,
      dirty: false,
    });
  });

  it('uses an absence creation basis and keeps the proposed reference when another editor creates the file', async () => {
    const current = present(
      '{"version":1,"future":"other creator"}',
      outsideHash,
    );
    const writes: Parameters<ProjectManifestEditorActions['update']>[0][] = [];
    const actions: ProjectManifestEditorActions = {
      async update(request) {
        writes.push(request);
        return { status: 'conflict', current };
      },
    };
    const model = createProjectManifestEditorModel({
      workspace,
      expectedAccountId: 'alice',
      definition: absent,
      actions,
    });
    model.importNative({
      usage: 'script',
      name: 'build',
      source: {
        kind: 'native',
        tool: 'package_script',
        file: 'package.json',
        target: 'build',
      },
    });
    expect(writes).toHaveLength(0);
    await model.save();
    expect(writes[0].expectedBasis).toEqual({ kind: 'absent' });
    expect(model.getSnapshot().conflict).toEqual(current);
    const document = model.getSnapshot().draft;
    if (document.status !== 'valid') throw new Error('Expected usable draft');
    expect(document.manifest.scripts?.build.source).toEqual({
      kind: 'native',
      tool: 'package_script',
      file: 'package.json',
      target: 'build',
    });
  });

  it('retains edits typed during an admitted save and uses the saved basis for the next write', async () => {
    const pending =
      createDeferred<
        Awaited<ReturnType<ProjectManifestEditorActions['update']>>
      >();
    const writes: Parameters<ProjectManifestEditorActions['update']>[0][] = [];
    const actions: ProjectManifestEditorActions = {
      async update(request) {
        writes.push(request);
        return writes.length === 1
          ? pending.promise
          : saved(request.bytes, savedHash);
      },
    };
    const model = createProjectManifestEditorModel({
      workspace,
      expectedAccountId: 'alice',
      definition: present(initialBytes),
      actions,
    });
    model.setRaw('{"version":1,"future":"first"}');
    const saving = model.save();
    model.setRaw('{"version":1,"future":"later"}');
    pending.resolve(saved(writes[0].bytes, outsideHash));
    await saving;
    expect(model.getSnapshot()).toMatchObject({
      draft: { bytes: '{"version":1,"future":"later"}' },
      dirty: true,
      saving: false,
    });
    await model.save();
    expect(writes[1]).toMatchObject({
      expectedBasis: { kind: 'present', hash: outsideHash },
      bytes: '{"version":1,"future":"later"}',
    });
  });

  it('keeps an outside edit observed during an admitted save as a conflict after the saved reply', async () => {
    const pending =
      createDeferred<
        Awaited<ReturnType<ProjectManifestEditorActions['update']>>
      >();
    const model = createProjectManifestEditorModel({
      workspace,
      expectedAccountId: 'alice',
      definition: present(initialBytes),
      actions: {
        async update() {
          return pending.promise;
        },
      },
    });
    const bytes = '{"version":1,"future":"draft"}';
    const outside = present('{"version":1,"future":"outside"}', outsideHash);
    model.setRaw(bytes);
    const saving = model.save();
    model.receiveDefinition(outside);
    pending.resolve(saved(bytes, savedHash));
    await saving;
    expect(model.getSnapshot()).toMatchObject({
      saving: false,
      conflict: outside,
    });
    expect(await model.save()).toBeNull();
    model.reloadCurrent();
    expect(model.getSnapshot()).toMatchObject({
      draft: outside.document,
      dirty: false,
      conflict: null,
    });
  });

  it('detects a changed stored basis on reopening and preserves refused drafts', async () => {
    const transport = boundary();
    const model = createProjectManifestEditorModel({
      workspace,
      expectedAccountId: 'alice',
      definition: transport.read(),
      actions: transport.actions,
    });
    model.setRaw('{"version":1,"future":"retained"}');
    const current = present('{"version":1,"future":"outside"}', outsideHash);
    const reopened = createProjectManifestEditorModel({
      workspace,
      expectedAccountId: 'alice',
      definition: current,
      actions: {
        async update() {
          return { status: 'refused', code: 'access_denied' };
        },
      },
    });
    expect(reopened.getSnapshot()).toMatchObject({
      draft: { bytes: '{"version":1,"future":"retained"}' },
      conflict: current,
    });
    reopened.reviewCurrentBasis();
    expect((await reopened.save())?.status).toBe('refused');
    expect(reopened.getSnapshot()).toMatchObject({
      dirty: true,
      error: { code: 'access_denied' },
    });
  });

  it('suppresses no-op notifications and rejects accidental duplicate Add names', () => {
    const transport = boundary();
    const model = createProjectManifestEditorModel({
      workspace,
      expectedAccountId: 'alice',
      definition: transport.read(),
      actions: transport.actions,
    });
    const snapshots: ReturnType<typeof model.getSnapshot>[] = [];
    model.subscribe(() => snapshots.push(model.getSnapshot()));
    const first = model.getSnapshot();
    model.setRaw(initialBytes);
    model.receiveDefinition(transport.read());
    expect(model.getSnapshot()).toBe(first);
    expect(snapshots).toHaveLength(0);
    expect(
      model.importNative({
        usage: 'script',
        name: 'build',
        source: {
          kind: 'native',
          tool: 'make',
          file: 'Makefile',
          target: 'all',
        },
      }),
    ).toBe(false);
    expect(model.getSnapshot().draft.bytes).toBe(initialBytes);
  });

  it('keeps a cancelled or failed Action draft and its typed recovery reason', async () => {
    const model = createProjectManifestEditorModel({
      workspace,
      expectedAccountId: 'alice',
      definition: present(initialBytes),
      actions: {
        async update() {
          throw Object.assign(new Error('Approval declined'), {
            code: 'approval_declined',
          });
        },
      },
    });
    model.setRaw('{"version":1,"future":"retained after cancel"}');
    expect(await model.save()).toBeNull();
    expect(model.getSnapshot()).toMatchObject({
      saving: false,
      dirty: true,
      draft: { bytes: '{"version":1,"future":"retained after cancel"}' },
      error: { code: 'approval_declined' },
    });
  });

  it('reviews the displayed conflict basis rather than a later unchanged-baseline observation', async () => {
    const transport = boundary();
    const original = transport.read();
    const model = createProjectManifestEditorModel({
      workspace,
      expectedAccountId: 'alice',
      definition: original,
      actions: transport.actions,
    });
    model.setRaw('{"version":1,"future":"draft"}');
    const outside = present('{"version":1,"future":"outside"}', outsideHash);
    model.receiveDefinition(outside);
    model.receiveDefinition(original);
    expect(model.getSnapshot().conflict).toEqual(outside);
    model.reviewCurrentBasis();
    await model.save();
    expect(transport.writes[0].expectedBasis).toEqual(outside.basis);
  });

  it('renames a declaration in place, edits setup steps by position and selects the Devcontainer namespace on the same lossless draft', () => {
    const transport = boundary(
      present(
        '{\n  "version": 1,\n  "future": true,\n  "workspace": {"setup": [{"kind":"command","command":"a"}, {"kind":"command","command":"b"}, {"kind":"command","command":"c"}], "futureSetup": 1},\n  "scripts": {\n    "build": {"source": {"kind":"command", "command":"old"}, "futureEntry":{"ok":true}},\n    "test": {"source":{"kind":"command", "command":"t"}}\n  }\n}\n',
      ),
    );
    const model = createProjectManifestEditorModel({
      workspace,
      expectedAccountId: 'alice',
      definition: transport.read(),
      actions: transport.actions,
    });
    // A rename keeps the declaration's place and every unknown field inside it.
    expect(model.renameDeclaration('scripts', 'build', 'compile')).toBe(true);
    // A taken or empty name is refused rather than overwriting another declaration.
    expect(model.renameDeclaration('scripts', 'compile', 'test')).toBe(false);
    expect(model.renameDeclaration('scripts', 'compile', ' ')).toBe(false);
    expect(model.reorderSetupSteps([2, 0, 1])).toBe(true);
    expect(model.removeSetupStep(1)).toBe(true);
    expect(
      model.selectDevcontainer({
        configPath: '.devcontainer/devcontainer.json',
      }),
    ).toBe(true);
    let document = model.getSnapshot().draft;
    if (document.status !== 'valid')
      throw new Error('Expected usable document');
    expect(Object.keys(document.manifest.scripts ?? {})).toEqual([
      'compile',
      'test',
    ]);
    expect(document.bytes).toContain('"futureEntry":{"ok":true}');
    expect(document.bytes).toContain('"futureSetup": 1');
    expect(document.manifest.workspace?.setup).toEqual([
      { kind: 'command', command: 'c' },
      { kind: 'command', command: 'b' },
    ]);
    expect(document.manifest.devcontainer).toEqual({
      configPath: '.devcontainer/devcontainer.json',
    });
    // The namespace stays independent of the toolchain selection, and clearing it removes only it.
    expect(model.importEnvironment({ kind: 'toolchain', tool: 'mise' })).toBe(
      true,
    );
    expect(model.selectDevcontainer(null)).toBe(true);
    document = model.getSnapshot().draft;
    if (document.status !== 'valid')
      throw new Error('Expected usable document');
    expect(document.manifest.devcontainer).toBeUndefined();
    expect(document.manifest.environment).toEqual({
      kind: 'toolchain',
      tool: 'mise',
    });
    expect(document.bytes).toContain('"future": true');
  });

  it('does not reopen Alice’s private invalid draft under Bob, and keeps it for Alice', () => {
    const transport = boundary();
    const alice = createProjectManifestEditorModel({
      workspace,
      expectedAccountId: 'alice',
      definition: transport.read(),
      actions: transport.actions,
    });
    alice.setRaw('{"version":');
    const bob = createProjectManifestEditorModel({
      workspace,
      expectedAccountId: 'bob',
      definition: transport.read(),
      actions: transport.actions,
    });
    expect(bob.getSnapshot().draft.bytes).toBe(initialBytes);
    const returnedAlice = createProjectManifestEditorModel({
      workspace,
      expectedAccountId: 'alice',
      definition: transport.read(),
      actions: transport.actions,
    });
    expect(returnedAlice.getSnapshot()).toMatchObject({
      mode: 'raw',
      draft: { bytes: '{"version":' },
      dirty: true,
    });
  });
});
