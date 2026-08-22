import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveVendorHandoffIdMetadataMock = vi.hoisted(() => vi.fn());
const buildSourceRecoveryResumePatchMetadataMock = vi.hoisted(() => vi.fn());

vi.mock('@happier-dev/agents', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@happier-dev/agents')>();
    return {
        ...actual,
        resolveVendorHandoffIdFromSessionMetadata: (
            agentId: Parameters<typeof actual.resolveVendorHandoffIdFromSessionMetadata>[0],
            metadata: Parameters<typeof actual.resolveVendorHandoffIdFromSessionMetadata>[1],
        ) => {
            resolveVendorHandoffIdMetadataMock(metadata);
            return actual.resolveVendorHandoffIdFromSessionMetadata(agentId, metadata);
        },
    };
});

vi.mock('@/agents/registry/registryUiBehavior', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/agents/registry/registryUiBehavior')>();
    return {
        ...actual,
        buildSessionHandoffSourceRecoveryResumePatch: (
            input: Parameters<typeof actual.buildSessionHandoffSourceRecoveryResumePatch>[0],
        ) => {
            buildSourceRecoveryResumePatchMetadataMock(input.metadata);
            return actual.buildSessionHandoffSourceRecoveryResumePatch(input);
        },
    };
});

import type { Metadata } from '@/sync/domains/state/storageTypes';

import { buildSessionHandoffRecoveryPlan } from './recoveryPlan';

