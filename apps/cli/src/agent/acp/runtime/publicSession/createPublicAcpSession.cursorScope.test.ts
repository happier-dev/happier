import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { AgentSessionOpenRequest, AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';

import { openCursorAcpSession } from '../../../../../../../packages/plugins/cursor/src/agent/acp/connection';
import { resolveCursorGeneratedMediaRoot } from '../../../../../../../packages/plugins/cursor/src/agent/acp/mediaRoot';
import { createNativeAgentSessionWorkStateService } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionWorkState';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createPluginSessionMediaHostAdapter } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionMedia';
import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createPublicAcpSession, type PublicAcpComposerDependencies } from './createPublicAcpSession';

it('publishes Cursor native generated media from each admitted Session home', async () => {
  await Promise.all(['session-a', 'session-b'].map(sessionId => withTempDir('happier-cursor-scoped-media-', async dir => {
    const home = await realpath(dir);
    const cwd = home;
    const mediaRoot = resolveCursorGeneratedMediaRoot({ directory: cwd, env: { HOME: home, USERPROFILE: home } });
    if (!mediaRoot) throw new Error('Missing expected Cursor media root');
    const mediaPath = join(mediaRoot, 'generated.png');
    await mkdir(mediaRoot, { recursive: true });
    await writeFile(mediaPath, 'generated');
    const script = writeAcpTestAgentScript({ dir, fileName: 'cursor.mjs', source: `
      import { createInterface } from 'node:readline';
      for await (const line of createInterface({ input: process.stdin })) {
        const request = JSON.parse(line);
        if (request.id === undefined) continue;
        const result = request.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: {}, authMethods: [{ id: 'cursor_login', name: 'Cursor login' }] }
          : request.method === 'session/new' ? { sessionId: 'cursor-native' } : {};
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
        if (request.method === 'session/new') process.stdout.write(JSON.stringify({ jsonrpc: '2.0',
          method: 'cursor/generate_image', params: { toolCallId: 'image', filePath: process.env.GENERATED_PATH } }) + '\\n');
      }
    ` });
    const signal = new AbortController().signal;
    // Transcript persistence/transport is the external publication boundary.
    const publish = vi.fn(async () => undefined);
    const media = createPluginSessionMediaHostAdapter({ agentId: 'cursor', readActiveScope: () => ({
      sessionId, rootPath: home, sendAgentSessionMediaCommitted: publish,
    }) });
    const mediaService = media.forAuthorizedSession(sessionId, canonicalRoot => canonicalRoot === mediaRoot);
    const dependencies: PublicAcpComposerDependencies = {
      pluginId: 'happier.cursor', agentId: 'cursor', signal, isCurrent: () => true,
      exec: createStablePluginExecService({ signal, isOccurrenceCurrent: () => true,
        resolveExecutable: async () => { throw new Error('Use the resolved native executable'); },
        resolvePath: async () => home,
      }),
      // Native executable resolution is the OS boundary; the real ACP process runs below it.
      systemTools: { resolve: async request => ({ toolId: request.toolId, launch: {
        kind: 'binary', executablePath: process.execPath, args: [script], env: { GENERATED_PATH: mediaPath },
      } }) },
      interactions: { async request() { throw new Error('Unexpected interaction'); } },
      media: mediaService,
      models: { bind: () => ({ dispose() {} }) }, modes: { bind: () => ({ dispose() {} }) },
    };
    const session = createMutableApiSessionClientFixture({ sessionId });
    const context = {
      workState: createNativeAgentSessionWorkStateService({ session, pluginId: 'happier.cursor',
        contributionId: 'cursor', agentId: 'cursor', occurrenceId: sessionId, declarations: [], isCurrent: () => true }),
      protocols: { acp: { open: (request: AgentSessionOpenRequest, options: Parameters<typeof createPublicAcpSession>[1]) =>
        createPublicAcpSession(request, options, dependencies) } },
      services: {
        // Saved daemon settings are the persistence boundary; absent values select Cursor's defaults.
        settings: { forScope: () => ({ get: async () => null }) },
        sessions: { current: { media: mediaService } },
        logger: { debug() {} },
      },
    } as unknown as AgentSessionRuntimeContext;
    const runtime = await openCursorAcpSession({ kind: 'create', sessionId, cwd,
      launchEnvironment: { values: { HOME: home, USERPROFILE: home }, unset: [] } }, context);
    try {
      await vi.waitFor(() => expect(publish).toHaveBeenCalledWith('cursor', expect.objectContaining({
        localId: 'image', category: 'generated', media: [expect.objectContaining({
          source: expect.objectContaining({ kind: 'local-file', path: mediaPath }),
          sourceAccessPolicy: { kind: 'restrictedRoots', roots: [mediaRoot] },
        })],
      })));
    } finally { await runtime.dispose(); media.dispose(); await session.close(); }
  })));
});
