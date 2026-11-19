import { describe, expect, it, vi } from 'vitest';
import type { AgentDaemonSpawnRuntimeSelectionV1 } from '@happier-dev/plugin-sdk/agents/runtime';

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
    it('restores the saved native directory before the daemon default, while honoring an explicit launch selection', () => {
        vi.stubEnv('CLAUDE_CONFIG_DIR', '/daemon-default');
        try {
            const runtimeDescriptorV1 = { v: 1, agentId: 'claude', agent: { configDir: '/saved-account' } };
            expect(augmentClaudeDaemonSpawnEnv({ payload: { runtimeSelection: { runtimeDescriptorV1 } } }))
                .toMatchObject({ CLAUDE_CONFIG_DIR: '/saved-account' });
            expect(augmentClaudeDaemonSpawnEnv({ payload: { runtimeSelection: { runtimeDescriptorV1, env: { OTHER: 'value' } } } }))
                .toMatchObject({ CLAUDE_CONFIG_DIR: '/saved-account' });
            expect(augmentClaudeDaemonSpawnEnv({ payload: { runtimeSelection: { runtimeDescriptorV1, env: { CLAUDE_CONFIG_DIR: '/selected-account' } } } }))
                .toMatchObject({ CLAUDE_CONFIG_DIR: '/selected-account' });
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it('preserves the materialized requester auth home instead of the shared daemon home', () => {
        vi.stubEnv('CLAUDE_CONFIG_DIR', '/daemon-owner/claude');
        try {
            const runtimeSelection = {
                runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: { configDir: '/saved-account' } },
                env: { CLAUDE_CONFIG_DIR: '/requester/private/claude' },
            } satisfies AgentDaemonSpawnRuntimeSelectionV1;

            expect(augmentClaudeDaemonSpawnEnv({
                payload: { agentId: 'claude', runtimeSelection },
            })).toEqual({ CLAUDE_CONFIG_DIR: '/requester/private/claude' });
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it('does not force CLAUDE_CONFIG_DIR when no override is set', () => {
        expect(augmentClaudeDaemonSpawnEnv({
            payload: { runtimeSelection: {
                env: {},
            } },
        })).toEqual({});
    });

    it('publishes an explicit CLAUDE_CONFIG_DIR override when set', () => {
        expect(augmentClaudeDaemonSpawnEnv({
            payload: { runtimeSelection: {
                env: {
                    CLAUDE_CONFIG_DIR: '/tmp/claude-config',
                },
            } },
        })).toEqual({
            CLAUDE_CONFIG_DIR: '/tmp/claude-config',
        });
    });

    it('prefers CLAUDE_CONFIG_DIR over HAPPIER_CLAUDE_CONFIG_DIR', () => {
        expect(augmentClaudeDaemonSpawnEnv({
            payload: { runtimeSelection: {
                env: {
                    CLAUDE_CONFIG_DIR: ' /tmp/claude-primary ',
                    HAPPIER_CLAUDE_CONFIG_DIR: '/tmp/claude-secondary',
                },
            } },
        })).toEqual({
            CLAUDE_CONFIG_DIR: '/tmp/claude-primary',
        });
    });

    it('preserves only Claude\'s exact external sandbox assertion for the session runner', () => {
        expect(augmentClaudeDaemonSpawnEnv({
            payload: { runtimeSelection: {
                env: {
                    IS_SANDBOX: '1',
                },
            } },
        })).toEqual({
            IS_SANDBOX: '1',
        });

        expect(augmentClaudeDaemonSpawnEnv({
            payload: { runtimeSelection: {
                env: {
                    IS_SANDBOX: '0',
                },
            } },
        })).toEqual({});
    });
});
