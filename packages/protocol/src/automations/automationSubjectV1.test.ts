import { describe, expect, it } from 'vitest';
import { automationSubjectKeyV1, automationSubjectSharedKeyV1, automationSubjectKeyMatchesV1, automationSubjectMatchesV1, type AutomationSubjectV1 } from './automationSubjectV1.js';

// Canonical serialization order and framing cannot be controlled through UI authoring.
// These pure identity rules complement, and do not replace, P01.F1–F7.
describe('automation subject identity', () => {
    it('separates Homes, kinds and workflows while canonicalizing plugin identity object order', () => {
        const subject: AutomationSubjectV1 = { kind: 'plugin', serverId: 'home', pluginId: 'example.tickets', subjectKindId: 'ticket', identity: { team: 'one', id: 'two' } };
        expect(automationSubjectKeyV1(subject)).toBe(automationSubjectKeyV1({ ...subject, identity: { id: 'two', team: 'one' } }));
        expect(automationSubjectKeyV1(subject)).not.toBe(automationSubjectKeyV1({ ...subject, serverId: 'other' }));
        expect(automationSubjectKeyV1(subject)).not.toBe(automationSubjectKeyV1({ ...subject, pluginId: 'another.tickets' }));
        expect(automationSubjectKeyV1(subject, 'workflow-a')).not.toBe(automationSubjectKeyV1(subject, 'workflow-b'));
        expect(automationSubjectKeyV1({ kind: 'session', serverId: 'home', sessionId: 'same' })).not.toBe(
            automationSubjectKeyV1({ kind: 'machine', serverId: 'home', machineId: 'same' }));
    });

    it('matches approval profiles only as bound context and exact resources by qualified identity', () => {
        const profile: AutomationSubjectV1 = { kind: 'approvalProfile', serverId: 'home', profileId: 'profile' };
        expect(automationSubjectMatchesV1(profile, [{ role: 'operand', subject: profile }])).toBe(false);
        expect(automationSubjectMatchesV1(profile, [{ role: 'context', subject: profile }])).toBe(true);
        expect(automationSubjectMatchesV1(profile, [{ role: 'context', subject: { ...profile, serverId: 'other' } }])).toBe(false);
        expect(automationSubjectMatchesV1(undefined, [])).toBe(true);
    });

    it('compares shared structural keys in their workflow namespace with the same context-role rule', () => {
        const profile: AutomationSubjectV1 = { kind: 'approvalProfile', serverId: 'home', profileId: 'profile' };
        const key = automationSubjectKeyV1(profile, 'workflow-a');
        // The server has only the local digest for an encrypted authored subject.
        expect(automationSubjectSharedKeyV1(automationSubjectKeyV1(profile), 'workflow-a')).toBe(key);
        const context = [{ role: 'context' as const, subject: profile }];
        expect(automationSubjectKeyMatchesV1(key, context, 'workflow-a', 'approvalProfile')).toBe(true);
        expect(automationSubjectKeyMatchesV1(key, [{ role: 'context', kind: profile.kind,
            key: automationSubjectKeyV1(profile) }], 'workflow-a', 'approvalProfile')).toBe(true);
        expect(automationSubjectKeyMatchesV1(key, [{ role: 'operand', kind: profile.kind,
            key: automationSubjectKeyV1(profile) }], 'workflow-a', 'approvalProfile')).toBe(false);
        expect(automationSubjectKeyMatchesV1(key, context, 'workflow-b', 'approvalProfile')).toBe(false);
        expect(automationSubjectKeyMatchesV1(key, context, 'workflow-a', 'machine')).toBe(false);
        expect(automationSubjectKeyMatchesV1(key, [{ role: 'operand', subject: profile }], 'workflow-a')).toBe(false);
        expect(automationSubjectKeyMatchesV1(key, [{ role: 'context', subject: { ...profile, serverId: 'other' } }], 'workflow-a')).toBe(false);
    });
});
