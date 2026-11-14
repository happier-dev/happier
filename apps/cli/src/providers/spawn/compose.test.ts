import { logger } from '@/ui/logger';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { rmSync, closeSync, writeFileSync } from 'node:fs';
import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';

// Removal is the OS boundary; composition and its validation remain real.
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, rmSync: vi.fn(actual.rmSync), closeSync: vi.fn(actual.closeSync), writeFileSync: vi.fn(actual.writeFileSync) };
});
import { FX_STATE_SHARING } from '../../../../../packages/plugins/fx/src/agent/auth/connectedAccount';
import { AGENT_STATE_SHARING_DESCRIPTOR as PI_STATE_SHARING } from '../../../../../packages/plugins/pi/src/agent/definition';
import { AGENT_STATE_SHARING_DESCRIPTOR as OH_MY_PI_STATE_SHARING } from '../../../../../packages/plugins/ohmypi/src/agent/definition';
import { AGENT_STATE_SHARING_DESCRIPTOR as CODEX_STATE_SHARING } from '../../../../../packages/plugins/codex/src/agent/definition';
import { AGENT_STATE_SHARING_DESCRIPTOR as CLAUDE_STATE_SHARING } from '../../../../../packages/plugins/claude/src/agent/definition';
import { geminiConnectedServiceStateSharingDescriptor as GEMINI_STATE_SHARING } from '../../../../../packages/plugins/gemini/src/agent/connectedServices/descriptor';

import {
  composeProviderBindingMaterialization,
  createProviderBindingLaunchMaterializationCleanup,
  resolveProviderMaterializationParentPath,
} from './compose';

