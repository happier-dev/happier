import type { DaemonSpawnHooks } from '@/daemon/spawnHooks';
import { resolveClaudeConfigDirOverride } from '@/backends/claude/utils/resolveClaudeConfigDirOverride';
import { resolveClaudeConfigDirEnvOverlay } from '@/backends/claude/utils/resolveClaudeConfigDirEnvOverlay';
import { resolveClaudeExternalSandboxEnv } from '@/backends/claude/spawn/resolveClaudeExternalSandboxEnv';
import { resolveProviderOutgoingMessageMetaExtras } from '@/settings/providerSettings';
import { readDaemonClaudeUnifiedTerminalPin, resolveInitialClaudeRemoteMetaState } from '@/backends/claude/remote/resolveInitialClaudeRemoteMetaState';
import { normalizeClaudeRemoteMode } from '@/backends/claude/remote/normalizeClaudeRemoteMode';
import { HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY } from '@/backends/claude/endpointRecovery/claudeEndpointArtifacts';

export const claudeDaemonSpawnHooks: DaemonSpawnHooks = {
  resolveTerminalPresentation: ({ host, accountSettings, processEnv }) => {
    const defaults = accountSettings
      ? resolveProviderOutgoingMessageMetaExtras({ agentId: 'claude', settings: accountSettings, session: null })
      : {};
    const hasRecoverableDetachedProvider = Boolean(
      processEnv[HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY]?.trim(),
    );
    const unified = hasRecoverableDetachedProvider
      || normalizeClaudeRemoteMode(resolveInitialClaudeRemoteMetaState({ metaDefaults: defaults,
        pinnedUnifiedTerminalEnabled: readDaemonClaudeUnifiedTerminalPin('daemon', processEnv),
      })).kind === 'unifiedTerminal';
    return unified
      ? host === 'herdr' && !hasRecoverableDetachedProvider
        ? {
          kind: 'runner',
          startingMode: 'local',
          childEnv: { HAPPIER_CLAUDE_UNIFIED_TERMINAL_PIN: '1' },
        }
        : { kind: 'provider', childEnv: { HAPPIER_CLAUDE_UNIFIED_TERMINAL_PIN: '1' } }
      : { kind: 'runner', startingMode: 'remote', childEnv: { HAPPIER_CLAUDE_UNIFIED_TERMINAL_PIN: '0' } };
  },
  buildExtraEnvForChild: () => {
    return {
      ...resolveClaudeConfigDirEnvOverlay(process.env),
      ...resolveClaudeExternalSandboxEnv(process.env),
    };
  },
};
