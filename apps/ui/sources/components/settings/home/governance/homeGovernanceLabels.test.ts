import { beforeEach, describe, expect, it, vi } from 'vitest';
import { adoptPersonalHomeProfileAndComplete, listServerProfiles, removeServerProfile, upsertServerProfile } from '@/sync/domains/server/serverProfiles';

// `t` is a genuine module boundary owned by the testkit. Mocking it here keeps
// these assertions about which message a failure maps to, rather than about the
// wording of one locale, which is not this owner's contract.
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

import { HappyError } from '@/utils/errors/errors';

import { accountErasureFailureNotice, homeDisplayName, homeGovernanceFailureNotice } from './homeGovernanceLabels';

beforeEach(async () => {
    for (const profile of listServerProfiles()) await removeServerProfile(profile.id);
});

describe('homeDisplayName', () => {
    it('names a Home the way the rest of the app does, never by its address when a name exists', async () => {
        const named = await upsertServerProfile({ name: 'Studio', serverUrl: 'https://studio.example' });
        const personal = await adoptPersonalHomeProfileAndComplete({
            descriptor: { serverUrl: 'http://127.0.0.1:53288', homeServerIdentityId: 'srv_personal' },
            source: 'desktop-personal-home',
        });
        const unnamed = await upsertServerProfile({ name: 'unnamed.example', serverUrl: 'https://unnamed.example' });

        expect(homeDisplayName(named.id)).toBe('Studio');
        // The Personal Home of this device is "Personal Home", not the host it happens to run on.
        expect(homeDisplayName(personal.id)).toBe('personalHome.settings.defaultHomeLabel');
        // Unnamed and unavailable Homes still get a human title, never an address or storage id.
        expect(homeDisplayName(unnamed.id)).toBe('settingsAccount.thisHomeTitle');
        expect(homeDisplayName('home-unknown')).toBe('settingsAccount.thisHomeTitle');
    });
});

describe('accountErasureFailureNotice', () => {
    it('explains encryption cleanup pending before erasure as retryable without claiming retirement', () => {
        const failure = { kind: 'conflict', retryable: true, code: 'account_erasure_transition_cleanup_pending' } as const;
        const notice = homeGovernanceFailureNotice(failure);
        expect(notice.body).toBe('homeGovernance.errorErasureTransitionCleanupPending');
        expect(accountErasureFailureNotice(new HappyError(failure.code, true, {
            status: 409, kind: 'server', code: failure.code,
        }))).toEqual(notice);
    });

    it('tells the last owner to transfer ownership instead of inviting a retry', () => {
        const home = accountErasureFailureNotice(new HappyError('home_owner_transfer_required', true, {
            status: 409, kind: 'server', code: 'home_owner_transfer_required',
        }));
        expect(home.title).toBe('homeGovernance.changeFailedTitle');
        expect(home.body).toBe('homeGovernance.errorOwnerTransferRequired');

        expect(accountErasureFailureNotice(new HappyError('team_owner_transfer_required', true, {
            status: 409, kind: 'server', code: 'team_owner_transfer_required',
        })).body).toBe('homeGovernance.errorTeamOwnerTransferRequired');
    });

    it('keeps the unconfirmed-deletion notice when the answer carries no typed verdict', () => {
        const unconfirmed = {
            title: 'settingsAccount.deleteAccountFailedTitle',
            body: 'settingsAccount.deleteAccountFailed',
        };
        expect(accountErasureFailureNotice(new TypeError('network down'))).toEqual(unconfirmed);
        expect(accountErasureFailureNotice(new HappyError('account_delete_failed', true, {
            status: 502, kind: 'server', code: 'account_delete_failed',
        }))).toEqual(unconfirmed);
        expect(accountErasureFailureNotice(new HappyError('outcome_unknown', false, {
            code: 'outcome_unknown',
        }))).toEqual(unconfirmed);
    });

    it('presents a known Action refusal instead of claiming the deletion outcome is unknown', () => {
        expect(accountErasureFailureNotice(new HappyError('credential_scope_denied', false, {
            code: 'credential_scope_denied',
        }))).toEqual({ title: 'homeGovernance.changeFailedTitle', body: 'errors.permissionDenied' });
    });
});

describe('homeGovernanceFailureNotice', () => {
    it('keeps an unclassified read failure distinct from a refused mutation', () => {
        const failure = { kind: 'unknown', retryable: true, code: null } as const;
        expect(homeGovernanceFailureNotice(failure, { effect: 'read' })).toEqual({
            title: 'homeGovernance.unavailableTitle', body: 'homeGovernance.unavailableBody',
        });
        expect(homeGovernanceFailureNotice(failure)).toEqual({
            title: 'homeGovernance.changeFailedTitle', body: 'homeGovernance.errorGeneric',
        });
    });

    it('never introduces an unconfirmed mutation as one that did not happen', () => {
        const notice = homeGovernanceFailureNotice({
            kind: 'outcome_unknown',
            retryable: false,
            code: null,
        });

        // The Home received the request and its answer was lost. Both the title
        // and the body have to leave that open, because the administrator's next
        // press would be a second non-idempotent governance mutation.
        expect(notice.title).toBe('homeGovernance.errorOutcomeUnknownTitle');
        expect(notice.body).toBe('homeGovernance.errorOutcomeUnknown');
    });

    it('prefers the Home’s own typed reason over the transport verdict', () => {
        // A 409 carrying the last-owner rule is a conflict *and* a named reason.
        // The named reason is the actionable one, so it wins.
        expect(homeGovernanceFailureNotice({
            kind: 'conflict',
            retryable: false,
            code: 'home_owner_transfer_required',
        }).body).toBe('homeGovernance.errorOwnerTransferRequired');
        expect(homeGovernanceFailureNotice({
            kind: 'forbidden', retryable: false, code: 'credential_scope_denied',
        }).body).toBe('errors.permissionDenied');
    });

    it('explains an untyped conflict as a Home that moved, not as a change that failed', () => {
        expect(homeGovernanceFailureNotice({
            kind: 'conflict',
            retryable: false,
            code: null,
        }).body).toBe('homeGovernance.errorConflict');
    });
});
