import { resolveRunnerMcpMaterialV1 } from '@happier-dev/protocol/ephemeralRunner/runnerMcpMaterial';
import type { SavedSecret } from '@happier-dev/protocol/profiles/backendProfileSchema';
import type { SessionMcpSelectionV1 } from '@happier-dev/protocol/mcp/servers/sessionSelectionV1';
import type { RunnerMcpMaterialV1, RunnerMcpMaterializationFailureV1 } from '@happier-dev/protocol/ephemeralRunner/runnerMcpMaterial';
import { normalizeMcpServersSettingsV1 } from '@/sync/domains/settings/mcpServers/normalizeMcpServersSettingsV1';

export class RunnerMcpMaterializationUnavailableError extends Error {
    constructor(readonly failure: RunnerMcpMaterializationFailureV1) {
        super(`runner_mcp_${failure.reason}_${failure.serverId}`);
        this.name = 'RunnerMcpMaterializationUnavailableError';
    }
}

/** Resolves only the selected MCP values into creator custody for endpoint sealing. */
export function prepareRunnerMcpMaterial(input: Readonly<{
    settingsLike: unknown;
    selection: SessionMcpSelectionV1 | null;
    secrets: readonly SavedSecret[];
    decryptSecretValue: (value: SavedSecret['encryptedValue']) => string | null;
}>): RunnerMcpMaterialV1 | null {
    const settings = normalizeMcpServersSettingsV1(input.settingsLike);
    const secretsById = new Map(input.secrets.map((secret) => [secret.id, secret]));
    const resolved = resolveRunnerMcpMaterialV1({
        settings,
        selection: input.selection,
        resolveSavedSecret: (secretId) => {
            const secret = secretsById.get(secretId);
            if (!secret) return null;
            try {
                const value = input.decryptSecretValue(secret.encryptedValue);
                return value === null ? null : { value, revision: secret.updatedAt };
            } catch {
                return null;
            }
        },
    });
    if (!resolved.ok) throw new RunnerMcpMaterializationUnavailableError(resolved);
    return resolved.material.servers.length === 0 ? null : resolved.material;
}
