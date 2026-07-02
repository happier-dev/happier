import { describe, expect, it } from 'vitest';

import { buildClaudeRuntimeLocalHandoffMetadata } from './runtimeLocalMetadata.js';

describe('buildClaudeRuntimeLocalHandoffMetadata', () => {
    it('builds runtime-local Claude direct-session metadata from narrow session input', () => {
        expect(buildClaudeRuntimeLocalHandoffMetadata({
            metadata: {
                machineId: 'machine-1',
                path: '/repo/project',
            },
            session: {
                vendorResumeId: 'claude-session-1',
                spawnOptions: {
                    transcriptStorage: 'direct',
                    environmentVariables: {
                        CLAUDE_CONFIG_DIR: '/tmp/native-claude',
                        HAPPIER_CLAUDE_CONFIG_DIR: '/tmp/happier-claude',
                    },
                },
            },
            nowMs: 123,
            env: {
                CLAUDE_CONFIG_DIR: '/tmp/process-claude',
            },
        })).toEqual({
            claudeSessionId: 'claude-session-1',
            externalSessionV1: {
                v: 1,
                providerId: 'claude',
                machineId: 'machine-1',
                remoteSessionId: 'claude-session-1',
                source: {
                    kind: 'claudeConfig',
                    configDir: '/tmp/native-claude',
                    projectId: '-repo-project',
                },
                linkedAtMs: 123,
            },
        });
    });

    it('falls back to the explicit vendor resume id before session fields', () => {
        expect(buildClaudeRuntimeLocalHandoffMetadata({
            metadata: {
                machineId: 'machine-1',
                path: '/repo/project',
            },
            session: {
                vendorResumeId: 'stale-session',
                spawnOptions: {
                    resume: 'spawn-session',
                    transcriptStorage: 'persisted',
                },
            },
            vendorResumeId: 'explicit-session',
        })).toEqual({
            claudeSessionId: 'explicit-session',
        });
    });
});
