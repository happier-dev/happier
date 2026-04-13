import { describe, expect, it } from 'vitest';

import { buildHandoffSessionMetadataFromTrackedSession } from './buildHandoffSessionMetadataFromTrackedSession';

describe('buildHandoffSessionMetadataFromTrackedSession', () => {
    it('falls back to the persisted handoff overlay when the tracked session lost its webhook metadata', () => {
        const metadata = buildHandoffSessionMetadataFromTrackedSession({
            trackedSession: {
                startedBy: 'daemon',
                pid: 123,
                happySessionId: 'sess_handoff_overlay_only',
                vendorResumeId: 'sess-handoff-direct',
            } as never,
            machineId: 'machine-session-handoff',
            localExportMetadataOverlay: {
                machineId: 'machine-session-handoff',
                path: '/repo-source-current',
                homeDir: '/Users/target',
                flavor: 'claude',
                handoffV1: {
                    v: 1,
                    sourceMachineId: 'machine_source',
                    targetMachineId: 'machine-session-handoff',
                    providerId: 'claude',
                    sessionStorageBefore: 'direct',
                    sessionStorageAfter: 'direct',
                    transportStrategy: 'direct_peer',
                    completedAtMs: 1,
                    sourceWorkspaceRootPath: '/repo-source-origin',
                    targetWorkspaceRootPath: '/repo-source-current',
                },
            },
        });

        expect(metadata).toEqual(expect.objectContaining({
            exportMetadata: expect.objectContaining({
                machineId: 'machine-session-handoff',
                path: '/repo-source-current',
                homeDir: '/Users/target',
                flavor: 'claude',
                handoffV1: expect.objectContaining({
                    sourceMachineId: 'machine_source',
                    targetMachineId: 'machine-session-handoff',
                }),
            }),
            runtimeLocalMetadata: expect.objectContaining({
                claudeSessionId: 'sess-handoff-direct',
            }),
        }));
    });

    it('builds configured ACP fallback metadata when webhook metadata is missing', () => {
        const metadata = buildHandoffSessionMetadataFromTrackedSession({
            trackedSession: {
                startedBy: 'daemon',
                pid: 234,
                happySessionId: 'sess_configured_acp_fallback',
                spawnOptions: {
                    directory: '/repo-acp',
                    backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
                    environmentVariables: { HOME: '/Users/acp-home' },
                },
            } as never,
            machineId: 'machine-acp-fallback',
            fallbackHomeDir: '/Users/fallback',
        });

        expect(metadata).toEqual(expect.objectContaining({
            exportMetadata: expect.objectContaining({
                machineId: 'machine-acp-fallback',
                path: '/repo-acp',
                homeDir: '/Users/acp-home',
                flavor: 'acp:review-bot',
                acpConfiguredBackendV1: expect.objectContaining({
                    v: 1,
                    backendId: 'review-bot',
                    title: 'review-bot',
                    updatedAt: expect.any(Number),
                }),
            }),
        }));
    });
});