describe('buildSessionHandoffRecoveryPlan', () => {
    beforeEach(() => {
        resolveVendorHandoffIdMetadataMock.mockReset();
        buildSourceRecoveryResumePatchMetadataMock.mockReset();
    });

    it('resolves aliased flavors and vendor resume ids through the agent registry', () => {
        const sourceMetadata = {
            flavor: 'open-code',
            path: '/repo',
            opencodeSessionId: ' remote_opencode_session ',
        } as Metadata;

        expect(
            buildSessionHandoffRecoveryPlan({
                handoffId: 'handoff_1',
                sessionId: 'session_1',
                sourceMachineId: 'machine_source',
                sourceMetadata,
                sessionStorageMode: 'direct',
                serverId: ' server_1 ',
            }),
        ).toEqual({
            handoffId: 'handoff_1',
            actions: ['restart_on_source', 'keep_stopped'],
            sourceResume: {
                sessionId: 'session_1',
                machineId: 'machine_source',
                directory: '/repo',
                agent: 'opencode',
                resume: 'remote_opencode_session',
                transcriptStorage: 'direct',
                serverId: 'server_1',
            },
        });
    });

    it('returns null when the source metadata has no supported resumable agent or directory', () => {
        expect(
            buildSessionHandoffRecoveryPlan({
                handoffId: 'handoff_2',
                sessionId: 'session_2',
                sourceMachineId: 'machine_source',
                sourceMetadata: {
                    flavor: 'unknown',
                    path: '',
                } as Metadata,
                sessionStorageMode: 'persisted',
            }),
        ).toBeNull();
    });

    it('keeps an installed Agent identity and its runtime vendor resume id for source recovery', () => {
        const runtimeDescriptorV1 = {
            v: 1,
            agentId: 'acme.agent',
            agent: {
                providerSessionId: 'external_vendor_session',
            },
        } as const;

        expect(
            buildSessionHandoffRecoveryPlan({
                handoffId: 'handoff_external_agent',
                sessionId: 'session_external_agent',
                sourceMachineId: 'machine_1',
                sourceMetadata: {
                    host: 'machine.local',
                    path: '/workspace',
                    runtimeDescriptorV1,
                } satisfies Metadata,
                sessionStorageMode: 'persisted',
            }),
        ).toEqual({
            handoffId: 'handoff_external_agent',
            actions: ['restart_on_source', 'keep_stopped'],
            sourceResume: {
                sessionId: 'session_external_agent',
                machineId: 'machine_1',
                directory: '/workspace',
                agent: 'acme.agent',
                resume: 'external_vendor_session',
                transcriptStorage: 'persisted',
                serverId: null,
                runtimeDescriptorV1,
            },
        });
    });

    it('resolves the recovery agent from agentRuntimeDescriptorV1 when flavor is missing', () => {
        const sourceMetadata = {
            host: 'machine.local',
            path: '/repo',
            agentRuntimeDescriptorV1: {
                v: 1,
                agentId: 'codex',
                agent: {
                    backendMode: 'appServer',
                    providerSessionId: 'thread_runtime',
                },
            },
        } as Metadata;

        expect(
            buildSessionHandoffRecoveryPlan({
                handoffId: 'handoff_3',
                sessionId: 'session_3',
                sourceMachineId: 'machine_source',
                sourceMetadata,
                sessionStorageMode: 'persisted',
            }),
        ).toEqual({
            handoffId: 'handoff_3',
            actions: ['restart_on_source', 'keep_stopped'],
            sourceResume: {
                sessionId: 'session_3',
                machineId: 'machine_source',
                directory: '/repo',
                agent: 'codex',
                resume: 'thread_runtime',
                transcriptStorage: 'persisted',
                serverId: null,
                runtimeDescriptorV1: sourceMetadata.agentRuntimeDescriptorV1,
            },
        });
    });

    it('preserves legacy OpenCode server env in the recovery plan when only legacy metadata is present', () => {
        const sourceMetadata = {
            flavor: 'opencode',
            host: 'machine.local',
            path: '/repo',
            opencodeSessionId: 'remote_opencode_session',
            opencodeBackendMode: 'server',
            opencodeServerBaseUrl: 'http://127.0.0.1:4096/',
            opencodeServerBaseUrlExplicit: true,
            externalSessionOperationV1: {
                v: 1,
                progress: { operationId: 'owner-operation-private' },
            },
            externalSessionOperationPresentationV1: {
                v: 1,
                operationId: 'shared-operation-private',
            },
            unrelatedOwnerOnlySentinel: 'must-not-reach-agent-code',
        } satisfies Metadata;

        expect(
            buildSessionHandoffRecoveryPlan({
                handoffId: 'handoff_4',
                sessionId: 'session_4',
                sourceMachineId: 'machine_source',
                sourceMetadata,
                sessionStorageMode: 'persisted',
            }),
        ).toEqual({
            handoffId: 'handoff_4',
            actions: ['restart_on_source', 'keep_stopped'],
            sourceResume: expect.objectContaining({
                agent: 'opencode',
                resume: 'remote_opencode_session',
                environmentVariables: {
                    HAPPIER_OPENCODE_BACKEND_MODE: 'server',
                    HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:4096/',
                    HAPPIER_OPENCODE_SERVER_URL_EXPLICIT: '1',
                },
            }),
        });

        const projectedMetadata = {
            path: '/repo',
            opencodeSessionId: 'remote_opencode_session',
            opencodeBackendMode: 'server',
            opencodeServerBaseUrl: 'http://127.0.0.1:4096/',
            opencodeServerBaseUrlExplicit: true,
        };
        expect(resolveVendorHandoffIdMetadataMock).toHaveBeenCalled();
        for (const [metadata] of resolveVendorHandoffIdMetadataMock.mock.calls) {
            expect(metadata).toEqual(projectedMetadata);
        }
        expect(buildSourceRecoveryResumePatchMetadataMock)
            .toHaveBeenCalledWith(projectedMetadata);
    });

    it('normalizes legacy codex backend mode metadata onto the canonical codexBackendMode field', () => {
        const legacyCodexBackendMode = '  mcp_resume  ' as unknown as Metadata['codexBackendMode'];
        const sourceMetadata = {
            flavor: 'codex',
            path: '/repo',
            codexBackendMode: legacyCodexBackendMode,
        } as Metadata;

        expect(
            buildSessionHandoffRecoveryPlan({
                handoffId: 'handoff_5',
                sessionId: 'session_5',
                sourceMachineId: 'machine_source',
                sourceMetadata,
                sessionStorageMode: 'persisted',
            }),
        ).toMatchObject({
            handoffId: 'handoff_5',
            sourceResume: {
                agent: 'codex',
                directory: '/repo',
                codexBackendMode: 'acp',
            },
        });
    });
});
