import { describe, expect, it } from 'vitest';

import type { Message } from '@/sync/domains/messages/messageTypes';
import type { SessionSubagent } from './types';

describe('deriveSessionSubagentHasPendingPermission', () => {
    const subagent: SessionSubagent = {
        id: 'subagent_sidechain:toolu_alpha',
        kind: 'subagent_sidechain',
        status: 'running',
        display: { title: 'alpha', providerLabel: 'Claude' },
        transcript: { sidechainId: 'toolu_alpha', toolMessageRouteId: 'tool-msg-1', toolId: 'toolu_alpha' },
        recipient: null,
        capabilities: {
            canOpen: true,
            canSend: false,
            canStop: false,
            canLaunchChild: false,
            canDelete: false,
            canOpenAdvancedRun: false,
        },
        timestamps: {},
    };

    it('returns true when the current sidechain permission is pending', async () => {
        const { deriveSessionSubagentHasPendingPermission } = await import('./deriveSessionSubagentHasPendingPermission');

        expect(deriveSessionSubagentHasPendingPermission({
            subagent,
            reducerState: {
                sidechains: new Map([
                    ['toolu_alpha', [
                        {
                            tool: {
                                permission: {
                                    id: 'perm-1',
                                    status: 'pending',
                                    kind: 'permission',
                                },
                            },
                        },
                    ]],
                ]),
                permissions: new Map(),
            },
        })).toBe(true);
    });

    it('returns false when the latest stored permission state is no longer pending', async () => {
        const { deriveSessionSubagentHasPendingPermission } = await import('./deriveSessionSubagentHasPendingPermission');

        expect(deriveSessionSubagentHasPendingPermission({
            subagent,
            reducerState: {
                sidechains: new Map([
                    ['toolu_alpha', [
                        {
                            tool: {
                                permission: {
                                    id: 'perm-1',
                                    status: 'pending',
                                    kind: 'permission',
                                },
                            },
                        },
                    ]],
                ]),
                permissions: new Map([
                    ['perm-1', { status: 'approved' }],
                ]),
            },
        })).toBe(false);
    });

    it('ignores non-permission pending user action prompts', async () => {
        const { deriveSessionSubagentHasPendingPermission } = await import('./deriveSessionSubagentHasPendingPermission');

        expect(deriveSessionSubagentHasPendingPermission({
            subagent,
            reducerState: {
                sidechains: new Map([
                    ['toolu_alpha', [
                        {
                            tool: {
                                permission: {
                                    id: 'perm-1',
                                    status: 'pending',
                                    kind: 'user_action',
                                },
                            },
                        },
                    ]],
                ]),
                permissions: new Map(),
            },
        })).toBe(false);
    });

    it('falls back to the parent transcript children when the sidechain has not been loaded yet', async () => {
        const { deriveSessionSubagentHasPendingPermission } = await import('./deriveSessionSubagentHasPendingPermission');

        const messages: readonly Message[] = [
            {
                kind: 'tool-call',
                id: 'msg-1',
                localId: null,
                createdAt: 1,
                tool: {
                    id: 'toolu_alpha',
                    name: 'SubAgent',
                    state: 'running',
                    input: {},
                    createdAt: 1,
                    startedAt: 1,
                    completedAt: null,
                    description: 'Subagent',
                },
                children: [
                    {
                        kind: 'tool-call',
                        id: 'msg-1-child',
                        localId: null,
                        createdAt: 2,
                        tool: {
                            id: 'perm-tool-1',
                            name: 'bash',
                            state: 'running',
                            input: {},
                            createdAt: 2,
                            startedAt: 2,
                            completedAt: null,
                            description: 'pwd',
                            permission: {
                                id: 'perm-2',
                                status: 'pending',
                                kind: 'permission',
                            },
                        },
                        children: [],
                    },
                ],
            },
        ];

        expect(deriveSessionSubagentHasPendingPermission({
            subagent,
            reducerState: {
                sidechains: new Map(),
                permissions: new Map(),
            },
            messages,
        })).toBe(true);
    });
});
