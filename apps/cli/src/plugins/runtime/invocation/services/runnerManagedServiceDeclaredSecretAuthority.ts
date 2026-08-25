import { join } from 'node:path';

import { readOrCreateDeviceLocalSecretStorage } from '@/daemon/deviceLocalSecretStorage';
import type { PluginStorePaths } from '@/plugins/store/paths';
import {
    verifyRunnerAgentBindingAgainstGeneration,
} from '@/plugins/runtime/runner/loadRetainedAgentRuntimeLeaf';
import type {
    AgentSessionRunnerBindingV1,
} from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import {
    collectDeclaredPluginSecrets,
} from '@/plugins/runtime/context/declaredPluginSecrets';
import {
    createDaemonPluginSecretCustodyRouter,
    createPluginSecretCustodyRouter,
    createStableDeclaredPluginSecretsHost,
} from '@/plugins/runtime/context/secrets';

export type RunnerManagedServiceDeclaredSecretRequest = Readonly<{
    phase: 'read' | 'revalidate';
    secretId: string;
    canonicalOrigin: string;
    expectedRevision?: string;
}>;

export type RunnerManagedServiceDeclaredSecretResult =
    | Readonly<{
        status: 'resolved';
        /** `null` is the configured-but-missing/empty credential state. */
        value: string | null;
        revision: string;
    }>
    | Readonly<{ status: 'current' | 'stale' | 'unavailable' }>;

const UNAVAILABLE: RunnerManagedServiceDeclaredSecretResult =
    Object.freeze({ status: 'unavailable' as const });

/**
 * Serves one host-private managed-service secret read for a retained runner.
 *
 * The runner is not a secret-custody authority: it holds no device-local key
 * material and cannot decrypt a managed-service credential. The current daemon
 * resolves the declaration from the exact retained generation's manifest and
 * reads the value through the one canonical daemon custody owner, so a runner
 * whose daemon authority is gone, rotated, or refusing gets no credential at
 * all rather than a locally decrypted one.
 */
export async function resolveRunnerManagedServiceDeclaredSecret(
    input: Readonly<{
        paths: PluginStorePaths;
        binding: AgentSessionRunnerBindingV1;
        request: RunnerManagedServiceDeclaredSecretRequest;
        signal?: AbortSignal;
    }>,
): Promise<RunnerManagedServiceDeclaredSecretResult> {
    if (input.signal?.aborted) return UNAVAILABLE;
    let manifest: Awaited<
        ReturnType<typeof verifyRunnerAgentBindingAgainstGeneration>
    >['manifest'];
    try {
        ({ manifest } = await verifyRunnerAgentBindingAgainstGeneration({
            paths: input.paths,
            binding: input.binding,
        }));
    } catch {
        return UNAVAILABLE;
    }
    const declarations = collectDeclaredPluginSecrets([{
        pluginId: input.binding.pluginId,
        manifest,
    }]);
    if (declarations.length === 0) return UNAVAILABLE;
    const secretsHost = createStableDeclaredPluginSecretsHost({
        declarations,
        resolveCustody: createPluginSecretCustodyRouter({
            daemon: createDaemonPluginSecretCustodyRouter({
                paths: input.paths,
                resolveDeviceLocalSecretStorage: async () =>
                    await readOrCreateDeviceLocalSecretStorage({
                        path: join(
                            input.paths.happyHomeDir,
                            'device-local-secret-key.json',
                        ),
                    }),
            }).resolve,
        }).resolve,
    });
    const readPort = secretsHost.bindManagedServiceSecretReadPort({
        pluginId: input.binding.pluginId,
        signal: input.signal ?? new AbortController().signal,
        // This binding exists only for this one operation, after the retained
        // generation was verified above. Redaction belongs to the runner
        // invocation that consumes the value; this path never logs it.
        isGenerationCurrent: () => true,
        registerRawForRedaction: () => {},
    });
    if (!readPort) return UNAVAILABLE;
    const resolved = await readPort({
        secretId: input.request.secretId,
        canonicalOrigin: input.request.canonicalOrigin,
        ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!resolved) return UNAVAILABLE;
    if (input.request.phase === 'revalidate') {
        return Object.freeze({
            status: input.request.expectedRevision === resolved.revision
                ? 'current' as const
                : 'stale' as const,
        });
    }
    return Object.freeze({
        status: 'resolved' as const,
        value: resolved.value,
        revision: resolved.revision,
    });
}
