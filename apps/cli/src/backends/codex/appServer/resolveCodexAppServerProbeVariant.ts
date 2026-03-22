import { resolveCodexSessionBackendMode } from '@happier-dev/agents';

import { readCodexEnvironmentAuthState } from '../cli/auth/readCodexEnvironmentAuthState';

export function resolveCodexAppServerProbeVariant(accountSettings?: Readonly<Record<string, unknown>> | null): string {
    const backendMode = resolveCodexSessionBackendMode({ metadata: null, accountSettings: accountSettings ?? null }) ?? 'default';
    if (backendMode !== 'appServer') {
        return `codex:${backendMode}`;
    }

    const authMethod = readCodexEnvironmentAuthState().method ?? 'unknown-auth';
    return `codex:${backendMode}:${authMethod}`;
}
