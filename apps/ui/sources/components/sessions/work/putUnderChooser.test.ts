import { describe, expect, it } from 'vitest';

import { createSessionAccessFixture, createSessionFixture } from '@/dev/testkit';
import type { Session } from '@/sync/domains/state/storageTypes';
import { createSessionManagerEligibilitySnapshot } from '@/sync/ops/relations/sessionManagerEligibility';

import { describeSessionListDropReason } from '@/components/sessions/shell/dropPreview/sessionListDropPresentation';

import { buildPutUnderChooserSections, PUT_UNDER_TOP_LEVEL_OPTION_ID } from './putUnderChooser';

function session(id: string, overrides: Partial<Session> = {}): Session {
    return createSessionFixture({ id, serverId: 'home', updatedAt: 1, createdAt: 1, archivedAt: null, access: createSessionAccessFixture(), ...overrides });
}

describe('buildPutUnderChooserSections (K1c)', () => {
    const sessions = Object.fromEntries([
        session('self', { manager: { sessionId: 'lead' }, updatedAt: 5 }),
        session('lead', { updatedAt: 4 }),
        session('peer', { updatedAt: 3 }),
        session('readonly', { updatedAt: 2 }),
    ].map((item) => [item.id, item]));
    const facts = createSessionManagerEligibilitySnapshot({
        serverId: 'home', accountId: 'account', sessionId: 'self', currentManagerSessionId: 'lead',
        candidates: [
            { sessionId: 'lead', allowed: true },
            { sessionId: 'peer', allowed: true },
            { sessionId: 'readonly', allowed: false, reason: 'read' },
        ],
        isCurrent: () => true, dispose: () => {},
    });

    it('lists Sessions that cannot take reports in their own section, each with the owner reason', () => {
        const sections = buildPutUnderChooserSections({ sessions, sessionId: 'self', facts });
        const unavailable = sections.find((section) => section.id === 'unavailable');
        expect(unavailable?.options).toEqual([
            expect.objectContaining({ id: 'readonly', disabled: true, detail: describeSessionListDropReason('read').message }),
        ]);
        const available = sections.flatMap((section) => section.options).filter((option) => !option.disabled).map((option) => option.id);
        expect(available).toEqual([PUT_UNDER_TOP_LEVEL_OPTION_ID, 'lead', 'peer']);
        expect(sections.flatMap(section => section.options).find(option => option.id === 'lead')?.current).toBe(true);
    });

    it('groups current and active leads without treating a role as a reporting relationship', () => {
        const records = { ...sessions,
            activeLead: session('activeLead', { updatedAt: 8,
                managedSessions: { total: 1, working: 1, needsYou: 0, stalled: 0, finished: 0, attentionPrimary: null } }),
            roleOnly: session('roleOnly', { updatedAt: 1,
                metadata: { path: '/repo', host: 'work', work: { sessionRolesV1: {
                    roleId: 'orchestrator', sessionRoles: {}, overrides: {}, notes: '',
                } } } }),
        };
        const eligible = createSessionManagerEligibilitySnapshot({
            serverId: 'home', accountId: 'account', sessionId: 'self', currentManagerSessionId: 'lead',
            candidates: ['lead', 'peer', 'activeLead', 'roleOnly'].map(sessionId => ({ sessionId, allowed: true })),
            isCurrent: () => true, dispose: () => {},
        });
        const groups = buildPutUnderChooserSections({ sessions: records, sessionId: 'self', facts: eligible });
        expect(groups.slice(0, 3).map(group => group.options.map(option => option.id)))
            .toEqual([[PUT_UNDER_TOP_LEVEL_OPTION_ID], ['activeLead', 'lead'], ['roleOnly', 'peer']]);
    });

    it('refuses every lead with a reason when the Home could not be asked, instead of pretending they are ready', () => {
        const sections = buildPutUnderChooserSections({ sessions, sessionId: 'self', facts: null });
        const leads = sections.flatMap((section) => section.options).filter((option) => option.id !== PUT_UNDER_TOP_LEVEL_OPTION_ID);
        expect(leads.length).toBeGreaterThan(0);
        expect(leads.every((option) => option.disabled && option.detail === describeSessionListDropReason('unavailable').message)).toBe(true);
    });

    it('carries candidate identity and live report counts from held projections, even for unavailable leads', () => {
        const records = { ...sessions, lead: session('lead', {
            metadata: { path: '/repo', host: 'work', flavor: 'codex', work: { sessionRolesV1: {
                roleId: 'orchestrator', sessionRoles: {}, overrides: {}, notes: '',
            } } },
            managedSessions: { total: 9, archived: 2, working: 3, needsYou: 1, stalled: 0, finished: 3, attentionPrimary: null },
        }), peer: session('peer', {
            metadataLayoutVersion: 1,
            metadata: { path: '', host: '', v: 1, agentPresentation: { agentId: 'acme.review-agent' } },
            ownerMetadataView: null,
        }) };
        const sections = buildPutUnderChooserSections({ sessions: records, sessionId: 'self', facts: null });
        const lead = sections.flatMap(section => section.options).find(option => option.id === 'lead');
        expect(lead).toMatchObject({ disabled: true, session: {
            agentId: 'codex', roleId: 'orchestrator', roleName: 'Orchestrator', leadsCount: 7, workingCount: 3, updatedAt: 1,
        } });
        expect(sections.flatMap(section => section.options).find(option => option.id === 'peer'))
            .toMatchObject({ session: { agentId: 'acme.review-agent', roleId: null, roleName: null, leadsCount: null, workingCount: null } });
    });

    it('omits archived candidates even when Home eligibility is unavailable', () => {
        const sections = buildPutUnderChooserSections({ sessions: { ...sessions, archived: session('archived', { archivedAt: 1 }) },
            sessionId: 'self', facts: null });
        expect(sections.flatMap(section => section.options).map(option => option.id)).not.toContain('archived');
    });
});
