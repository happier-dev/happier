import { describe, expect, it } from 'vitest';

import {
    claudeExternalSessionTakeoverContribution,
    resolveClaudeExternalSessionTakeoverPlan,
} from './takeover.js';

describe('Claude External Sessions takeover launch derivation', () => {
    it('returns only the canonical Claude config environment', () => {
        const plan = resolveClaudeExternalSessionTakeoverPlan({
            remoteSessionId: 'claude-session-current',
            source: {
                kind: 'claudeConfig',
                configDir: ' /home/user/.claude-current ',
                projectId: 'project-1',
            },
            linkData: { projectId: 'project-1' },
            linkedDirectory: ' /repo/project ',
        });

        // The launch plan carries no cwd authority: the host enforces the
        // request targetDirectory as the spawned process cwd.
        expect(plan).toEqual({
            environmentVariables: {
                CLAUDE_CONFIG_DIR: '/home/user/.claude-current',
            },
        });
        expect(plan).not.toHaveProperty('directory');
        expect(plan).not.toHaveProperty('backendModeHint');
        expect(plan).not.toHaveProperty('existingSessionId');
        expect(plan).not.toHaveProperty('resume');
        expect(plan).not.toHaveProperty('sessionStateUpdates');
        expect(plan).not.toHaveProperty('transcriptStorage');
    });

    it('fails closed when fresh linked identity is incomplete or inconsistent', () => {
        expect(resolveClaudeExternalSessionTakeoverPlan({
            remoteSessionId: 'claude-session-current',
            source: {
                kind: 'claudeConfig',
                configDir: '/home/user/.claude-current',
                projectId: 'project-1',
            },
            linkData: { projectId: 'project-2' },
            linkedDirectory: '/repo/project',
        })).toBeNull();

        expect(resolveClaudeExternalSessionTakeoverPlan({
            remoteSessionId: 'claude-session-current',
            source: {
                kind: 'claudeConfig',
                configDir: '/home/user/.claude-current',
                projectId: 'project-1',
            },
            linkData: { projectId: 'project-1' },
        })).toBeNull();
    });

    it('exposes the exact one-callback contribution and honors cancellation', async () => {
        const controller = new AbortController();
        controller.abort();

        await expect(Promise.resolve(
            claudeExternalSessionTakeoverContribution.resolveLaunch({
                signal: controller.signal,
                deadlineAtMs: Date.now() + 15_000,
                maxSerializedBytes: 262_144,
                linkedSessionId: 'happier-session-1',
                remoteSessionId: 'claude-session-current',
                source: {
                    kind: 'claudeConfig',
                    configDir: '/home/user/.claude-current',
                    projectId: 'project-1',
                },
                linkData: { projectId: 'project-1' },
                targetDirectory: '/local/selected/workspace',
                linkedDirectory: '/repo/project',
            }),
        )).resolves.toEqual({ ok: false, code: 'cancelled' });
        expect(Object.keys(claudeExternalSessionTakeoverContribution)).toEqual([
            'resolveLaunch',
        ]);
    });

    it('distinguishes invalid fresh identity from an unavailable linked directory', async () => {
        const base = {
            signal: new AbortController().signal,
            deadlineAtMs: Date.now() + 15_000,
            maxSerializedBytes: 262_144,
            linkedSessionId: 'happier-session-1',
            remoteSessionId: 'claude-session-current',
                source: {
                kind: 'claudeConfig',
                configDir: '/home/user/.claude-current',
                    projectId: 'project-1',
                },
                targetDirectory: '/local/selected/workspace',
            } as const;

        await expect(Promise.resolve(
            claudeExternalSessionTakeoverContribution.resolveLaunch({
                ...base,
                linkData: { projectId: 'project-stale' },
                linkedDirectory: '/repo/project',
            }),
        )).resolves.toEqual({ ok: false, code: 'source_invalid' });
        await expect(Promise.resolve(
            claudeExternalSessionTakeoverContribution.resolveLaunch({
                ...base,
                linkData: { projectId: 'project-1' },
            }),
        )).resolves.toEqual({ ok: false, code: 'unavailable' });
    });
});
