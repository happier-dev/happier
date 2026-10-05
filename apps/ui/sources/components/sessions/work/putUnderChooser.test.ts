import { describe, expect, it } from 'vitest';

import { createSessionAccessFixture, createSessionFixture } from '@/dev/testkit';
import type { Session } from '@/sync/domains/state/storageTypes';
import { createSessionReportsToEligibilitySnapshot } from '@/sync/ops/relations/sessionReportsToEligibility';

import { describeSessionListDropReason } from '@/components/sessions/shell/dropPreview/sessionListDropPresentation';

import { buildPutUnderChooserSections, PUT_UNDER_TOP_LEVEL_OPTION_ID } from './putUnderChooser';

function session(id: string, overrides: Partial<Session> = {}): Session {
    return createSessionFixture({ id, serverId: 'home', updatedAt: 1, createdAt: 1, archivedAt: null, access: createSessionAccessFixture(), ...overrides });
}

describe('buildPutUnderChooserSections (K1c)', () => {
    const sessions = Object.fromEntries([
        session('self', { reportsTo: { sessionId: 'lead' }, updatedAt: 5 }),
        session('lead', { updatedAt: 4 }),
        session('peer', { updatedAt: 3 }),
        session('readonly', { updatedAt: 2 }),
    ].map((item) => [item.id, item]));
    const facts = createSessionReportsToEligibilitySnapshot({
        serverId: 'home', accountId: 'account', sessionId: 'self', currentLeadSessionId: 'lead',
        candidates: [
            { sessionId: 'lead', allowed: true },
            { sessionId: 'peer', allowed: true },
            { sessionId: 'readonly', allowed: false, reason: 'read' },
        ],
        isCurrent: () => true, dispose: () => {},
    });

    it('lists Sessions that cannot take reports in their own section, each with the owner reason', () => {
        const sections = buildPutUnderChooserSections({ sessions, sessionId: 'self', facts, describeName: (s) => s.id });
        const unavailable = sections.find((section) => section.id === 'unavailable');
        expect(unavailable?.options).toEqual([
            expect.objectContaining({ id: 'readonly', disabled: true, detail: describeSessionListDropReason('read').message }),
        ]);
        const available = sections.flatMap((section) => section.options).filter((option) => !option.disabled).map((option) => option.id);
        expect(available).toEqual([PUT_UNDER_TOP_LEVEL_OPTION_ID, 'lead', 'peer']);
        expect(sections[0]!.options.find((option) => option.id === 'lead')?.current).toBe(true);
    });

    it('refuses every lead with a reason when the Home could not be asked, instead of pretending they are ready', () => {
        const sections = buildPutUnderChooserSections({ sessions, sessionId: 'self', facts: null, describeName: (s) => s.id });
        const leads = sections.flatMap((section) => section.options).filter((option) => option.id !== PUT_UNDER_TOP_LEVEL_OPTION_ID);
        expect(leads.length).toBeGreaterThan(0);
        expect(leads.every((option) => option.disabled && option.detail === describeSessionListDropReason('unavailable').message)).toBe(true);
    });
});
