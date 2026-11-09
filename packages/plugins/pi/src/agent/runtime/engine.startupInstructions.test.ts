import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import type { AgentExecutionRunOpenRequest, AgentExecutionRunRuntimeContextV1, AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import type { PluginProtocolClientSpec } from '@happier-dev/plugin-sdk/exec/protocol-clients';
import { createPiAgentRuntime } from './engine.js';

it('refuses a native startup plan before effects when the host cannot supply the Pi extension bridge', async () => {
  let nativeToolResolutions = 0;
  // Host Account observation and OS tool resolution are genuine system boundaries.
  // The no-plan control proves this fixture reaches the intended native boundary.
  const context = {
    signal: new AbortController().signal,
    services: {
      logger: { warn() {} },
      connectedAccounts: {
        watch(_purpose: string, listener: () => void) { listener(); return { dispose() {} }; },
        getBinding: async () => null,
      },
      exec: { systemTools: { resolve: async () => {
        nativeToolResolutions += 1;
        throw new Error('native-effect');
      } } },
    },
    session: { id: 'pi-startup', services: {} },
  } as unknown as AgentSessionRuntimeContext;
  await expect(createPiAgentRuntime().sessions.open({
    kind: 'resume', sessionId: 'pi-startup', providerSessionId: 'pi-native', cwd: '/workspace',
  }, context)).rejects.toThrow('native-effect');
  expect(nativeToolResolutions).toBe(1);
  await expect(createPiAgentRuntime().sessions.open({
    kind: 'resume', sessionId: 'pi-startup', providerSessionId: 'pi-native', cwd: '/workspace',
    startupInstructions: { v: 1, id: 'happier.coding_session_plan', revision: 2, instructions: 'New role and worker plan' },
  }, context)).rejects.toMatchObject({ code: 'agent_session_startup_instructions_unsupported' });
  expect(nativeToolResolutions).toBe(1);
});

it('prepares only supplied MCP servers for a detached Pi execution run without Session bridge authority', async () => {
  const request = {
    kind: 'create',
    runId: 'pi-detached-run',
    cwd: '/workspace',
    profile: { pluginId: 'happier.agent.pi', localId: 'default' },
    input: { text: 'Use the supplied MCP server.' },
    mcpServers: { supplied: { command: 'supplied-mcp', args: ['--stdio'], env: { SUPPLIED_CONTEXT: 'kept' } } },
    launchEnvironment: { values: { DETACHED_INPUT: 'kept' }, unset: [] },
  } satisfies AgentExecutionRunOpenRequest;
  const spawnBoundaryFailure = new Error('native spawn boundary reached');
  const launches: Extract<PluginProtocolClientSpec, { kind: 'jsonStream' }>[] = [];
  let generatedConfig: unknown;
  let configPath: string | undefined;
  // Account observations and native process resolution/spawn are system boundaries.
  // Keep the engine, Connected Account preparation and extension materialization real.
  const context = {
    signal: new AbortController().signal,
    scope: { kind: 'execution_run', executionRunId: request.runId },
    executionRun: { id: request.runId, services: {} },
    services: {
      logger: { warn() {} },
      connectedAccounts: {
        watch(_purpose: string, listener: () => void) { listener(); return { dispose() {} }; },
        getBinding: async () => null,
      },
      exec: {
        systemTools: { resolve: async () => ({ executable: { kind: 'systemTool', id: 'pi-cli' }, executablePath: '/native/pi' }) },
        clients: { spawn: async (spec: Extract<PluginProtocolClientSpec, { kind: 'jsonStream' }>) => {
          launches.push(spec);
          const configFlag = spec.launch.args.indexOf('--happier-tools-config');
          expect(configFlag).toBeGreaterThanOrEqual(0);
          configPath = spec.launch.args[configFlag + 1];
          expect(configPath).toBeDefined();
          generatedConfig = JSON.parse(readFileSync(configPath!, 'utf8'));
          throw spawnBoundaryFailure;
        } },
      },
    },
  } as unknown as AgentExecutionRunRuntimeContextV1;

  await expect(createPiAgentRuntime().sessions.executionRunContextV1!.open(request, context)).rejects.toBe(spawnBoundaryFailure);
  expect(launches).toHaveLength(1);
  // Exact projections reject added Happier transport, bearer, Session or tool context.
  expect(generatedConfig).toEqual({ v: 1, directory: request.cwd, systemPrompt: '', tools: [], mcpServers: request.mcpServers });
  expect(launches[0]!.launch.env).toEqual({ DETACHED_INPUT: 'kept', NODE_ENV: 'production', DEBUG: '', CI: '1' });
  expect(launches[0]!.launch.args).not.toContain('--session');
  expect(existsSync(configPath!)).toBe(false);
});
