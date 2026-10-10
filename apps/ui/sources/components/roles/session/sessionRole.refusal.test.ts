import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

const { describeSessionRoleRefusal } = await import('./sessionRole');

describe('a refused session-role write', () => {
    it('explains a hands-off role this agent cannot enforce and what to do next, never the raw code', () => {
        const refusal = describeSessionRoleRefusal({ ok: false, errorCode: 'role_policy_unenforceable', error: 'role_policy_unenforceable' });

        expect(refusal.title).toBe('roles.session.refusal.unenforceableTitle');
        expect(refusal.message).toBe('roles.session.refusal.unenforceableBody');
        expect(`${refusal.title} ${refusal.message}`).not.toContain('role_policy_unenforceable');
    });

    it('tells apart a policy that applies after a restart from one that cannot apply at all', () => {
        const restart = describeSessionRoleRefusal({ ok: false, errorCode: 'role_policy_restart_required', error: 'role_policy_restart_required' });

        expect(restart.title).toBe('roles.session.refusal.restartRequiredTitle');
        expect(restart.message).not.toContain('role_policy_restart_required');
    });

    it('names a role that is no longer available', () => {
        expect(describeSessionRoleRefusal({ ok: false, errorCode: 'role_target_unavailable', error: 'role_target_unavailable' }).title)
            .toBe('roles.session.refusal.roleUnavailableTitle');
    });

    it('keeps the generic failure and its detail for a refusal it has no words for', () => {
        expect(describeSessionRoleRefusal({ ok: false, errorCode: 'transport_error', error: 'The daemon did not answer' }))
            .toEqual({ title: 'roles.session.saveFailed', message: 'The daemon did not answer' });
    });
});
