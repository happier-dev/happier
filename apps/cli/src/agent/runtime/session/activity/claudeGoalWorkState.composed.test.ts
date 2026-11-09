import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';
import { PluginAgentSessionCapabilitiesV2Schema, readSessionWorkStateV1FromMetadata } from '@happier-dev/protocol';

import { createPluginTranscriptFileFollowService } from '@/plugins/runtime/context/transcripts/fileFollow';
import { createTranscriptFileFollowPathGrantRegistry } from '@/plugins/runtime/context/transcripts/fileFollowGrants';
import { createSessionHooksService } from '@/plugins/runtime/hooks/session/service';
import { createNativeAgentSessionWorkStateService } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionWorkState';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { CLAUDE_PLUGIN } from '../../../../../../../packages/plugins/claude/src/manifest';
import { createClaudeNativeAgentSdkContext, createClaudeNativeGoalWorkStatePublisher } from '../../../../../../../packages/plugins/claude/src/agent/runtime/nativeServices';
import { createClaudeAgentSdkTurnOperations } from '../../../../../../../packages/plugins/claude/src/agent/runtime/remote/sdk/session';
import {
  createEventsFixture, createPluginContextFixture, createSdkExecFixture, createSessionHooksFixture,
  createTerminalHostFixture,
} from '../../../../../../../packages/plugins/claude/src/agent/runtime/engine.testkit';

