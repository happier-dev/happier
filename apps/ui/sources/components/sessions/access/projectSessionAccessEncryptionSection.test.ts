import type { SessionDataKeyEnvelopeItemV1 } from '@happier-dev/protocol/sessions/encryption/sessionDataKeyEnvelopes';
import { describe, expect, it } from 'vitest';

import type {
    SessionAccessEncryptionPreparation,
    SessionAccessEncryptionRecipientsState,
} from './sessionAccessEditorState';
import { projectSessionAccessEncryptionSection } from './projectSessionAccessEncryptionSection';

const summary = { prepared: 0, pending: 0, invalid: 0, recipientKeyUnavailable: 0 };
const COLLAPSED: SessionAccessEncryptionRecipientsState = {
    view: 'exceptions', rows: [], nextCursor: null, loading: false, error: null,
};

function settled(
    status: Extract<SessionAccessEncryptionPreparation, { kind: 'settled' }>['status'],
    overrides?: Partial<typeof summary> | null,
): SessionAccessEncryptionPreparation {
    return { kind: 'settled', status, summary: overrides === null ? null : { ...summary, ...overrides } };
}

function project(
    preparation: SessionAccessEncryptionPreparation,
    recipients: SessionAccessEncryptionRecipientsState = COLLAPSED,
    displayNameForAccount: (accountId: string) => string | undefined = () => undefined,
) {
    return projectSessionAccessEncryptionSection({ preparation, recipients, displayNameForAccount });
}

function item(overrides: Partial<SessionDataKeyEnvelopeItemV1> & Pick<SessionDataKeyEnvelopeItemV1, 'recipientAccountId'>): SessionDataKeyEnvelopeItemV1 {
    return {
        envelopeState: 'prepared',
        contentKey: {
            status: 'available',
            accountSigningPublicKey: 'signing',
            contentPublicKey: 'content',
            contentPublicKeySignature: 'signature',
        },
        ...overrides,
    } as SessionDataKeyEnvelopeItemV1;
}

