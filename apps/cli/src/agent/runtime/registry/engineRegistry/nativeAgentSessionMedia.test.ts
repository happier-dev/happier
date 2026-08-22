import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPluginSessionMediaHostAdapter } from './nativeAgentSessionMedia';

const authorizeAnyCanonicalRoot = async () => true;

function createHarness() {
  let activeSessionId: string | null = 'session-1';
  const sendAgentSessionMediaCommitted = vi.fn(async () => undefined);
  const adapter = createPluginSessionMediaHostAdapter({
    agentId: 'cursor',
    readActiveScope: () => activeSessionId === null ? null : {
      sessionId: activeSessionId,
      rootPath: '/workspace',
      sendAgentSessionMediaCommitted,
    },
  });
  return { adapter, sendAgentSessionMediaCommitted, setActiveSessionId: (value: string | null) => { activeSessionId = value; } };
}

describe('createPluginSessionMediaHostAdapter', () => {
  it('registers an exact canonical absolute source root and publishes through the canonical transcript bridge', async () => {
    const harness = createHarness();
    const directory = await mkdtemp(join(tmpdir(), 'plugin-media-root-'));
    const sourceRoot = join(directory, 'assets');
    await mkdir(sourceRoot);
    await mkdir(join(sourceRoot, 'generated'), { recursive: true });
    await mkdir(join(sourceRoot, 'references'), { recursive: true });
    await writeFile(join(sourceRoot, 'generated/image.png'), 'generated');
    await writeFile(join(sourceRoot, 'references/input.png'), 'reference');
    await expect(harness.adapter.forAuthorizedSession('session-1', authorizeAnyCanonicalRoot).registerSourceRoot({ rootPath: 'relative/assets' }))
      .rejects.toThrow('media_source_root_invalid');
    const source = await harness.adapter.forAuthorizedSession('session-1', authorizeAnyCanonicalRoot).registerSourceRoot({
      rootPath: join(sourceRoot, '.'),
    });

    await expect(source.publishGenerated({
      localId: 'cursor-media-1',
      path: join(sourceRoot, 'generated/image.png'),
      referencePaths: [join(sourceRoot, 'references/input.png')],
      description: 'Generated image',
      toolCallId: ' exact-call\n',
    })).resolves.toEqual({ status: 'published' });

    expect(harness.sendAgentSessionMediaCommitted).toHaveBeenCalledTimes(1);
    expect(harness.sendAgentSessionMediaCommitted).toHaveBeenCalledWith('cursor', expect.objectContaining({
      localId: 'cursor-media-1',
      category: 'generated',
      media: [
        expect.objectContaining({
          source: expect.objectContaining({
            kind: 'local-file',
            path: await realpath(join(sourceRoot, 'generated/image.png')),
          }),
          sourceAccessPolicy: { kind: 'restrictedRoots', roots: [await realpath(sourceRoot)] },
          origin: expect.objectContaining({ toolCallId: ' exact-call\n' }),
        }),
        expect.objectContaining({
          source: expect.objectContaining({
            kind: 'local-file',
            path: await realpath(join(sourceRoot, 'references/input.png')),
          }),
          sourceAccessPolicy: { kind: 'restrictedRoots', roots: [await realpath(sourceRoot)] },
        }),
      ],
      meta: { description: 'Generated image', referenceCount: 1 },
    }));
  });

  it('rejects a session-bound service when another session is active', async () => {
    const harness = createHarness();
    const directory = await mkdtemp(join(tmpdir(), 'plugin-media-root-'));
    const sourceRoot = join(directory, 'assets');
    await mkdir(sourceRoot);
    harness.setActiveSessionId('session-2');
    await expect(harness.adapter.forAuthorizedSession('session-1', authorizeAnyCanonicalRoot).registerSourceRoot({ rootPath: sourceRoot }))
      .rejects.toThrow('media_session_scope_forbidden');
    expect(harness.sendAgentSessionMediaCommitted).not.toHaveBeenCalled();
  });

  it('revalidates the active session immediately before committing generated media', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'plugin-media-root-'));
    const sourceRoot = join(directory, 'assets');
    const mediaPath = join(sourceRoot, 'generated.png');
    await mkdir(sourceRoot);
    await writeFile(mediaPath, 'generated');
    const sendAgentSessionMediaCommitted = vi.fn(async () => undefined);
    let activeScopeReads = 0;
    const adapter = createPluginSessionMediaHostAdapter({
      agentId: 'cursor',
      readActiveScope: () => {
        activeScopeReads += 1;
        return {
          sessionId: activeScopeReads < 3 ? 'session-1' : 'session-2',
          rootPath: '/workspace',
          sendAgentSessionMediaCommitted,
        };
      },
    });
    const source = await adapter.forAuthorizedSession('session-1', authorizeAnyCanonicalRoot).registerSourceRoot({
      rootPath: sourceRoot,
    });

    await expect(source.publishGenerated({
      localId: 'native-media-1',
      path: mediaPath,
    })).rejects.toThrow('media_session_scope_forbidden');
    expect(sendAgentSessionMediaCommitted).not.toHaveBeenCalled();
  });

  it('publishes through a host-authorized canonical source root', async () => {
    const harness = createHarness();
    const directory = await mkdtemp(join(tmpdir(), 'plugin-media-root-'));
    const sourceRoot = join(directory, 'native-assets');
    await mkdir(sourceRoot);
    await writeFile(join(sourceRoot, 'generated.png'), 'generated');

    const source = await harness.adapter.forAuthorizedSession('session-1', authorizeAnyCanonicalRoot).registerSourceRoot({
      rootPath: sourceRoot,
    });
    await expect(source.publishGenerated({
      localId: 'native-media-1',
      path: join(sourceRoot, 'generated.png'),
    })).resolves.toEqual({ status: 'published' });
    expect(harness.sendAgentSessionMediaCommitted).toHaveBeenCalledTimes(1);
  });

  it('rejects missing roots and symlink roots so registration cannot widen file authority', async () => {
    const harness = createHarness();
    const directory = await mkdtemp(join(tmpdir(), 'plugin-media-root-'));
    const target = join(directory, 'target');
    const alias = join(directory, 'alias');
    await mkdir(target);
    await symlink(target, alias);
    await expect(harness.adapter.forAuthorizedSession('session-1', authorizeAnyCanonicalRoot).registerSourceRoot({ rootPath: join(directory, 'missing') }))
      .rejects.toThrow('media_source_root_invalid');
    await expect(harness.adapter.forAuthorizedSession('session-1', authorizeAnyCanonicalRoot).registerSourceRoot({ rootPath: alias }))
      .rejects.toThrow('media_source_root_invalid');
  });

  it('rejects missing, outside-root, and symlink media files before invoking the transcript bridge', async () => {
    const harness = createHarness();
    const directory = await mkdtemp(join(tmpdir(), 'plugin-media-root-'));
    const sourceRoot = join(directory, 'assets');
    const outsidePath = join(directory, 'outside.png');
    const aliasPath = join(sourceRoot, 'alias.png');
    await mkdir(sourceRoot);
    await writeFile(outsidePath, 'outside');
    await symlink(outsidePath, aliasPath);
    const source = await harness.adapter.forAuthorizedSession('session-1', authorizeAnyCanonicalRoot).registerSourceRoot({
      rootPath: sourceRoot,
    });

    await expect(source.publishGenerated({
      localId: 'missing',
      path: join(sourceRoot, 'missing.png'),
    })).rejects.toThrow('media_path_invalid');
    await expect(source.publishGenerated({
      localId: 'outside',
      path: outsidePath,
    })).rejects.toThrow('media_path_forbidden');
    await expect(source.publishGenerated({
      localId: 'symlink',
      path: aliasPath,
    })).rejects.toThrow('media_path_invalid');

    expect(harness.sendAgentSessionMediaCommitted).not.toHaveBeenCalled();
  });

  it('keeps source-root registration exclusive to a host-authorized session service', async () => {
    const harness = createHarness();
    const directory = await mkdtemp(join(tmpdir(), 'plugin-media-root-'));
    const sourceRoot = join(directory, 'assets');
    await mkdir(sourceRoot);

    await expect(harness.adapter.current.registerSourceRoot({ rootPath: sourceRoot }))
      .rejects.toThrow('media_source_root_forbidden');
    await expect(harness.adapter.forSession('session-1').registerSourceRoot({ rootPath: sourceRoot }))
      .rejects.toThrow('media_source_root_forbidden');
    await expect(harness.adapter.forAuthorizedSession('session-1', authorizeAnyCanonicalRoot).registerSourceRoot({ rootPath: sourceRoot }))
      .resolves.toMatchObject({ dispose: expect.any(Function) });
  });

  it('binds ordinary callers to a host-authorized canonical source root', async () => {
    const harness = createHarness();
    const directory = await mkdtemp(join(tmpdir(), 'plugin-media-root-'));
    const allowed = join(directory, 'allowed');
    const denied = join(directory, 'denied');
    await mkdir(allowed);
    await mkdir(denied);
    const authorizeSourceRoot = vi.fn(async (rootPath: string) => rootPath === await realpath(allowed));
    const service = harness.adapter.forAuthorizedSession('session-1', authorizeSourceRoot);

    await expect(service.registerSourceRoot({ rootPath: denied }))
      .rejects.toThrow('media_source_root_forbidden');
    await expect(service.registerSourceRoot({ rootPath: allowed }))
      .resolves.toMatchObject({ dispose: expect.any(Function) });
    expect(authorizeSourceRoot).toHaveBeenCalledWith(await realpath(denied));
    expect(authorizeSourceRoot).toHaveBeenCalledWith(await realpath(allowed));
  });

  it('does not admit source-root registration after caller cancellation', async () => {
    const harness = createHarness();
    const directory = await mkdtemp(join(tmpdir(), 'plugin-media-root-'));
    const sourceRoot = join(directory, 'allowed');
    await mkdir(sourceRoot);
    const authorizeSourceRoot = vi.fn(async () => true);
    const service = harness.adapter.forAuthorizedSession('session-1', authorizeSourceRoot);
    const controller = new AbortController();
    controller.abort(new Error('caller retired'));

    await expect(service.registerSourceRoot({ rootPath: sourceRoot }, { signal: controller.signal }))
      .rejects.toThrow('caller retired');
    expect(authorizeSourceRoot).not.toHaveBeenCalled();
  });

  it('revokes retained roots after scope switch, explicit disposal, and adapter disposal', async () => {
    const harness = createHarness();
    const directory = await mkdtemp(join(tmpdir(), 'plugin-media-root-'));
    const sourceRoot = join(directory, 'assets');
    await mkdir(sourceRoot);
    await writeFile(join(sourceRoot, 'one.png'), 'not used by adapter');
    const switched = await harness.adapter.forAuthorizedSession('session-1', authorizeAnyCanonicalRoot).registerSourceRoot({
      rootPath: sourceRoot,
    });
    harness.setActiveSessionId('session-2');
    await expect(switched.publishGenerated({ localId: 'one', path: '/workspace/one.png' }))
      .rejects.toThrow('media_session_scope_forbidden');
    harness.setActiveSessionId('session-1');

    const explicitlyDisposed = await harness.adapter.forAuthorizedSession('session-1', authorizeAnyCanonicalRoot).registerSourceRoot({
      rootPath: sourceRoot,
    });
    explicitlyDisposed.dispose();
    await expect(explicitlyDisposed.publishGenerated({ localId: 'two', path: '/workspace/two.png' }))
      .rejects.toThrow('media_source_root_revoked');

    const adapterDisposed = await harness.adapter.forAuthorizedSession('session-1', authorizeAnyCanonicalRoot).registerSourceRoot({
      rootPath: sourceRoot,
    });
    harness.adapter.dispose();
    await expect(adapterDisposed.publishGenerated({ localId: 'three', path: '/workspace/three.png' }))
      .rejects.toThrow('media_source_root_revoked');
  });

});