describe('provider binding host materialization', () => {
  it('retains FX v2 journals across disposed Provider launches without retaining Provider configuration', async () => {
    const base = await mkdtemp(join(tmpdir(), 'happier-fx-provider-resume-'));
    const source = join(base, 'native');
    const materializationBaseDir = join(base, 'materialized');
    const compose = () => composeProviderBindingMaterialization({
      materialization: { v: 1, kind: 'configFile', nativeHome: true, env: [],
        files: [{ relativePath: '.fx/settings.json', utf8: '{"provider":"happier"}', merge: 'jsonObject' }] },
      nativeHome: { descriptor: { providerId: 'fx', ...FX_STATE_SHARING },
        sourceEnvironment: { HOME: source }, homeDir: source },
      sessionId: 'fx-provider-session', materializationBaseDir,
    });
    const results: Awaited<ReturnType<typeof compose>>[] = [];
    try {
      const initial = await compose(); results.push(initial);
      const home = initial.providerEnvironmentOverlay.find(entry => entry.name === 'HOME')?.value;
      if (!home || initial.launchMaterialization.kind !== 'configFile') throw new Error('Expected native Provider home');
      const journal = join(home, '.fx/sessions/v2/0ZXj6QS3ceqa');
      await mkdir(join(journal, 'blobs'), { recursive: true });
      await writeFile(join(journal, 'log.jsonl'), 'journal retained after upstream HTTP 400');
      await writeFile(join(journal, 'blobs/native-snapshot'), 'native blob');
      const released = initial.takeCleanupOwnership();
      // The child reconstructs cleanup from the handed-off launch descriptor.
      createProviderBindingLaunchMaterializationCleanup({ materialization: initial.launchMaterialization,
        materializationBaseDir })?.();
      released?.();
      expect(await readFile(join(journal, 'log.jsonl'), 'utf8')).toBe('journal retained after upstream HTTP 400');
      await expect(stat(join(home, '.fx/settings.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(initial.launchMaterialization.rootPath)).rejects.toMatchObject({ code: 'ENOENT' });
      const resumed = await compose(); results.push(resumed);
      expect(resumed.providerEnvironmentOverlay.find(entry => entry.name === 'HOME')?.value).toBe(home);
      expect(await readFile(join(journal, 'blobs/native-snapshot'), 'utf8')).toBe('native blob');
      expect(await realpath(join(home, '.fx/sessions'))).toBe(join(home, '.fx/sessions'));
      await expect(stat(join(source, '.fx/sessions/v2/0ZXj6QS3ceqa'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { for (const result of results) result.takeCleanupOwnership()?.(); await rm(base, { recursive: true, force: true }); }
  });
  it('keeps replacement FX configuration when the preceding Provider launch releases cleanup', async () => {
    const base = await mkdtemp(join(tmpdir(), 'happier-fx-provider-replacement-'));
    const compose = (model: string) => composeProviderBindingMaterialization({
      materialization: { v: 1, kind: 'configFile', nativeHome: true, env: [],
        files: [{ relativePath: '.fx/settings.json', utf8: JSON.stringify({ model }), merge: 'jsonObject' }] },
      nativeHome: { descriptor: { providerId: 'fx', ...FX_STATE_SHARING },
        sourceEnvironment: { HOME: join(base, 'native') }, homeDir: base },
      sessionId: 'fx-provider-session', materializationBaseDir: join(base, 'materialized'),
    });
    try {
      const sourceJournal = join(base, 'native/.fx/sessions/v2/native-session');
      await mkdir(sourceJournal, { recursive: true });
      await writeFile(join(sourceJournal, 'log.jsonl'), 'older native source journal');
      const old = await compose('first');
      const oldHome = old.providerEnvironmentOverlay.find(entry => entry.name === 'HOME')?.value;
      if (!oldHome) throw new Error('Expected native Provider home');
      await mkdir(join(oldHome, '.fx/sessions/v2/native-session/blobs'), { recursive: true });
      await writeFile(join(oldHome, '.fx/sessions/v2/native-session/log.jsonl'), 'first journal');
      await writeFile(join(oldHome, '.fx/provider-versions'), 'native provider metadata');
      const next = await compose('second');
      try {
        const home = next.providerEnvironmentOverlay.find(entry => entry.name === 'HOME')?.value;
        if (!home) throw new Error('Expected native Provider home');
        if (old.launchMaterialization.kind !== 'configFile') throw new Error('Expected Provider configuration');
        createProviderBindingLaunchMaterializationCleanup({ materialization: old.launchMaterialization,
          materializationBaseDir: join(base, 'materialized') })?.();
        old.takeCleanupOwnership()?.();
        expect(JSON.parse(await readFile(join(home, '.fx/settings.json'), 'utf8'))).toMatchObject({ model: 'second' });
        expect(await readFile(join(home, '.fx/sessions/v2/native-session/log.jsonl'), 'utf8')).toBe('first journal');
        expect(await readFile(join(home, '.fx/provider-versions'), 'utf8')).toBe('native provider metadata');
        expect(await readFile(join(sourceJournal, 'log.jsonl'), 'utf8')).toBe('older native source journal');
      } finally { next.takeCleanupOwnership()?.(); }
    } finally { await rm(base, { recursive: true, force: true }); }
  });

  it('removes obsolete Provider credential files when the same Session replaces its config paths', async () => {
    const base = await mkdtemp(join(tmpdir(), 'happier-provider-config-paths-'));
    const materializationBaseDir = join(base, 'materialized');
    const compose = (relativePath: string) => composeProviderBindingMaterialization({
      materialization: { v: 1, kind: 'configFile', nativeHome: true, env: [],
        files: [{ relativePath, utf8: 'private Provider credential fixture' }] },
      nativeHome: { descriptor: { providerId: 'fx', ...FX_STATE_SHARING },
        sourceEnvironment: { HOME: join(base, 'native') }, homeDir: base },
      sessionId: 'same-session', materializationBaseDir,
    });
    try {
      const old = await compose('previous-provider.json');
      const home = old.providerEnvironmentOverlay.find(entry => entry.name === 'HOME')?.value;
      if (!home) throw new Error('Expected native Provider home');
      const next = await compose('replacement-provider.json');
      try {
        await expect(stat(join(home, 'previous-provider.json'))).rejects.toMatchObject({ code: 'ENOENT' });
        old.takeCleanupOwnership()?.();
        expect(await readFile(join(home, 'replacement-provider.json'), 'utf8')).toBe('private Provider credential fixture');
      } finally { next.takeCleanupOwnership()?.(); }
      await expect(stat(join(home, 'replacement-provider.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(base, { recursive: true, force: true }); }
  });

  it.each([
    { agentId: 'pi', descriptor: PI_STATE_SHARING, entryPath: 'sessions' },
    { agentId: 'ohMyPi', descriptor: OH_MY_PI_STATE_SHARING, entryPath: 'sessions' },
    { agentId: 'codex', descriptor: CODEX_STATE_SHARING, entryPath: 'sessions' },
    { agentId: 'codex', descriptor: CODEX_STATE_SHARING, entryPath: 'archived_sessions' },
    { agentId: 'claude', descriptor: CLAUDE_STATE_SHARING, entryPath: 'projects' },
    { agentId: 'gemini', descriptor: GEMINI_STATE_SHARING, entryPath: '.gemini/tmp' },
    { agentId: 'fx', descriptor: FX_STATE_SHARING, entryPath: '.fx/session-files' },
  ])('retains the first $agentId $entryPath session files after disposing its launch home', async ({ agentId, descriptor, entryPath }) => {
    const base = await mkdtemp(join(tmpdir(), 'happier-agent-cold-home-'));
    const source = join(base, 'native');
    const compose = () => composeProviderBindingMaterialization({
      materialization: { v: 1, kind: 'configFile', nativeHome: true, env: [],
        files: [{ relativePath: 'models.json', utf8: '{}' }] },
      nativeHome: { descriptor: { providerId: agentId, ...descriptor },
        sourceEnvironment: { [descriptor.nativeHome.environmentKey]: source }, homeDir: base },
      materializationBaseDir: join(base, 'materialized'),
    });
    try {
      const initial = await compose();
      if (initial.launchMaterialization.kind !== 'configFile') throw new Error('Expected native home');
      const sessions = join(initial.launchMaterialization.rootPath, entryPath);
      // The real child creates its workspace session directory on its first turn.
      await mkdir(join(sessions, 'workspace'), { recursive: true });
      await writeFile(join(sessions, 'workspace', 'native-id.jsonl'), 'native-session');
      initial.cleanup?.();
      const resumed = await compose();
      try {
        if (resumed.launchMaterialization.kind !== 'configFile') throw new Error('Expected native home');
        expect(await readFile(join(resumed.launchMaterialization.rootPath,
          entryPath, 'workspace/native-id.jsonl'), 'utf8')).toBe('native-session');
        expect(await realpath(join(resumed.launchMaterialization.rootPath, entryPath)))
          .toBe(await realpath(join(source, entryPath)));
      } finally { resumed.cleanup?.(); }
    } finally { await rm(base, { recursive: true, force: true }); }
  });
  it('projects the declared native home, preserves native preferences and shared Sessions, and retains cleanup ownership', async () => {
    const base = await mkdtemp(join(tmpdir(), 'happier-provider-native-home-'));
    const source = join(base, 'native');
    await mkdir(join(source, '.fx/sessions/existing'), { recursive: true });
    await writeFile(join(source, '.fx/sessions/existing/events.jsonl'), 'native-event');
    await writeFile(join(source, '.fx/mcp.json'), '{"servers":{}}');
    await writeFile(join(source, '.fx/settings.json'), '{"theme":"dark","models":{"gateway":"old"}}');
    const result = await composeProviderBindingMaterialization({
      materialization: {
        v: 1, kind: 'configFile', nativeHome: true, env: [],
        files: [{ relativePath: '.fx/settings.json', utf8: '{"models":{"happier":"selected"}}', merge: 'jsonObject' }],
      },
      nativeHome: { descriptor: { providerId: 'fx', ...FX_STATE_SHARING }, sourceEnvironment: { HOME: source }, homeDir: source },
      materializationBaseDir: join(base, 'materialized'),
    });
    if (result.launchMaterialization.kind !== 'configFile') throw new Error('Expected file materialization');
    const root = result.launchMaterialization.rootPath;
    expect(result.providerEnvironmentOverlay).toContainEqual({ name: 'HOME', value: root, source: 'provider' });
    expect(JSON.parse(await readFile(join(root, '.fx/settings.json'), 'utf8'))).toEqual({ theme: 'dark', models: { happier: 'selected' } });
    expect(await readFile(join(root, '.fx/mcp.json'), 'utf8')).toBe('{"servers":{}}');
    // FX requires a real Sessions directory; canonical materialization copies its retained history.
    expect(await realpath(join(root, '.fx/sessions'))).not.toBe(await realpath(join(source, '.fx/sessions')));
    const retainedCleanup = result.takeCleanupOwnership();
    result.cleanup?.();
    expect(await readFile(join(root, '.fx/sessions/existing/events.jsonl'), 'utf8')).toBe('native-event');
    retainedCleanup?.();
    expect(await readFile(join(source, '.fx/settings.json'), 'utf8')).toBe('{"theme":"dark","models":{"gateway":"old"}}');
    expect(await readFile(join(source, '.fx/sessions/existing/events.jsonl'), 'utf8')).toBe('native-event');
    await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('resolves Windows config-file parents with the platform path implementation', () => {
    expect(resolveProviderMaterializationParentPath(
      String.raw`C:\Users\alice\.happier\provider-binding\config\provider.json`,
      { dirname: win32.dirname },
    )).toBe(String.raw`C:\Users\alice\.happier\provider-binding\config`);
  });

  it('keeps engine config transient while returning the provider env overlay', async () => {
    const result = await composeProviderBindingMaterialization({
      materialization: {
        v: 1,
        kind: 'engineConfig',
        env: [{ name: 'PROVIDER_KEY', value: 'secret', source: 'provider' }],
        engineConfig: { model_provider: 'gateway' },
      },
      materializationBaseDir: '/unused',
      sessionId: 'session-a',
    });

    expect(result).toMatchObject({
      providerEnvironmentOverlay: [{ name: 'PROVIDER_KEY', value: 'secret', source: 'provider' }],
      launchMaterialization: {
        v: 1,
        kind: 'engineConfig',
        engineConfig: { model_provider: 'gateway' },
      },
    });
    expect(result.cleanup).toBeNull();
  });

  it('writes config files below a host-owned private root and cleans exactly that root', async () => {
    const base = await mkdtemp(join(tmpdir(), 'happier-provider-compose-'));
    const result = await composeProviderBindingMaterialization({
      materialization: {
        v: 1,
        kind: 'configFile',
        env: [{ name: 'PROVIDER_KEY', value: null, source: 'provider' }],
        files: [{ relativePath: 'config/provider.json', utf8: '{"key":"env:PROVIDER_KEY"}' }],
      },
      materializationBaseDir: base,
      sessionId: 'session-a',
    });
    if (result.launchMaterialization.kind !== 'configFile') throw new Error('Expected file materialization');

    expect(await readFile(join(result.launchMaterialization.rootPath, 'config/provider.json'), 'utf8'))
      .toBe('{"key":"env:PROVIDER_KEY"}');
    if (process.platform !== 'win32') {
      expect((await stat(result.launchMaterialization.rootPath)).mode & 0o777).toBe(0o700);
      expect((await stat(join(result.launchMaterialization.rootPath, 'config/provider.json'))).mode & 0o777).toBe(0o600);
    }

    await result.cleanup?.();
    await result.cleanup?.();
    await expect(stat(result.launchMaterialization.rootPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('transfers config-file cleanup to the retained Session owner without generation cleanup deleting it', async () => {
    const base = await mkdtemp(join(tmpdir(), 'happier-provider-compose-transfer-'));
    const result = await composeProviderBindingMaterialization({
      materialization: {
        v: 1,
        kind: 'configFile',
        env: [],
        files: [{ relativePath: 'config/provider.json', utf8: '{}' }],
      },
      materializationBaseDir: base,
      sessionId: 'session-retained',
    });
    if (result.launchMaterialization.kind !== 'configFile') throw new Error('Expected file materialization');

    const retainedCleanup = result.takeCleanupOwnership();
    result.cleanup?.();
    expect(await readFile(join(result.launchMaterialization.rootPath, 'config/provider.json'), 'utf8'))
      .toBe('{}');

    retainedCleanup?.();
    retainedCleanup?.();
    await expect(stat(result.launchMaterialization.rootPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a retained cleanup descriptor outside the canonical materialization root', () => {
    expect(createProviderBindingLaunchMaterializationCleanup({
      materializationBaseDir: '/private/providers/materialized',
      materialization: {
        v: 1,
        kind: 'configFile',
        rootPath: '/private/providers/materialized-sibling/provider-binding-escape',
        relativePaths: ['provider.json'],
      },
    })).toBeNull();
  });
});


it.each(['launch metadata', 'file write', 'logging failure'] as const)('retains the primary %s failure when private-root cleanup also fails', async phase => {
  const base = await mkdtemp(join(tmpdir(), 'happier-provider-double-fault-'));
  const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
  const cleanupError = Object.assign(new Error('private cleanup fixture'), { code: 'EBUSY' });
  const diagnostic = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {
    if (phase === 'logging failure') throw new Error('private log sink failure');
  });
  vi.mocked(rmSync).mockImplementation((path, options) => {
    if (options?.recursive) throw cleanupError;
    return actualFs.rmSync(path, options);
  });
  try {
    const failure = await composeProviderBindingMaterialization({
      materialization: { v: 1, kind: 'configFile', env: [], files: phase !== 'launch metadata'
        ? [{ relativePath: 'conflict', utf8: '{}' }, { relativePath: 'conflict/nested.json', utf8: '{}' }]
        : [{ relativePath: 'config.json', utf8: '{}' }] },
      // The filesystem accepts a control character; the real launch schema rejects it.
      materializationBaseDir: phase === 'launch metadata' ? `${base}/unsafe\nmaterialized` : join(base, 'materialized'),
    }).then(() => undefined, (error: unknown) => error);
    if (phase !== 'launch metadata') expect(failure).toMatchObject({ code: 'EEXIST' });
    else expect(failure).toMatchObject({ issues: expect.arrayContaining([expect.objectContaining({ path: ['rootPath'] })]) });
    expect(diagnostic).toHaveBeenCalledWith('[PROVIDER] Unexpected failure', expect.objectContaining({
      operation: 'launch', failureCause: expect.objectContaining({ errorClass: 'Error', errorCode: 'EBUSY' }),
    }));
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private cleanup fixture');
  } finally {
    vi.mocked(rmSync).mockImplementation(actualFs.rmSync);
    diagnostic.mockRestore();
    await rm(base, { recursive: true, force: true });
  }
});


it('retains the primary file write failure when descriptor close also fails', async () => {
  const base = await mkdtemp(join(tmpdir(), 'happier-provider-write-close-'));
  const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
  const writeError = Object.assign(new Error('private file write fixture'), { code: 'ENOSPC' });
  const closeError = Object.assign(new Error('private descriptor close fixture'), { code: 'EBUSY' });
  const diagnostic = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
  vi.mocked(writeFileSync).mockImplementation(() => { throw writeError; });
  vi.mocked(closeSync).mockImplementation(fd => { actualFs.closeSync(fd); throw closeError; });
  try {
    const failure = await composeProviderBindingMaterialization({
      materialization: { v: 1, kind: 'configFile', env: [], files: [{ relativePath: 'config.json', utf8: '{}' }] },
      materializationBaseDir: base,
    }).then(() => undefined, (error: unknown) => error);
    expect(failure).toBe(writeError);
    expect(projectActionFailureCauseV1(failure)).toMatchObject({ errorClass: 'Error', errorCode: 'ENOSPC' });
    expect(diagnostic).toHaveBeenCalledWith('[PROVIDER] Unexpected failure', expect.objectContaining({
      failureCause: expect.objectContaining({ errorClass: 'Error', errorCode: 'EBUSY' }),
    }));
  } finally {
    vi.mocked(writeFileSync).mockImplementation(actualFs.writeFileSync);
    vi.mocked(closeSync).mockImplementation(actualFs.closeSync);
    diagnostic.mockRestore();
    await rm(base, { recursive: true, force: true });
  }
});
