import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { createPluginSessionMediaHostAdapter } from './nativeAgentSessionMedia';
import { persistSessionMediaForTranscript, type SessionMediaBridgePersistResult } from '@/api/session/client/transcript/sessionMediaBridge';
import { createEventsFixture, createPluginContextFixture, createSdkExecFixture, createTerminalHostFixture, expectRuntimeEnvelope } from '../../../../../../../packages/plugins/claude/src/agent/runtime/engine.testkit.js';
import { createClaudeNativeAgentSdkContext } from '../../../../../../../packages/plugins/claude/src/agent/runtime/nativeServices.js';
import { bindClaudeAgentSdkFallbackSession } from '../../../../../../../packages/plugins/claude/src/agent/runtime/remote/sdk/session.testkit.js';

describe('Claude SDK tool-result media host composition', () => {
  it('persists a mixed Read image through the native host capability while semantic events remain byte-free', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'claude-sdk-tool-media-'));
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lU6w9wAAAABJRU5ErkJggg==', 'base64');
    const published: SessionMediaBridgePersistResult[] = [];
    await mkdir(join(directory, '.git/info'), { recursive: true });
    const adapter = createPluginSessionMediaHostAdapter({ agentId: 'claude', readActiveScope: () => ({
      sessionId: 'sdk-media-session', rootPath: directory,
      // Exercise the real host extraction/storage bridge. Durable transport is covered by
      // sessionClient.transcriptVNext.runtimeCatalog.integration.test.ts.
      async sendAgentSessionMediaCommitted(_agentId, request) {
        published.push(await persistSessionMediaForTranscript({ sessionId: 'sdk-media-session', workingDirectory: directory, request }));
      },
    }) });
    const exec = createSdkExecFixture(); // Genuine external SDK process boundary.
    const base = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service, { exec: exec.service });
    // Partial host-context fixture; only the production media adapter is consumed here.
    const native = createClaudeNativeAgentSdkContext({ services: { logger: base.logger, exec: {}, sessions: { current: { media: adapter.forSession('sdk-media-session') } } }, session: { services: {} } } as unknown as AgentSessionRuntimeContext);
    const ctx = { ...base, sessions: { ...base.sessions, current: { ...base.sessions.current, media: native.sessions.current.media } } };
    const runtime = expectRuntimeEnvelope(await bindClaudeAgentSdkFallbackSession({ ctx, sessionParams: { cwd: directory, sessionId: 'sdk-media-session', permissionMode: 'default' } })).operations;
    const events: unknown[] = [];
    runtime.subscribeRuntimeEvents(event => { events.push(event); });
    try {
      runtime.beginTurnLifecycle();
      await runtime.sendTurnPrompt('Read image.png');
      await exec.emit({ type: 'user', uuid: 'native-image-read', toolUseResult: { type: 'image', file: { base64: bytes.toString('base64') } }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-image', content: [
        { type: 'text', text: 'Image read' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: bytes.toString('base64') } },
      ] }] } });
      await exec.emit({ type: 'user', uuid: 'invalid-image-read', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'bad-image', content: [{ type: 'text', text: 'Image unavailable' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '%' } }] }] } });
      await exec.emit({ type: 'result', subtype: 'success', uuid: 'done', session_id: 'native-session', is_error: false, result: 'done', num_turns: 1, total_cost_usd: 0, duration_ms: 1, duration_api_ms: 1, usage: {} });
      await runtime.waitForTurnCompletion();
      expect(published).toHaveLength(1);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'tool-result', toolCallId: 'read-image', output: expect.objectContaining({
          content: [{ type: 'text', text: 'Image read' }, { type: 'image' }],
        }) }),
        expect.objectContaining({ kind: 'tool-result', toolCallId: 'bad-image', output: [
          { type: 'text', text: 'Image unavailable' }, { type: 'image' },
        ] }),
      ]));
      const item = published[0]?.items[0];
      expect(item).toMatchObject({ category: 'tool-artifact', origin: { agentId: 'claude', toolCallId: 'read-image' } });
      if (!item) throw new Error('Missing persisted Read image');
      await expect(readFile(join(directory, item.path))).resolves.toEqual(bytes);
      expect(JSON.stringify(events)).not.toContain(bytes.toString('base64'));
      expect(JSON.stringify(published[0]?.meta)).not.toContain(bytes.toString('base64'));
    } finally {
      await runtime.resetOrDisposeRuntime();
      adapter.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
