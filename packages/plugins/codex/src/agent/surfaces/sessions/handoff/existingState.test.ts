import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { AgentRuntimeHandoffSurface } from '@happier-dev/plugin-sdk/agents/runtime';

import { buildCodexAgentRuntimeDescriptor } from '../../../../protocol/runtimeDescriptorV1.js';
import { codexHandoffSurface } from './providerOps.js';

const temporaryRoots: string[] = [];

function context(signal = new AbortController().signal): PluginInvocationContext {
  return { signal } as PluginInvocationContext;
}

async function fixture(sessionId = '  vendor/thread\nAB+cd==  ') {
  const root = await mkdtemp(join(tmpdir(), 'happier-codex-existing-handoff-'));
  temporaryRoots.push(root);
  const codexHome = join(root, 'codex-home');
  const sqliteHome = join(root, 'native-state');
  await mkdir(codexHome);
  await mkdir(sqliteHome);
  const rolloutPath = join(codexHome, 'rollout.jsonl');
  await writeFile(rolloutPath, `${JSON.stringify({ type: 'session_meta', payload: { id: sessionId } })}\n`);
  const databasePath = join(sqliteHome, 'state_5.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)');
  database.prepare('INSERT INTO threads (id, rollout_path) VALUES (?, ?)').run(sessionId, rolloutPath);
  database.close();
  const metadata = {
    runtimeDescriptorV1: buildCodexAgentRuntimeDescriptor({
      backendMode: 'acp',
      providerSessionId: 'stale-source-id',
      home: 'connectedService',
      connectedServiceId: 'service-1',
      connectedServiceProfileId: 'profile-1',
      connectedServiceGroupId: 'group-1',
      homePath: '/source-only/codex-home',
    }),
  };
  const params = {
    sessionId,
    metadata,
    targetDirectory: root,
    environmentVariables: { CODEX_HOME: codexHome, CODEX_SQLITE_HOME: sqliteHome },
  };
  return { root, codexHome, sqliteHome, rolloutPath, databasePath, params };
}

