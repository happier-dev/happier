import { resolveCodexSessionBackendMode } from '@happier-dev/agents';

import type { PreflightModelsProbeAdapter } from '@/capabilities/probes/preflightModelsProbeAdapterTypes';
import { withCodexAppServerClient } from '@/backends/codex/appServer/client/withCodexAppServerClient';
import { readCodexAppServerSessionControls } from '@/backends/codex/appServer/sessionControlsMetadata';
import { readCodexEnvironmentAuthState } from '@/backends/codex/cli/auth/readCodexEnvironmentAuthState';

export const codexPreflightModelsProbeAdapter: PreflightModelsProbeAdapter = {
  failureCacheStrategy: 'retry',
  probeModelsRaw: async (params) => {
    const backendMode =
      resolveCodexSessionBackendMode({ metadata: null, accountSettings: params.accountSettings ?? null }) ?? 'appServer';
    if (backendMode !== 'appServer') {
      return null;
    }

    const authMethod = readCodexEnvironmentAuthState().method;
    const controls = await withCodexAppServerClient({
      cwd: params.cwd,
      run: async (client) =>
        readCodexAppServerSessionControls({
          client,
          authMethod,
        }),
    });

    return controls.availableModels;
  },
};

export function resolveCodexModelsProbeVariant(accountSettings?: Readonly<Record<string, unknown>> | null): string {
  const backendMode = resolveCodexSessionBackendMode({ metadata: null, accountSettings: accountSettings ?? null }) ?? 'appServer';
  return `codex:${backendMode}`;
}
