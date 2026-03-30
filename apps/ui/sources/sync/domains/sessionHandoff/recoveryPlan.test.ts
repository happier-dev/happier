import { describe, expect, it } from 'vitest';

import type { Metadata } from '@/sync/domains/state/storageTypes';

import { buildSessionHandoffRecoveryPlan } from './recoveryPlan';

describe('buildSessionHandoffRecoveryPlan', () => {
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

    it('resolves the recovery agent from agentRuntimeDescriptorV1 when flavor is missing', () => {
        const sourceMetadata = {
            host: 'machine.local',
            path: '/repo',
            agentRuntimeDescriptorV1: {
                v: 1,
                providerId: 'codex',
                provider: {
                    backendMode: 'appServer',
                    vendorSessionId: 'thread_runtime',
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
            sourceResume: expect.objectContaining({
                sessionId: 'session_3',
                machineId: 'machine_source',
                directory: '/repo',
                agent: 'codex',
                resume: 'thread_runtime',
                transcriptStorage: 'persisted',
                agentRuntimeDescriptorV1: sourceMetadata.agentRuntimeDescriptorV1,
            }),
        });
    });

    it('preserves legacy OpenCode server env in the recovery plan when only legacy metadata is present', () => {
        const sourceMetadata = {
            flavor: 'opencode',
            path: '/repo',
            opencodeSessionId: 'remote_opencode_session',
            opencodeBackendMode: 'server',
            opencodeServerBaseUrl: 'http://127.0.0.1:4096/',
            opencodeServerBaseUrlExplicit: true,
        } as Metadata;

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
