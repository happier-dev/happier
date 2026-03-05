import type { DaemonMcpServersDetectWarningV1, DetectedMcpServerV1, McpDetectedProviderV1 } from '@happier-dev/protocol';

import { detectClaudeMcpServers } from '@/backends/claude/mcp/detectClaudeMcpServers';
import { detectCodexMcpServers } from '@/backends/codex/mcp/detectCodexMcpServers';
import { detectOpenCodeMcpServers } from '@/backends/opencode/mcp/detectOpenCodeMcpServers';

export type DetectProviderMcpServersResult = Readonly<{
  servers: ReadonlyArray<DetectedMcpServerV1>;
  warnings: ReadonlyArray<DaemonMcpServersDetectWarningV1>;
}>;

function normalizeProvidersFilter(input: unknown): ReadonlySet<McpDetectedProviderV1> | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const out = new Set<McpDetectedProviderV1>();
  for (const entry of input) {
    if (entry === 'claude' || entry === 'codex' || entry === 'opencode') out.add(entry);
  }
  return out.size > 0 ? out : null;
}

export async function detectProviderMcpServers(params: Readonly<{
  directory: string | null;
  providers: unknown;
  env?: NodeJS.ProcessEnv;
}>): Promise<DetectProviderMcpServersResult> {
  const env = params.env ?? process.env;
  const providers = normalizeProvidersFilter(params.providers);
  const directory = typeof params.directory === 'string' && params.directory.trim().length > 0 ? params.directory.trim() : null;

  const servers: DetectedMcpServerV1[] = [];
  const warnings: DaemonMcpServersDetectWarningV1[] = [];

  const include = (provider: McpDetectedProviderV1): boolean => (!providers || providers.has(provider));

  if (include('claude')) {
    const out = await detectClaudeMcpServers({ directory, env });
    servers.push(...out.servers);
    warnings.push(...out.warnings);
  }

  if (include('codex')) {
    const out = await detectCodexMcpServers({ env });
    servers.push(...out.servers);
    warnings.push(...out.warnings);
  }

  if (include('opencode')) {
    const out = await detectOpenCodeMcpServers({ directory, env });
    servers.push(...out.servers);
    warnings.push(...out.warnings);
  }

  return { servers, warnings };
}
