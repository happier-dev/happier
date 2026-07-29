import { describe, expect, it, vi } from 'vitest';

import { ProviderConnectionIdSchema } from '@happier-dev/protocol';

const hoisted = vi.hoisted(() => ({
    resolveSpawnChildEnvironment: vi.fn(),
}));

vi.mock('./resolveSpawnChildEnvironment', () => ({
    resolveSpawnChildEnvironment: hoisted.resolveSpawnChildEnvironment,
}));

vi.mock('@/configuration', () => ({
    configuration: { happyHomeDir: '/tmp/happier-home' },
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
    },
}));

import { createProviderLaunchResourceScope } from '@/providers/lifecycle/resourceScope';
import { createProviderRedactionLease } from '@/providers/spawn/redaction';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { prepareDaemonSpawnChildEnvironment } from './prepareDaemonSpawnChildEnvironment';

describe('prepareDaemonSpawnChildEnvironment managed Provider ordering', () => {
    it('uses the daemon managed materializer at the normal late hook instead of calling an external materializer', async () => {
        const events: string[] = [];
        const connectionId = ProviderConnectionIdSchema.parse('pc_managed');
        const sessionBindingMetadata = {
            v: 1 as const,
            connectionId,
            contributionKey: 'happier.provider.cliproxyapi/cliproxyapi',
            connectionRevision: 1,
            protocol: 'openai-responses' as const,
            materialization: 'engineConfig' as const,
            adapterBindingKey: 'cliproxyapi',
            compatibilityFingerprint: 'compatibility-v1',
            bindingSecurityFingerprint: 'binding-security-v1',
            displaySnapshot: {
                providerName: 'CLIProxyAPI',
                connectionName: 'CLIProxyAPI',
                connectionRole: 'default' as const,
                connectionDisplayNameMode: 'automatic' as const,
            },
        };
        const attempt = {
            deployment: { kind: 'managedLocal' as const },
            materializeManagedEndpoint: vi.fn(),
            authorization: {
                ticket: { connectionId },
                binding: {
                    selection: { model: { id: 'model-a' } },
                },
                sessionBindingMetadata,
            },
        };
        const materializeManagedProviderBinding = vi.fn(async () => {
            events.push('managed-materialize');
            return {
                ok: true as const,
                materialization: {
                    providerEnvironmentOverlay: [{
                        name: 'PROVIDER_ENDPOINT',
                        value: 'runtime-only',
                        source: 'provider' as const,
                    }],
                    launchMaterialization: {
                        v: 1 as const,
                        kind: 'engineConfig' as const,
                        engineConfig: { provider: 'managed' },
                    },
                    additionalRedactionValues: [],
                    cleanup: null,
                },
                redactionLease: {
                    redact: (value: string) => value,
                    values: () => [],
                    add: () => undefined,
                    snapshotRedactor: () => (value: string) => value,
                    createStreamingSanitizer: () => ({
                        push: (value: string | Uint8Array) => String(value),
                        flush: () => '',
                    }),
                    close: vi.fn(),
                },
                sessionBindingMetadata,
                managedLocalServiceRunAttachment: {
                    v: 1 as const,
                    process: {
                        pid: 701,
                        processStartTimeMs: 1_717_171_717_701,
                        processCommandHash: 'a'.repeat(64),
                    },
                    endpoint: {
                        host: '127.0.0.1' as const,
                        port: 45_701,
                    },
                    materialization: {
                        rootDir: '/tmp/happier-managed-provider',
                        materializationId: 'materialization-managed-provider',
                    },
                },
                managedLocalServiceOwnedRun: {
                    serviceKey: 'managed-provider:session-a',
                    runId: 7,
                    snapshot: {
                        id: 'cliproxyapi',
                        phase: 'running' as const,
                        port: 45_701,
                        diagnostics: [],
                    },
                    process: {
                        pid: 701,
                        startedAt: 1_717_171_717_701,
                        processStartTimeMs: 1_717_171_717_701,
                        processCommandHash: 'a'.repeat(64),
                    },
                    host: '127.0.0.1' as const,
                    port: 45_701,
                },
                activateManagedProviderRequestAuth: vi.fn(async () => undefined),
            };
        });
        hoisted.resolveSpawnChildEnvironment.mockImplementationOnce(async (input) => {
            events.push('generic-hooks');
            expect(input.runtimePrerequisitesAlreadyResolved).toBe(false);
            const materialized = await input.materializeProviderBindingAfterHooks?.();
            expect(materialized).toMatchObject({
                ok: true,
                providerBindingLaunchHandoff: {
                    sessionBindingMetadata,
                },
            });
            return {
                ok: true,
                cleanupOnFailure: null,
                cleanupOnExit: null,
                expandedEnvironmentVariables: {},
                extraEnvForChild: {},
            };
        });

        // The low-level resolver is mocked; this fixture only proves registry identity crosses the wrapper.
        const pluginRuntimeRegistry = Object.freeze(
            {},
        ) as unknown as ResolvedExecutablePluginRuntimeRegistry;
        const result = await prepareDaemonSpawnChildEnvironment({
            effectiveModelSelection: undefined,
            options: {
                directory: '/tmp/project',
                machineId: 'machine-a',
                backendTarget: {
                    kind: 'backend',
                    sourceKind: 'built_in',
                    backendId: 'codex',
                },
            },
            terminal: undefined,
            profileEnvironmentVariables: {},
            daemonSpawnHooks: null,
            pluginRuntimeRegistry,
            processEnv: {},
            connectedServiceAuth: null,
            connectedServiceMaterializationIdentity: null,
            providerBindingAttempt: attempt as never,
            providerAgentTargetKey: 'backend:codex',
            providerDiagnosticRedactionLease:
                createProviderRedactionLease({ values: [] }),
            materializeManagedProviderBinding,
            launchResourceScope: createProviderLaunchResourceScope(),
        });

        expect(result).toMatchObject({
            ok: true,
            managedLocalServiceRunAttachment: {
                process: { pid: 701 },
                endpoint: { host: '127.0.0.1', port: 45_701 },
                materialization: {
                    materializationId: 'materialization-managed-provider',
                },
            },
            managedLocalServiceOwnedRun: {
                serviceKey: 'managed-provider:session-a',
                runId: 7,
            },
        });
        expect(events).toEqual(['generic-hooks', 'managed-materialize']);
        expect(materializeManagedProviderBinding).toHaveBeenCalledOnce();
    });
});
