import type { PluginExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/runtime';

import { ANTIGRAVITY_CLI_SYSTEM_TOOL_ID } from '../systemTool.js';
import type { AntigravityCliPrintExecRun, AntigravityCliPrintExit } from './oneShot.js';

function mapProcessResult(result: PluginProcessResult): AntigravityCliPrintExit {
  const observed = result.termination.observed;
  return {
    exitCode: observed.kind === 'exit' ? observed.exitCode : null,
    signal: observed.kind === 'signal' ? observed.signal : null,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

export function createAntigravityNativeCliPrintExecRun(
  exec: Pick<PluginExecService, 'systemTools' | 'run'>,
): AntigravityCliPrintExecRun {
  return async (input, options) => {
    if (input.agentId !== 'antigravity') {
      throw new Error(`Antigravity CLI print cannot run Agent '${input.agentId}'.`);
    }
    const resolved = await exec.systemTools.resolve({
      toolId: ANTIGRAVITY_CLI_SYSTEM_TOOL_ID,
      purpose: 'Run an Antigravity CLI print turn.',
      cwd: input.cwd,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const result = await exec.run({
      executable: resolved.executable,
      args: input.args,
      ...(input.env ? { env: input.env } : {}),
      maxStdoutBytes: options.maxStdoutBytes,
      maxStderrBytes: options.maxStderrBytes,
      timeoutMs: options.timeoutMs,
    }, options.signal ? { signal: options.signal } : undefined);
    return mapProcessResult(result);
  };
}
