import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';

import { describe, expect, it } from 'vitest';
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