describe('projectSessionAccessEncryptionSection', () => {
    it('says nothing at all about a Session that needs no recipient keys', () => {
        expect(project({ kind: 'idle' })).toBeUndefined();
        // A plain Session and a Session the viewer navigated away from both settle
        // without a claim about the audience now on screen.
        expect(project(settled('not_required', null))).toBeUndefined();
        expect(project(settled('scope_changed', null))).toBeUndefined();
    });

    it('stays quiet for a healthy audience but keeps the diagnostic reachable', () => {
        const healthy = project(settled('complete', { prepared: 12 }));
        expect(healthy?.summaryLabel).toBe('Ready for everyone with access');
        expect(healthy?.accessibilityLabel).toBe('Encrypted access: Ready for everyone with access');
        // Nothing to act on, so no action — but inspection must not require a defect.
        expect(healthy?.actionLabel).toBeUndefined();
        expect(healthy?.showAllLabel).toBe('Show encryption per person');
        expect(healthy?.recipients).toBeUndefined();
    });

    it('renders the Home aggregate rather than anything counted from grant rows', () => {
        const aggregate = project(settled('incomplete', {
            prepared: 42, pending: 3, invalid: 1, recipientKeyUnavailable: 0,
        }));
        expect(aggregate?.summaryLabel).toBe('42 prepared · 3 pending · 1 needs setup or repair');
        // Replacing structurally invalid bytes is a repeat of the same delivery.
        expect(aggregate?.actionLabel).toBe('Prepare again');

        const pendingOnly = project(settled('incomplete', { prepared: 4, pending: 2 }));
        expect(pendingOnly?.summaryLabel).toBe('4 prepared · 2 pending');
        expect(pendingOnly?.actionLabel).toBe('Prepare now');

        // Setup-required Accounts join the same needs-attention segment as invalid bytes,
        // so a manager sees one honest total instead of a single winning category.
        expect(project(settled('incomplete', { prepared: 1, pending: 3, invalid: 2, recipientKeyUnavailable: 1 }))?.summaryLabel)
            .toBe('1 prepared · 3 pending · 3 need setup or repair');
    });

    it('separates a device that cannot prepare from an audience that is ready', () => {
        const unavailable = project(settled('session_data_key_unavailable', null));
        expect(unavailable?.reason?.code).toBe('session_access_encryption_key_unavailable');
        expect(unavailable?.actionLabel).toBeUndefined();
        // No summary was ever observed, so the line must come from the status alone.
        expect(unavailable?.summaryLabel).not.toContain('0');
    });

    it('shows committed progress against the Home total and never invents one', () => {
        expect(project({ kind: 'preparing', preparedCount: 0, actionableTotal: null })?.progressLabel)
            .toBe('Preparing encrypted access…');
        expect(project({ kind: 'preparing', preparedCount: 12, actionableTotal: 18 })?.progressLabel)
            .toBe('Preparing encrypted access… 12 of 18');
        // A spinner is owed only while this client is observed working.
        expect(project(settled('incomplete', { pending: 2 }))?.progressLabel).toBeUndefined();
    });

    it('keeps a failed preparation legible and retryable without blaming the grant', () => {
        const failure = { code: 'session_access_failed', message: 'boom', retryable: true };
        const failed = project({ kind: 'failed', origin: 'pass', error: failure });
        expect(failed?.error).toBe(failure);
        expect(failed?.actionLabel).toBe('Try again');
        expect(failed?.summaryLabel).not.toBe('boom');
        // Only a pass that followed a committed mutation may claim the save happened.
        expect(failed?.summaryLabel).toBe('Access was saved, but preparing encrypted access failed.');
    });

    it('does not claim a save happened when only the opening discovery read failed', () => {
        const failure = { code: 'session_access_failed', message: 'boom', retryable: true };
        const failed = project({ kind: 'failed', origin: 'discovery', error: failure });
        expect(failed?.summaryLabel).toBe("Couldn't check encrypted access.");
        expect(failed?.actionLabel).toBe('Try again');
        expect(failed?.error).toBe(failure);
    });

    it('does not claim a save happened when the manager started the pass themselves', () => {
        const failure = { code: 'session_access_failed', message: 'boom', retryable: true };
        const failed = project({ kind: 'failed', origin: 'manual', error: failure });
        expect(failed?.summaryLabel).toBe('Preparing encrypted access failed.');
        expect(failed?.actionLabel).toBe('Try again');
        expect(failed?.error).toBe(failure);
    });

    it('offers the repeat action on every row that can be re-sealed, and none on one that cannot', () => {
        const rows = project(settled('incomplete', { prepared: 1, pending: 1, invalid: 1 }), {
            view: 'all',
            rows: [
                item({ recipientAccountId: 'account-ready' }),
                item({ recipientAccountId: 'account-pending', envelopeState: 'missing' }),
                item({ recipientAccountId: 'account-invalid', envelopeState: 'invalid' }),
                item({
                    recipientAccountId: 'account-setup',
                    contentKey: { status: 'unavailable', reason: 'encryption_setup_required' },
                }),
            ],
            nextCursor: null,
            loading: false,
            error: null,
        })?.recipients?.rows ?? [];

        // `prepared` proves shape only — the Home cannot tell whether the recipient can
        // still open it — so a delivered row keeps a repeat affordance for the manager to
        // replace ciphertext the recipient cannot open. A recipient who has not finished
        // encryption setup can only be explained, not repaired.
        expect(rows.map((row) => [row.state, row.actionLabel])).toEqual([
            ['prepared', 'Prepare again'],
            ['pending', 'Prepare now'],
            ['invalid', 'Prepare again'],
            ['encryption_setup_required', undefined],
        ]);
    });

    it('lists discovered exceptions beneath the aggregate without opening the all-people view', () => {
        const section = project(settled('incomplete', { pending: 1 }), {
            ...COLLAPSED,
            rows: [item({ recipientAccountId: 'account-pending', envelopeState: 'missing' })],
        });

        expect(section?.recipientsView).toBe('exceptions');
        expect(section?.showAllLabel).toBe('Show encryption per person');
        expect(section?.recipients?.rows.map((row) => [row.label, row.state])).toEqual([['account-pending', 'pending']]);
        // A healthy audience lists nobody: the quiet ready line is the whole section.
        expect(project(settled('complete'), COLLAPSED)?.recipients).toBeUndefined();
    });

    it('does not offer delivery for unavailable Account keys, while retaining real tuple repair', () => {
        const section = project(settled('incomplete', { recipientKeyUnavailable: 3 }), {
            ...COLLAPSED,
            rows: ['encryption_inconsistent', 'encryption_setup_required', 'plain_account'].map((reason) => item({
                recipientAccountId: reason,
                contentKey: { status: 'unavailable', reason: reason as 'encryption_inconsistent' | 'encryption_setup_required' | 'plain_account' },
            })),
        });
        expect(section?.actionLabel).toBeUndefined();
        expect(section?.recipients?.rows.every((row) => row.actionLabel === undefined)).toBe(true);
        expect(project(settled('incomplete', { invalid: 1, recipientKeyUnavailable: 3 }))?.actionLabel).toBeDefined();
    });

    it('projects the all-people diagnostic rows with their exact per-Account state', () => {
        const expanded = project(settled('incomplete', { prepared: 1, pending: 1, recipientKeyUnavailable: 1 }), {
            view: 'all',
            rows: [
                item({ recipientAccountId: 'account-ready' }),
                item({ recipientAccountId: 'account-pending', envelopeState: 'missing' }),
                item({
                    recipientAccountId: 'account-plain',
                    // An inert tuple left on a Plain Account is not delivery: readiness wins.
                    envelopeState: 'prepared',
                    contentKey: { status: 'unavailable', reason: 'plain_account' },
                }),
            ],
            nextCursor: 'cursor-1',
            loading: false,
            error: null,
        }, (accountId) => accountId === 'account-ready' ? 'Ada Lovelace' : undefined);

        expect(expanded?.showAllLabel).toBe('Hide encryption per person');
        expect(expanded?.recipients?.hasMore).toBe(true);
        expect(expanded?.recipients?.rows.map((row) => [row.label, row.state, row.stateLabel])).toEqual([
            ['Ada Lovelace', 'prepared', 'Encrypted access prepared'],
            ['account-pending', 'pending', 'Encrypted access pending'],
            ['account-plain', 'plain_account', 'Account without encryption'],
        ]);
    });
});
