import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import type { PluginProtocolClientHandle, PluginProtocolClientSpec } from '@happier-dev/plugin-sdk/exec/protocol-clients';
import type { AgentExecutionRunRuntimeContextV1, AgentSessionOpenRequest, AgentSessionRuntime, AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { createAgentLaunchObserver, runAgentSkillDeliveryContract, type AgentLaunchObserverBoundaries } from '@happier-dev/plugin-sdk/testing';

import { PLUGIN_MANIFEST } from '../manifest.js';
import { createPiAgentRuntime } from './runtime/engine.js';

const home = mkdtempSync(join(tmpdir(), 'happier-pi-skill-home-'));
for (const root of ['.pi/agent/skills', '.agents/skills']) {
  mkdirSync(join(home, root, 'retained-native'), { recursive: true });
  writeFileSync(join(home, root, 'retained-native', 'SKILL.md'), 'Native skill bytes stay unchanged.');
}
afterAll(() => rmSync(home, { recursive: true, force: true }));
const observer = createAgentLaunchObserver({ home });
const boundaries = observer.boundaries as AgentLaunchObserverBoundaries;

function observeLaunch() {
  const launch = observer.observeLaunch();
  // Runtime-owned bridge paths vary per launch. Compare the actual consumed bytes,
  // while the shared observer still records the real argv and native-home writes.
  return { ...launch, argv: launch.argv.map((argument, index) => {
    const flag = launch.argv[index - 1];
    if (flag === '--happier-tools-config'
      || (flag === '--extension' && argument.endsWith('happier-pi-tools-bridge.mjs'))) {
      return readFileSync(argument, 'utf8');
    }
    return argument;
  }) };
}

function processBoundary(spec: Extract<PluginProtocolClientSpec, { kind: 'jsonStream' }>): PluginProtocolClientHandle<'jsonStream'> {
  boundaries.recordLaunch({ argv: spec.launch.args ?? [], env: spec.launch.env });
  let listener: ((record: unknown) => void | Promise<void>) | undefined;
  let finish!: (result: PluginProcessResult) => void;
  const result: PluginProcessResult = { termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
    stdout: new Uint8Array(), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false };
  const exited = new Promise<PluginProcessResult>((resolve) => { finish = resolve; });
  const dispose = async () => { finish(result); };
  return {
    client: {
      subscribe(handler) { listener = handler; return { dispose() { listener = undefined; } }; },
      async write(record: JsonValue) {
        if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Expected Pi RPC command');
        await listener?.({ type: 'response', id: record.id, command: record.type, success: true,
          data: record.type === 'get_state' ? { sessionId: 'pi-skill-contract' } : { commands: [] } });
      },
      dispose,
    },
    process: { pid: 123, write: async () => {}, closeStdin: async () => {}, wait: () => exited,
      onOutput: () => ({ dispose() {} }), dispose },
    wait: () => exited,
    dispose,
  };
}

function context() {
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  // The fixture replaces only process execution and Connected Account service boundaries.
  return {
    signal: new AbortController().signal,
    services: {
      logger,
      connectedAccounts: {
        watch(_purpose: string, callback: () => void) { callback(); return { dispose() {} }; },
        getBinding: async () => null,
      },
      interactions: { askQuestions: async () => ({ status: 'unavailable' }) },
      exec: {
        systemTools: { resolve: async () => ({ executable: { kind: 'systemTool', id: 'pi-cli' }, executablePath: '/fixture/pi' }) },
        run: async () => ({ termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
          stdout: new TextEncoder().encode('0.82.1'), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false }),
        clients: { spawn: async (spec: Extract<PluginProtocolClientSpec, { kind: 'jsonStream' }>) => processBoundary(spec) },
      },
    },
    session: { id: 'skill-delivery-contract', services: {} },
  };
}

async function openSession(request: AgentSessionOpenRequest): Promise<AgentSessionRuntime> {
  boundaries.reset();
  return await createPiAgentRuntime().sessions.open({ ...request, launchEnvironment: { values: { HOME: home }, unset: [] } },
    context() as unknown as AgentSessionRuntimeContext);
}

async function openRun(request: AgentSessionOpenRequest): Promise<AgentSessionRuntime> {
  boundaries.reset();
  const runtime = await createPiAgentRuntime().sessions.executionRunContextV1!.open({
    kind: 'resume', checkpointId: 'pi-skill-contract', runId: 'pi-skill-run', cwd: request.cwd,
    profile: { pluginId: 'happier.agent.pi', localId: 'pi' }, skills: request.skills,
    launchEnvironment: { values: { HOME: home }, unset: [] },
  }, { ...context(), session: undefined, scope: { kind: 'execution_run', executionRunId: 'pi-skill-run' },
    executionRun: { id: 'pi-skill-run', services: {} } } as unknown as AgentExecutionRunRuntimeContextV1);
  // The launch kit consumes only disposal for this native Run variant.
  return runtime as unknown as AgentSessionRuntime;
}

const agent = PLUGIN_MANIFEST.contributes.agents.find((candidate) => candidate.id === 'pi');
if (!agent) throw new Error('Pi Agent contribution is missing');
it('declares the proven Pi delivery and the native roots the resolver scans', () => {
  expect(agent.capabilities.skills).toEqual({ delivery: 'session_dir', nativeDisable: 'unsupported', liveReload: 'unsupported',
    nativeRoots: { user: [['.pi', 'agent', 'skills'], ['.agents', 'skills']], project: [['.pi', 'skills'], ['.agents', 'skills']] } });
});
runAgentSkillDeliveryContract({ agent, openSession, observeLaunch,
  variants: [{ id: 'Session', open: openSession, expect: 'delivers' }, { id: 'Run', open: openRun, expect: 'delivers' }] });
