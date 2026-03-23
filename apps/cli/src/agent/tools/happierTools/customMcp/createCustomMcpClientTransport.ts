import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import type { McpServerConfig } from '@/agent';

function resolveEnvRecord(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(env)) {
    const value = env[key];
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

function hasResume(value: unknown): value is Readonly<{ resume: () => void }> {
  return typeof value === 'object' && value !== null && 'resume' in value && typeof value.resume === 'function';
}

export function createCustomMcpClientTransport(
  config: McpServerConfig,
  processEnv: NodeJS.ProcessEnv,
): StdioClientTransport {
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    env: config.env ? { ...resolveEnvRecord(processEnv), ...config.env } : resolveEnvRecord(processEnv),
    stderr: 'pipe',
  });
  const stderr = transport.stderr;
  if (hasResume(stderr)) {
    stderr.resume();
  }
  return transport;
}