async function resolveExisting(
  params: Parameters<NonNullable<AgentRuntimeHandoffSurface['resolveExistingState']>>[0],
  invocation = context(),
) {
  const surface: AgentRuntimeHandoffSurface = codexHandoffSurface;
  if (!surface.resolveExistingState) throw new Error('Codex existing-state handoff operation is missing');
  return await surface.resolveExistingState(params, invocation);
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('Codex existing-state handoff', () => {
  it('resumes the exact native indexed identity using target paths and retained Agent affinity without writes', async () => {
    const f = await fixture();
    const before = await Promise.all([readFile(f.databasePath), readFile(f.rolloutPath), readdir(f.sqliteHome)]);

    const result = await resolveExisting(f.params);
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);

    expect(result).toMatchObject({
      ok: true,
      value: {
        providerSessionId: f.params.sessionId,
        source: {
          kind: 'codexHome', home: 'connectedService',
          connectedServiceId: 'service-1', connectedServiceProfileId: 'profile-1', connectedServiceGroupId: 'group-1',
        },
        launch: {
          directory: f.root,
          environmentVariables: { CODEX_HOME: f.codexHome, CODEX_SQLITE_HOME: f.sqliteHome },
          sessionStateUpdates: expect.arrayContaining([
            { fieldId: 'identity.providerSessionId', value: f.params.sessionId },
            {
              fieldId: 'identity.runtimeDescriptor',
              value: expect.objectContaining({
                agentId: 'codex',
                agent: expect.objectContaining({ backendMode: 'acp', providerSessionId: f.params.sessionId, homePath: f.codexHome }),
              }),
            },
          ]),
        },
      },
    });
    expect(result.value.source).not.toHaveProperty('homePath');
    expect(await Promise.all([readFile(f.databasePath), readFile(f.rolloutPath), readdir(f.sqliteHome)])).toEqual(before);
  });

  it.each(['database', 'table', 'row', 'rollout'] as const)('reports missing %s as unavailable without creating or repairing state', async (missing) => {
    const f = await fixture();
    if (missing === 'database') await rm(f.databasePath);
    else if (missing === 'rollout') await rm(f.rolloutPath);
    else {
      const database = new DatabaseSync(f.databasePath);
      database.exec(missing === 'table' ? 'DROP TABLE threads' : 'DELETE FROM threads');
      database.close();
    }
    const existingDb = missing === 'database' ? null : await readFile(f.databasePath);
    const files = await readdir(f.sqliteHome);

    expect(await resolveExisting(f.params)).toMatchObject({ ok: false, code: 'existing_session_state_unavailable' });

    expect(await readdir(f.sqliteHome)).toEqual(files);
    if (existingDb) expect(await readFile(f.databasePath)).toEqual(existingDb);
    else await expect(access(f.databasePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses linked source affinity and the configured home when SQLite home is omitted', async () => {
    vi.stubEnv('CODEX_SQLITE_HOME', '');
    const f = await fixture();
    await rename(f.databasePath, join(f.codexHome, 'state_5.sqlite'));
    expect(await resolveExisting({
      ...f.params,
      metadata: { ...f.params.metadata, externalSessionSource: { kind: 'codexHome', home: 'user', homePath: '/source-only/home' } },
      environmentVariables: { CODEX_HOME: f.codexHome },
    })).toMatchObject({
      ok: true,
      value: {
        source: { kind: 'codexHome', home: 'user', homePath: f.codexHome },
        launch: { environmentVariables: { CODEX_HOME: f.codexHome, CODEX_SQLITE_HOME: f.codexHome } },
      },
    });
  });

  it('does not resurrect daemon native homes omitted from a supplied target child environment', async () => {
    const f = await fixture();
    const childHome = join(f.root, 'child-home');
    await mkdir(childHome);
    vi.stubEnv('CODEX_HOME', f.codexHome);
    vi.stubEnv('CODEX_SQLITE_HOME', f.sqliteHome);
    const before = await Promise.all([readFile(f.databasePath), readFile(f.rolloutPath)]);

    expect(await resolveExisting({ ...f.params, environmentVariables: undefined })).toMatchObject({ ok: true });
    expect(await resolveExisting({
      ...f.params,
      environmentVariables: { HOME: childHome, USERPROFILE: childHome },
    })).toMatchObject({ ok: false, code: 'existing_session_state_unavailable' });

    expect(await Promise.all([readFile(f.databasePath), readFile(f.rolloutPath)])).toEqual(before);
    expect(await readdir(childHome)).toEqual([]);
  });

  it('does not repair a stale row from a matching rollout found elsewhere or accept a trimmed native id', async () => {
    const f = await fixture('  provider ses AB+cd==  ');
    const rolloutDirectory = join(f.codexHome, 'sessions', '2026', '10', '10');
    const discoverableRollout = join(rolloutDirectory, `rollout-2026-10-10T12-00-00-${f.params.sessionId}.jsonl`);
    await mkdir(rolloutDirectory, { recursive: true });
    await rename(f.rolloutPath, discoverableRollout);
    const database = new DatabaseSync(f.databasePath);
    database.prepare('UPDATE threads SET rollout_path = ? WHERE id = ?').run(join(f.codexHome, 'missing.jsonl'), f.params.sessionId);
    database.prepare('INSERT INTO threads (id, rollout_path) VALUES (?, ?)').run(f.params.sessionId.trim(), discoverableRollout);
    database.close();
    const before = await readFile(f.databasePath);

    expect(await resolveExisting(f.params)).toMatchObject({ ok: false, code: 'existing_session_state_unavailable' });

    expect(await readFile(f.databasePath)).toEqual(before);
    expect(await readFile(discoverableRollout, 'utf8')).toContain(f.params.sessionId);
  });

  it('distinguishes a corrupt index from absence', async () => {
    const f = await fixture();
    await writeFile(f.databasePath, 'not a sqlite database');
    expect(await resolveExisting(f.params)).toMatchObject({ ok: false, code: 'target_import_failed' });
    expect(await readFile(f.databasePath, 'utf8')).toBe('not a sqlite database');
  });

  it('rejects missing or unsupported runtime modes instead of choosing a default', async () => {
    const f = await fixture();
    for (const metadata of [{}, { runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: { backendMode: 'unsupported' } } }]) {
      expect(await resolveExisting({ ...f.params, metadata })).toMatchObject({ ok: false, code: 'bundle_invalid' });
    }
  });

  it('refuses cancelled and retired invocations, including retirement during native inspection', async () => {
    const f = await fixture();
    const alreadyCancelled = new AbortController();
    alreadyCancelled.abort(new Error('invocation retired'));
    expect(await resolveExisting(f.params, context(alreadyCancelled.signal))).toMatchObject({ ok: false, code: 'target_import_failed' });

    const retiring = new AbortController();
    const result = resolveExisting(f.params, context(retiring.signal));
    queueMicrotask(() => retiring.abort(new Error('invocation retired during inspection')));
    expect(await result).toMatchObject({ ok: false, code: 'target_import_failed' });
  });
});