it.each(['control', 'typed'] as const)('publishes native Claude Goal evidence when SDK initialization cannot deliver SessionStart (%s)', async ingress => {
  const directory = await mkdtemp(join(tmpdir(), 'claude-goal-host-'));
  const sessionId = 'happier-goal-session', providerSessionId = 'native-goal-session';
  const transcriptPath = join(directory, `${providerSessionId}.jsonl`);
  const grants = createTranscriptFileFollowPathGrantRegistry();
  const hooksOwner = createSessionHooksService({ happyHomeDir: directory,
    hasCapability: capability => capability === 'sessionHooks',
    grantTranscriptFileFollowPath: async request => {
      await grants.grant({ pluginId: CLAUDE_PLUGIN.manifest.id, runtimeId: sessionId,
        scope: { kind: 'session', sessionId }, path: request.transcriptPath, reason: 'providerTranscriptSource',
        evidence: { kind: 'sessionStartTranscriptPath', providerSessionId: request.providerSessionId } });
    } });
  const fileFollow = createPluginTranscriptFileFollowService({ pluginId: CLAUDE_PLUGIN.manifest.id,
    runtimeId: sessionId, readSessionId: () => sessionId, fileFollowPathGrants: grants });
  let metadata = createTestMetadata({ flavor: 'claude', path: directory });
  const declaration = CLAUDE_PLUGIN.manifest.contributes?.agents?.find(agent => agent.id === 'claude');
  const workState = createNativeAgentSessionWorkStateService({
    session: { sessionId, updateMetadata: async update => { metadata = update(metadata); } },
    pluginId: CLAUDE_PLUGIN.manifest.id, contributionId: 'claude', agentId: 'claude', occurrenceId: 'goal-test',
    declarations: PluginAgentSessionCapabilitiesV2Schema.parse(Reflect.get(declaration?.capabilities ?? {}, 'sessions')).workStateSources ?? [],
    isCurrent: () => true,
  });
  const exec = createSdkExecFixture(), hooks = createSessionHooksFixture();
  let hookPort = 0;
  let hookSecretFile: string | undefined;
  // The vendor process is the boundary. Real Claude accepts initialize hooks,
  // but its startup event precedes that registration (r120 native-hooks-shapes).
  // Only a configured command hook can supply this startup fact.
  const nativeExec = {
    systemTools: { resolve: async () => ({ executable: { kind: 'systemTool', id: 'claude-cli' }, executablePath: '/managed/claude' }) },
    clients: { spawn: async (spec: Parameters<ExecService['clients']['spawn']>[0]) => {
      const args = spec.launch.args ?? [];
      const pluginDir = args.includes('--plugin-dir') ? args[args.indexOf('--plugin-dir') + 1] : undefined;
      const configured: { hooks: Record<string, unknown> } = pluginDir
        ? JSON.parse(await readFile(join(pluginDir, 'hooks/hooks.json'), 'utf8')) : { hooks: {} };
      if (configured.hooks.SessionStart) {
        const secret = await readFile(hookSecretFile!, 'utf8');
        const response = await fetch(`http://127.0.0.1:${hookPort}/hook/session-start`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-happier-hook-secret': secret },
          body: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup',
            session_id: providerSessionId, transcript_path: transcriptPath }),
        });
        expect(response.status).toBe(200);
      }
      const handle = await exec.service.spawnClient({ launch: { kind: 'agent-cli', agentId: 'claude' },
        transport: { kind: 'stdio', framing: { kind: 'strict-lf-json' } }, protocol: { kind: 'json-stream' } });
      return {
        client: { subscribe: (listener: (record: unknown) => void | Promise<void>) => ({ dispose: handle.client.subscribe(listener) }),
          write: async (record: unknown) => { await handle.client.writeRecord(record); } },
        process: { write: async () => undefined, dispose: async () => { await handle.dispose(); } },
        wait: async () => { await handle.process.exit; return { termination: { observed: { kind: 'exit', exitCode: 0 },
          requestedBy: { kind: 'none' } }, stdout: new Uint8Array(), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false }; },
        dispose: async () => { await handle.dispose(); },
      };
    } },
  } as unknown as ExecService; // Genuine host process boundary, using the canonical SDK fixture.
  const identity = { providerId: 'claude', sessionId };
  hooks.service.observeSessionHook.mockImplementation(request => hooksOwner.observeSessionHook({ ...request, ...identity }));
  hooks.service.startServer.mockImplementation(async request => {
    const server = await hooksOwner.startServer({ ...request, ...identity });
    hookPort = server.port;
    hookSecretFile = server.sessionHookSecretFile;
    return server;
  });
  hooks.service.createPluginDir.mockImplementation(request => hooksOwner.createPluginDir({ ...request, providerId: 'claude' }));
  hooks.service.disposePluginDir.mockImplementation(path => hooksOwner.disposePluginDir(path));
  const ctx = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service, {
    exec: exec.service, sessionHooks: hooks.service, transcripts: { fileFollow },
  });
  const goalContext = { workState, services: { logger: ctx.logger, exec: nativeExec },
    session: { services: { ...ctx.agentRuntime, sessionHooks: hooks.service, transcripts: { fileFollow } } },
  } as unknown as AgentSessionRuntimeContext;
  // Same native host adapter and SDK query composition as nativeRuntime-XG67AHI5.js in r120.
  const nativeContext = createClaudeNativeAgentSdkContext(goalContext);
  const operations = createClaudeAgentSdkTurnOperations({ ctx: nativeContext, queryContext: nativeContext.agentRuntime.exec,
    directory, launchEnv: {}, permissionMode: 'default',
    happierSessionId: sessionId, enableSessionWorkState: true, enableSessionResumability: true,
    publishGoalWorkState: createClaudeNativeGoalWorkStatePublisher(goalContext) });
  try {
    const objective = 'Finish the native Goal';
    if (!operations.setGoal) throw new Error('Native Goal control missing');
    const command = ingress === 'control' ? operations.setGoal(objective)
      : operations.sendProviderTurnPrompt(`/goal ${objective}`);
    await vi.waitFor(() => expect(exec.written.some(row => row && typeof row === 'object' && Reflect.get(row, 'type') === 'user'),
      JSON.stringify([vi.mocked(ctx.logger.debug).mock.calls, vi.mocked(ctx.logger.warn).mock.calls], (_key, value) => value instanceof Error ? value.message : value)).toBe(true));
    const user = exec.written.findLast(row => row && typeof row === 'object' && Reflect.get(row, 'type') === 'user');
    if (!user || typeof user !== 'object') throw new Error('Missing native command');
    const uuid: unknown = Reflect.get(user, 'uuid');
    if (typeof uuid !== 'string') throw new Error('Missing native command UUID');
    // Actual native shape: the sentinel precedes the parent-linked command echo.
    // No fabricated SDK SessionStart callback: the configured startup carrier owns it.
    await exec.emit({ type: 'system', subtype: 'init', session_id: providerSessionId, slash_commands: ['goal'] });
    await appendFile(transcriptPath, [
      { type: 'attachment', uuid: 'native-goal', sessionId: providerSessionId,
        attachment: { type: 'goal_status', sentinel: true, met: false, condition: objective } },
      { type: 'user', uuid, sessionId: providerSessionId, parentUuid: 'native-goal',
        message: { role: 'user', content: `<command-name>/goal</command-name>\n            <command-message>goal</command-message>\n            <command-args>${objective}</command-args>` } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    await exec.emit({ type: 'result', subtype: 'success', session_id: providerSessionId });
    const result = await command;
    if (ingress === 'control') expect(result).toBeUndefined();
    else expect(result).toEqual({ kind: 'accepted' });
    await operations.waitForProviderTurnCompletion();
    await vi.waitFor(() => expect(readSessionWorkStateV1FromMetadata(metadata)?.items).toEqual([
      expect.objectContaining({ kind: 'goal', status: 'active', title: objective, vendorRef: 'native-goal' }),
    ]));
  } finally {
    await operations.disposeProviderSession();
    await rm(directory, { recursive: true, force: true });
  }
});
