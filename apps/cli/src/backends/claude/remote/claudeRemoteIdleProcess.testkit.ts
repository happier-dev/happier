import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { killProcessTree } from '@/agent/runtime/process/killProcessTree';
import { isPidAlive, waitForProcessExit } from '@/testkit/process/spawn';

/** Real SDK wire/OS boundary: a Claude-shaped child owns a long-lived MCP-shaped descendant. */
export async function createClaudeRemoteIdleProcessFixture(sessionId: string, options: Readonly<{
  residentWorkTool?: 'CronCreate' | 'ScheduleWakeup' | 'TeamCreate';
  turnDurationMs?: number;
  backgroundTask?: boolean;
}> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'claude-idle-process-'));
  const executablePath = join(directory, 'provider.cjs');
  const transcriptPath = join(directory, `${sessionId}.jsonl`);
  const processesPath = join(directory, 'processes.json');
  await writeFile(transcriptPath, '{"type":"summary"}\n');
  await writeFile(executablePath, `
    const fs = require('node:fs');
    const mcp = require('node:child_process').spawn(process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    fs.writeFileSync(${JSON.stringify(processesPath)}, JSON.stringify({ provider: process.pid, mcp: mcp.pid }));
    process.on('SIGTERM', () => {
      mcp.once('exit', () => process.exit(0));
      mcp.kill('SIGTERM');
    });
    const send = value => console.log(JSON.stringify(value));
    let initialized = false;
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const message = JSON.parse(line);
      if (message.type === 'control_request') {
        send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id,
          response: { commands: [], models: [], agents: [] } } });
      } else if (message.type === 'user') {
        if (!initialized) {
          initialized = true;
          const resumeIndex = process.argv.indexOf('--resume');
          const resumed = resumeIndex >= 0 ? process.argv[resumeIndex + 1] : null;
          if (resumed !== ${JSON.stringify(sessionId)}) throw new Error('Expected exact native resume identity');
          send({ type: 'system', subtype: 'init', session_id: resumed });
        }
        send({ ...message, isReplay: true, session_id: ${JSON.stringify(sessionId)} });
        if (${options.backgroundTask === true}) {
          send({ type: 'system', subtype: 'task_started', session_id: ${JSON.stringify(sessionId)},
            task_id: 'background-agent', task_type: 'local_agent', is_backgrounded: true });
        }
        const toolName = ${JSON.stringify(options.residentWorkTool ?? null)};
        if (toolName) {
          send({ type: 'assistant', session_id: ${JSON.stringify(sessionId)}, parent_tool_use_id: null,
            uuid: 'resident-tool-message', message: { id: 'resident-tool-message', role: 'assistant',
              content: [{ type: 'tool_use', id: 'resident-tool', name: toolName, input: {} }] } });
        }
        const finishTurn = () => send({ type: 'result', subtype: 'success', session_id: ${JSON.stringify(sessionId)} });
        if (${options.turnDurationMs ?? 0} > 0) setTimeout(finishTurn, ${options.turnDurationMs ?? 0});
        else finishTurn();
      }
    });
    setInterval(() => {}, 1000);
  `);

  const readProcesses = async (): Promise<{ provider: number; mcp: number }> => {
    const value: unknown = JSON.parse(await readFile(processesPath, 'utf8'));
    if (!value || typeof value !== 'object' || !('provider' in value) || !('mcp' in value)
      || typeof value.provider !== 'number' || typeof value.mcp !== 'number') {
      throw new Error('Expected fixture-owned provider and MCP process ids');
    }
    return { provider: value.provider, mcp: value.mcp };
  };

  const stop = async () => {
    const processes = await readProcesses().catch(() => null);
    if (processes) {
      await killProcessTree({ pid: processes.provider });
      await killProcessTree({ pid: processes.mcp });
    }
  };

  return {
    directory,
    executablePath,
    transcriptPath,
    // The test environment's JS runtime resolver is stubbed. Execute its requested SDK arguments
    // with this test process's actual runtime, preserving the real SDK transport and child owner.
    spawnClaudeCodeProcess: (options: SpawnOptions) => {
      const args = options.args[0] === executablePath ? options.args : [executablePath, ...options.args];
      return spawn(process.execPath, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    },
    async assertRunning() {
      const processes = await readProcesses();
      if (!isPidAlive(processes.provider) || !isPidAlive(processes.mcp)) {
        throw new Error('Expected both fixture-owned processes alive before idle retirement');
      }
    },
    async assertStopped() {
      const processes = await readProcesses();
      if (!(await waitForProcessExit(processes.provider)) || !(await waitForProcessExit(processes.mcp))) {
        throw new Error('Idle teardown left a fixture-owned provider or MCP process alive');
      }
    },
    stop,
    async cleanup() {
      await stop();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
