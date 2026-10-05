import { describe, expect, it } from 'vitest';
import { createSessionAccessFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import type { ToolCallMessage } from '@happier-dev/session-core/messages';
import { planPendingNavigationRoute } from './navigateToPendingRequest';

const address = { serverId: 'home-b', sessionId: 'same' };
const request = { id: 'question', tool: 'AskUserQuestion', kind: 'user_action' as const, arguments: {}, createdAt: 10 };
const target = { address, requestId: request.id, requestKind: request.kind, createdAt: request.createdAt };
const session = createSessionFixture({ id: 'same', serverId: 'home-b', active: true, agentState: {
    requests: { question: { ...request } },
} });
const tool: ToolCallMessage = { kind: 'tool-call', id: 'tool:question', localId: null, seq: 5,
    createdAt: 10, tool: { name: 'AskUserQuestion', state: 'running', input: {}, createdAt: 10,
        startedAt: 10, completedAt: null, description: null,
        permission: { id: 'question', status: 'pending' } }, children: [] };

describe('pending navigation landing revalidation', () => {
    it('retains the confirmation approval requirement when the selected request settles before routing', () => {
        const confirmationTarget = { ...target, requestSource: 'happier_action' };
        const approvalOnly = createSessionFixture({ ...session,
            access: createSessionAccessFixture('owner', { submitAgentInput: false, approveRuntimePermissions: true }),
            agentState: { requests: {} },
        });
        expect(planPendingNavigationRoute({ target: confirmationTarget, nowMs: 20,
            details: { kind: 'available', session: approvalOnly, messages: [], requests: [] } }))
            .toMatchObject({ kind: 'route', state: 'settled' });
        const inputOnly = createSessionFixture({ ...approvalOnly,
            access: createSessionAccessFixture('owner', { submitAgentInput: true, approveRuntimePermissions: false }),
        });
        expect(planPendingNavigationRoute({ target: confirmationTarget, nowMs: 20,
            details: { kind: 'available', session: inputOnly, messages: [], requests: [] } }))
            .toEqual({ kind: 'unavailable' });
    });
    it('revalidates an Action confirmation with its approval grant, not the native-question grant', () => {
        const confirmation = { ...request, source: 'happier_action' };
        const approvalOnly = createSessionFixture({ ...session,
            access: createSessionAccessFixture('owner', { submitAgentInput: false, approveRuntimePermissions: true }),
            agentState: { requests: { question: confirmation } },
        });
        expect(planPendingNavigationRoute({ target, nowMs: 20,
            details: { kind: 'available', session: approvalOnly, messages: [], requests: [confirmation] } }))
            .toEqual({ kind: 'route', route: '/session/same?serverId=home-b', state: 'pending', focusTarget: 'prompt' });
    });
    it('routes a still-answerable request to its real sequence in the exact Home', () => {
        expect(planPendingNavigationRoute({ target, nowMs: 20,
            details: { kind: 'available', session, messages: [tool], requests: [request] } }))
            .toEqual({ kind: 'route', route: '/session/same?jumpSeq=5&serverId=home-b', state: 'pending', focusTarget: 'transcript' });
    });
    it('shows a settled session instead of choosing a different request when answered elsewhere', () => {
        expect(planPendingNavigationRoute({ target, nowMs: 20,
            details: { kind: 'available', session: { ...session, agentState: { requests: {} } }, messages: [], requests: [] } }))
            .toEqual({ kind: 'route', route: '/session/same?serverId=home-b', state: 'settled', focusTarget: 'prompt' });
    });
    it('fails closed for wrong-Home hydration, denied answers, and unavailable detail', () => {
        for (const details of [
            { kind: 'available' as const, session: { ...session, serverId: 'home-a' }, messages: [tool], requests: [request] },
            { kind: 'available' as const, session: { ...session, access: { ...session.access!, capabilities: {
                ...session.access!.capabilities, submitAgentInput: false, approveRuntimePermissions: false,
            } } }, messages: [tool], requests: [request] },
            { kind: 'unavailable' as const, reason: 'offline' },
        ]) expect(planPendingNavigationRoute({ target, nowMs: 20, details }))
            .toEqual({ kind: 'unavailable' });
    });
});
