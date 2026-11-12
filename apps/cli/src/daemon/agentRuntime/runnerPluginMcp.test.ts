import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readClaudeMcpConfigServers } from '../../../../../packages/plugins/claude/src/agent/mcp/configServers';
import { readOpenCodeMcpConfigServers } from '../../../../../packages/plugins/opencode/src/agent/mcp/discovery';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { TrackedSession } from '@/daemon/types';
import { createDaemonRunnerPluginMcp } from './runnerPluginMcp';
import { createRunnerPluginMcpPort } from '@/agent/runtime/session/process/runnerPluginMcp';

it.each(['claude', 'opencode'] as const)('never discovers daemon-home %s servers for a requester; owner discovery stays intact', async agentId => {
  const home = await mkdtemp(join(tmpdir(), 'member-mcp-discovery-'));
  await mkdir(join(home, '.config/opencode'), { recursive: true });
  await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: { ownerPrivate: { command: 'owner-command', args: ['owner-private-argument'] } } }));
  await writeFile(join(home, '.config/opencode/opencode.json'), JSON.stringify({ mcp: { ownerPrivate: { type: 'local', command: ['owner-command', 'owner-private-argument'] } } }));
  let nativeReads = 0;
  // Substitute the plugin invocation boundary; keep detection and both native readers real.
  const registry = { contributes: { mcpDiscoverySources: [{ pluginId: agentId, definition: {
    id: 'config', title: 'Native config', loadedInHappierSessions: true, metadata: { agentId },
  } }] }, projectMcpServerItems: async () => [], discoverMcpServersForDetection: async () => {
    nativeReads += 1;
    const result = agentId === 'claude' ? await readClaudeMcpConfigServers({ directory: null, env: { HOME: home } })
      : await readOpenCodeMcpConfigServers({ env: { HOME: home } });
    return { endpoints: [], detectedServers: result.servers, warnings: result.warnings };
  } } as unknown as ResolvedExecutablePluginRuntimeRegistry;
  const tracked: TrackedSession = { pid: 123, startedBy: 'daemon', happySessionId: 'session-1' };
  let allowNativeAccountState = false;
  const controller = new AbortController();
  const owner = createDaemonRunnerPluginMcp({ acquireRegistry: async () => ({ registry, release: async () => {} }),
    trackedSessions: new Map([[tracked.pid, tracked]]), spawnResourceCleanupByPid: new Map(), signal: controller.signal,
    readAllowNativeAccountState: async () => allowNativeAccountState });
  const context = { sessionId: 'session-1', agentId, trackedSession: tracked, isCurrent: async () => true };
  try {
    const preparationId = randomUUID();
    await owner.dispatch({ kind: 'mcp.plugin.prepare', preparationId, directory: home, catalog: { bindings: [] } }, context);
    const member = await owner.dispatch({ kind: 'mcp.plugin.discover', preparationId }, context);
    expect(member).toEqual({ kind: 'mcp.plugin.discovered', detectedServers: [], unavailableReason: 'requester_native_discovery_unavailable' });
    const runner = createRunnerPluginMcpPort({ sessionId: context.sessionId, signal: controller.signal,
      dispatch: async operation => ({ ok: true, result: await owner.dispatch(operation, context) }) });
    try {
      const preparation = await runner.port.prepare({ catalog: { v: 1, servers: [], bindings: [] }, directory: home });
      await expect(preparation.discoverNativeServers()).rejects.toMatchObject({ code: 'requester_native_discovery_unavailable' });
    } finally { await runner.dispose(); }
    expect(nativeReads).toBe(0);
    allowNativeAccountState = true;
    const ownerPreparationId = randomUUID();
    await owner.dispatch({ kind: 'mcp.plugin.prepare', preparationId: ownerPreparationId, directory: home, catalog: { bindings: [] } }, context);
    const ordinary = await owner.dispatch({ kind: 'mcp.plugin.discover', preparationId: ownerPreparationId }, context);
    expect(nativeReads).toBe(1);
    expect(ordinary).toMatchObject({ kind: 'mcp.plugin.discovered', detectedServers: [{ name: 'ownerPrivate', stdio: { args: ['owner-private-argument'] } }] });
  } finally { await owner.dispose(); controller.abort(); await rm(home, { recursive: true, force: true }); }
});
