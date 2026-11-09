import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { FastifyRequest } from 'fastify';
import { requireRouteActionAuthority } from './requireRouteActionAuthority';

async function invoke(actionId: ActionId, authTokenKind: 'account' | 'terminal' | 'api_token',
    authAuthority: 'account_automation' | 'present_user', body: Record<string, unknown> = {},
    signed: Pick<FastifyRequest, 'externalActionExecutionAuthorized' | 'externalActionEffectActionId' | 'externalActionExecutionTarget'> = {}) {
    const app = Fastify();
    // Authentication is the upstream network boundary. Keep the real route
    // guard and its canonical Action admission beneath the verified projection.
    app.decorateRequest('authTokenKind', 'account');
    app.decorateRequest('authAuthority', 'account_automation');
    app.addHook('onRequest', async request => {
        request.authTokenKind = authTokenKind;
        request.authAuthority = authAuthority;
        Object.assign(request, signed);
    });
    app.post('/:sessionId', { preHandler: requireRouteActionAuthority(actionId) }, async () => ({ admitted: true }));
    try {
        const response = await app.inject({ method: 'POST', url: '/session-1', payload: body });
        return { status: response.statusCode, body: response.json() };
    } finally {
        await app.close();
    }
}

describe('Action route authority', () => {
    it.each(['account', 'terminal'] as const)('admits an automation-authority %s for the ordinary Discussion model reservation', async kind => {
        expect(await invoke('discussion.invite', kind, 'account_automation')).toEqual({
            status: 200, body: { admitted: true },
        });
    });

    it.each(['account', 'terminal'] as const)('admits the person-class %s credential whatever its per-invocation ceiling', async kind => {
        // The host Action executor's approval policy gates agent-attributed calls, not this route.
        for (const [actionId, body] of [
            ['approval.request.decide', {}],
            ['session.open', { approvedNewDirectoryCreation: true }],
            ['session.public_link.create', {}],
        ] as const) {
            for (const authority of ['account_automation', 'present_user'] as const) {
                expect(await invoke(actionId, kind, authority, body)).toEqual({
                    status: 200, body: { admitted: true },
                });
            }
        }
    });

    it('does not turn an unsigned API token into direct mutation authority', async () => {
        expect(await invoke('discussion.invite', 'api_token', 'account_automation')).toEqual({
            status: 403, body: { error: 'present_user_required' },
        });
    });

    it('retains exact signed Session authority for API tokens without accepting a different target', async () => {
        for (const sessionId of ['session-1', 'other-session']) {
            expect(await invoke('session.title.set', 'api_token', 'account_automation', {}, {
                externalActionExecutionAuthorized: true, externalActionEffectActionId: 'session.title.set',
                externalActionExecutionTarget: { kind: 'session', sessionId },
            })).toEqual(sessionId === 'session-1'
                ? { status: 200, body: { admitted: true } }
                : { status: 403, body: { error: 'present_user_required' } });
        }
    });
});
