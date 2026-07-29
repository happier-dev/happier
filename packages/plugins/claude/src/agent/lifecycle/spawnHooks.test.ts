import { describe, expect, it, vi } from 'vitest';

import {
    augmentClaudeDaemonSpawnEnv,
    resolveClaudeDaemonSpawnPrerequisites,
} from './spawnHooks.js';

describe('resolveClaudeDaemonSpawnPrerequisites', () => {
    it('resolves Claude through the daemon tool-resolution context', async () => {
        const resolveSystemTool = vi.fn(async () => ({
            ok: true as const,
            command: '/usr/local/bin/claude',
            args: [],
        }));

        await expect(resolveClaudeDaemonSpawnPrerequisites({}, {
            tools: { resolveSystemTool },
        })).resolves.toEqual({ decision: 'allow' });

        expect(resolveSystemTool).toHaveBeenCalledWith(expect.objectContaining({
            toolId: 'claude',
            lookupNames: ['claude'],
            sourcePreference: 'system-first',
        }));
    });

    it('fails closed when the daemon tool-resolution context is unavailable', async () => {
        await expect(resolveClaudeDaemonSpawnPrerequisites({})).resolves.toMatchObject({
            decision: 'deny',
            reasonCode: 'claude_cli_unavailable',
        });
    });

    it('returns daemon tool-resolution failures as typed denials', async () => {
        await expect(resolveClaudeDaemonSpawnPrerequisites({}, {
            tools: {
                resolveSystemTool: async () => ({
                    ok: false as const,
                    errorMessage: 'Claude CLI is missing',
                }),
            },
        })).resolves.toMatchObject({
            decision: 'deny',
            reasonCode: 'claude_cli_unavailable',
            errorMessage: expect.stringContaining('Claude CLI is missing'),
        });
    });
});

describe('augmentClaudeDaemonSpawnEnv', () => {
    it('does not force CLAUDE_CONFIG_DIR when no override is set', () => {
        expect(augmentClaudeDaemonSpawnEnv({
            payload: {
                env: {},
            },
        })).toEqual({});
    });

    it('publishes an explicit CLAUDE_CONFIG_DIR override when set', () => {
        expect(augmentClaudeDaemonSpawnEnv({
            payload: {
                env: {
                    CLAUDE_CONFIG_DIR: '/tmp/claude-config',
                },
            },
        })).toEqual({
            CLAUDE_CONFIG_DIR: '/tmp/claude-config',
        });
    });

    it('prefers CLAUDE_CONFIG_DIR over HAPPIER_CLAUDE_CONFIG_DIR', () => {
        expect(augmentClaudeDaemonSpawnEnv({
            payload: {
                env: {
                    CLAUDE_CONFIG_DIR: ' /tmp/claude-primary ',
                    HAPPIER_CLAUDE_CONFIG_DIR: '/tmp/claude-secondary',
                },
            },
        })).toEqual({
            CLAUDE_CONFIG_DIR: '/tmp/claude-primary',
        });
    });
});
