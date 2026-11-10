import { expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import { openMuseMsp } from './msp.js';
import { readMuseRecord } from './events.js';
import { createMuseMspProcessFixture } from './testkit/mspProcess.js';

it('replays the granted native sessionMcp config and completed probe tool at the OS boundary', async () => {
  // The grant and tool completion are observed Muse 1.4.14 frames. This
  // harmless substituted command/environment is a schema-derived fixture.
  // This characterizes MSP; admitted Session delivery has separate owner tests.
  const servers = { probe: { transport: 'stdio', command: '/fixture/mcp-probe',
    args: ['--fixture'], env: { MUSE_FIXTURE_VALUE: 'PEBBLE' }, mode: 'optional' } };
  const { launch, ...boundary } = await createMuseMspProcessFixture({
    recordingPath: fileURLToPath(new URL('./testkit/fixtures/mcp.json', import.meta.url)),
    expectedMcpServers: servers,
  });
  let complete!: () => void;
  const completed = new Promise<void>(resolve => { complete = resolve; });
  const items: JsonValue[] = [];
  const msp = await openMuseMsp({ launch,
    exec: createStablePluginExecService({ ...boundary, signal: new AbortController().signal,
      isOccurrenceCurrent: () => true }),
    initialize: { capabilities: { experimentalApi: true, requestedCapabilities: ['sessionMcp'] } },
    onNotification(notification) {
      if (notification.method === 'item/completed') {
        const item = readMuseRecord(notification.params).item;
        if (item !== undefined) items.push(item);
      }
      if (notification.method === 'turn/completed') complete();
    },
  });
  try {
    expect(readMuseRecord(msp.initializeResult).grantedCapabilities).toContain('sessionMcp');
    const started = readMuseRecord(await msp.command('session/start', {
      workspaceRoot: process.cwd(), approvalMode: 'promptUnmatched',
      config: { mcpServers: servers },
    }));
    const sessionId = readMuseRecord(started.session).sessionId;
    if (typeof sessionId !== 'string') throw new Error('Native MCP fixture returned no Session');
    await msp.command('turn/start', { sessionId,
      input: [{ type: 'text', text: 'Call the captured MCP probe tool.' }] });
    await completed;
    expect(items).toContainEqual(expect.objectContaining({ kind: 'toolCall',
      tool: 'mcp__probe__pebble', status: 'completed', visibleOutput: 'PEBBLE' }));
    expect(await msp.client.request('fixture/inspect')).toMatchObject({ initializeCount: 1, initializedCount: 1,
      initializeParams: { capabilities: { experimentalApi: true, requestedCapabilities: ['sessionMcp'] } } });
  } finally { await msp.dispose(); }
});
