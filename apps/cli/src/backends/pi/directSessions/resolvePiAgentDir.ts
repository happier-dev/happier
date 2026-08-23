import { join } from 'node:path';

import type { DirectSessionsSource } from '@happier-dev/protocol';
import { expandHomeDirPath, resolveHomeDirFromEnvironment } from '@happier-dev/cli-common/providers';

/**
 * Resolve the pi agent directory (`~/.pi/agent`) for direct-session operations. Precedence mirrors
 * pi's own `getDefaultAgentDir`: explicit `source.agentDir`, then `PI_CODING_AGENT_DIR`, then
 * `<home>/.pi/agent`. This is the pi equivalent of Claude's `resolveClaudeConfigDir`.
 */
export function resolvePiAgentDir(params: Readonly<{
  source: DirectSessionsSource;
  env: NodeJS.ProcessEnv;
}>): string {
  const env = params.env;
  if (params.source.kind === 'piAgentDir') {
    const fromSource = typeof params.source.agentDir === 'string' ? params.source.agentDir.trim() : '';
    if (fromSource) {
      const expanded = expandHomeDirPath(fromSource, env);
      if (expanded) return expanded;
    }
  }

  const fromEnv = typeof env.PI_CODING_AGENT_DIR === 'string' ? env.PI_CODING_AGENT_DIR.trim() : '';
  if (fromEnv) {
    const expanded = expandHomeDirPath(fromEnv, env);
    if (expanded) return expanded;
  }

  return join(resolveHomeDirFromEnvironment(env), '.pi', 'agent');
}
