import { describe, expect, it } from 'vitest';

import type { Message } from '@/sync/domains/messages/messageTypes';

import { deriveSessionSubagentPendingPermissionIds } from './deriveSessionSubagentPendingPermissions';
import type { SessionSubagent } from './types';

function makeSubagent(overrides: Partial<SessionSubagent> & Pick<SessionSubagent, 'id'>): SessionSubagent {
    return {
        kind: 'subagent_sidechain',
        status: 'running',
        display: { title: overrides.id },
        transcript: {},
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
        ...overrides,
    };
}

function makeToolCall(params: Readonly<{
    id: string;
    toolId: string;
    permissionStatus?: 'pending' | 'approved';
    permissionKind?: string;
    permissionId?: string;
    children?: readonly Message[];
}>): Message {
    return {
        kind: 'tool-call',
        id: params.id,
        localId: null,
        createdAt: 1,
        tool: {
            id: params.toolId,
            name: 'SubAgent',
            state: 'running',
            input: {},
            createdAt: 1,
            startedAt: 1,
            completedAt: null,
            description: null,
            ...(params.permissionStatus
                ? {
                    permission: {
                        id: params.permissionId ?? `${params.toolId}-permission`,
                        status: params.permissionStatus,
                        kind: params.permissionKind ?? 'permission',
                    },
                }
                : {}),
        },
        children: params.children ?? [],
    } as unknown as Message;
}

describe('deriveSessionSubagentPendingPermissionIds', () => {
    const alpha = makeSubagent({
        id: 'subagent_sidechain:toolu_alpha',
        transcript: { sidechainId: 'toolu_alpha', toolId: 'toolu_alpha', toolMessageRouteId: 'tool-msg-1' },
    });

    it('reports the subagent whose loaded sidechain carries a pending permission', () => {
        expect([...deriveSessionSubagentPendingPermissionIds({
            subagents: [alpha],
            reducerState: {
                sidechains: new Map([
                    ['toolu_alpha', [{ tool: { permission: { id: 'perm-1', status: 'pending', kind: 'permission' } } }]],
                ]),
                permissions: new Map(),
            },
        })]).toEqual([alpha.id]);
    });

    it('prefers the reducer permission table over the status the message was written with', () => {
        expect(deriveSessionSubagentPendingPermissionIds({
            subagents: [alpha],
            reducerState: {
                sidechains: new Map([
                    ['toolu_alpha', [{ tool: { permission: { id: 'perm-1', status: 'pending', kind: 'permission' } } }]],
                ]),
                permissions: new Map([['perm-1', { status: 'approved' }]]),
            },
        }).has(alpha.id)).toBe(false);
    });

    it('ignores pending user-action prompts, which are not permission requests', () => {
        expect(deriveSessionSubagentPendingPermissionIds({
            subagents: [alpha],
            reducerState: {
                sidechains: new Map([
                    ['toolu_alpha', [{ tool: { permission: { id: 'perm-1', status: 'pending', kind: 'user_action' } } }]],
                ]),
                permissions: new Map(),
            },
        }).has(alpha.id)).toBe(false);
    });

    it('falls back to the subagent tool call children when its sidechain is not loaded yet', () => {
        const messages: readonly Message[] = [
            makeToolCall({
                id: 'msg-1',
                toolId: 'toolu_alpha',
                children: [makeToolCall({ id: 'msg-1-child', toolId: 'perm-tool-1', permissionStatus: 'pending' })],
            }),
        ];

        expect(deriveSessionSubagentPendingPermissionIds({
            subagents: [alpha],
            reducerState: { sidechains: new Map(), permissions: new Map() },
            messages,
        }).has(alpha.id)).toBe(true);
    });

    it('scopes the transcript fallback to each subagent, never to the whole transcript', () => {
        const beta = makeSubagent({
            id: 'subagent_sidechain:toolu_beta',
            transcript: { sidechainId: 'toolu_beta', toolId: 'toolu_beta' },
        });
        const messages: readonly Message[] = [
            makeToolCall({
                id: 'msg-1',
                toolId: 'toolu_alpha',
                children: [makeToolCall({ id: 'msg-1-child', toolId: 'perm-tool-1', permissionStatus: 'pending' })],
            }),
            makeToolCall({ id: 'msg-2', toolId: 'toolu_beta', children: [] }),
        ];

        const pending = deriveSessionSubagentPendingPermissionIds({
            subagents: [alpha, beta],
            reducerState: { sidechains: new Map(), permissions: new Map() },
            messages,
        });

        expect(pending.has(alpha.id)).toBe(true);
        expect(pending.has(beta.id)).toBe(false);
    });

    /**
     * The defect this owner exists to remove: the per-subagent predicate walked the whole transcript
     * once per subagent. Counting how often the tree is visited is the only way to tell the shared
     * walk from a loop over the old predicate — both produce the same set.
     */
    it('walks the transcript once for a whole roster, not once per subagent', () => {
        const subagents = Array.from({ length: 8 }, (_, index) => makeSubagent({
            id: `subagent_sidechain:toolu_${index}`,
            transcript: { sidechainId: `toolu_${index}`, toolId: `toolu_${index}` },
        }));
        const visits = { count: 0 };
        const messages: readonly Message[] = Array.from({ length: 40 }, (_, index) => {
            const message = makeToolCall({ id: `noise-${index}`, toolId: `noise_${index}` });
            return new Proxy(message as object, {
                get(target, property, receiver) {
                    if (property === 'kind') visits.count += 1;
                    return Reflect.get(target, property, receiver);
                },
            }) as Message;
        });

        deriveSessionSubagentPendingPermissionIds({
            subagents,
            reducerState: { sidechains: new Map(), permissions: new Map() },
            messages,
        });

        // One pass over the 40 top-level messages. A per-subagent search would reach 8 x 40.
        expect(visits.count).toBe(40);
    });

    it('returns an empty set without touching the transcript when there are no subagents', () => {
        // The getter is the assertion: an implementation that reaches for the transcript before it
        // knows anything wants it throws here instead of quietly costing a walk per empty roster.
        const messages = {
            get length(): number { throw new Error('transcript must not be read'); },
        } as unknown as readonly Message[];

        expect(deriveSessionSubagentPendingPermissionIds({
            subagents: [],
            reducerState: { sidechains: new Map(), permissions: new Map() },
            messages,
        }).size).toBe(0);
    });
});
