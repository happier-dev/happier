import { describe, expect, it } from 'vitest';
import { TriageEntryRefV1Schema } from './identity.js';
import { triageFailureSubjectEntryV1, triageHealthAlertEntryV1 } from './investigationSubjects.js';

describe('native investigation subject identity', () => {
    it('separates receipt identity by Home, Environment and deployment without a placement identity', () => {
        const subject = { kind: 'deploymentReceipt', serverId: 'home', environmentId: 'environment', deploymentId: 'receipt' } as const;
        const original = triageFailureSubjectEntryV1(subject);
        expect(TriageEntryRefV1Schema.parse(original.entryRef)).toEqual(original.entryRef);
        for (const changed of [{ ...subject, serverId: 'other-home' }, { ...subject, environmentId: 'other-environment' },
            { ...subject, deploymentId: 'other-receipt' }]) {
            expect(triageFailureSubjectEntryV1(changed).entryRef).not.toEqual(original.entryRef);
        }
        expect(triageFailureSubjectEntryV1({ deploymentId: subject.deploymentId, environmentId: subject.environmentId,
            serverId: subject.serverId, kind: subject.kind })).toEqual(original);
    });

    it('keeps a notice on its exact Artifact across execution placement choices', () => {
        const context = { kind: 'healthAlert', notice: { kind: 'host', artifactId: 'notice',
            source: { kind: 'host', topic: 'resource_limit' } }, target: { kind: 'machine', machine: { serverId: 'home', machineId: 'affected' } } } as const;
        const original = triageHealthAlertEntryV1(context);
        expect(TriageEntryRefV1Schema.parse(original.entryRef)).toEqual(original.entryRef);
        expect(triageHealthAlertEntryV1({ ...context, machine: { serverId: 'home', machineId: 'execution' } })).toEqual(original);
        expect(triageHealthAlertEntryV1({ ...context, notice: { ...context.notice, artifactId: 'other-notice' } }).entryRef).not.toEqual(original.entryRef);
    });
});
