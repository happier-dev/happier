import { describe, expect, it } from 'vitest';
import type { ActionOperationProjection } from '../actionOperations/actionOperationSelectors';
import { createServiceHealthNoticeArtifactFixture } from '@/dev/testkit/fixtures/usageNoticeFixtures';
import { readAccountNoticeArtifactHeader, type AccountNoticeArtifact } from './usageNoticeArtifacts';
import { projectExpectedHealthNotice } from './projectExpectedHealthNotice';

const scope = { serverId: 'home', accountId: 'account-a' };
function notice(): AccountNoticeArtifact {
    const artifact = createServiceHealthNoticeArtifactFixture(scope.serverId, { header: { type: 'blocked' } });
    const header = readAccountNoticeArtifactHeader(artifact, scope.accountId);
    if (!header) throw new Error('Expected owned C1 notice');
    return { artifact, header };
}
function reboot(): ActionOperationProjection {
    return { serverId: scope.serverId, observation: 'available', isUnavailableProjection: false,
        snapshot: { version: 1, operationId: 'reboot', revision: 1, actionId: 'machines.reboot', state: 'running',
            scope: { accountId: scope.accountId, machineId: 'machine' }, title: 'Reboot', createdAt: 1, startedAt: 1,
            cancellation: 'unsupported', domainRef: { kind: 'machineReboot', serverId: scope.serverId,
                machineId: 'machine', installationId: 'installation', task: { id: 'task', taskKind: 'machine.reboot.v1' },
                basis: { bootedAt: 1, dispatchStarted: true, expectedRunningServicesKnown: true,
                    expectedRunningServiceIds: ['instance/web'] } } } };
}

describe('readable operation explanation for the existing C1 condition', () => {
    it('keeps one notice and read state while a proved reboot explains its exact running service', () => {
        const entry = notice();
        const expected = projectExpectedHealthNotice(entry, [reboot()], scope);
        expect(expected.artifact).toBe(entry.artifact);
        expect(expected.header).toMatchObject({ type: 'update', source: entry.header.source, healthPhase: 'open' });
        expect(expected.expectedDuring).toEqual({ kind: 'reboot', operation: { serverId: 'home', machineId: 'machine', operationId: 'reboot' } });
        expect(projectExpectedHealthNotice(entry, [], scope)).toBe(entry);
    });
    it('does not explain another service, Account, Home, settled operation or explicit uncertain result', () => {
        const entry = notice();
        const current = reboot();
        for (const operation of [
            { ...current, serverId: 'other' },
            { ...current, isUnavailableProjection: true },
            { ...current, snapshot: { ...current.snapshot, scope: { ...current.snapshot.scope, accountId: 'other' } } },
            { ...current, snapshot: { ...current.snapshot, state: 'succeeded' as const, settledAt: 2 } },
            { ...current, snapshot: { ...current.snapshot, observation: { kind: 'outcome_uncertain' as const, code: 'action_outcome_unknown' } } },
            { ...current, snapshot: { ...current.snapshot, scope: { ...current.snapshot.scope, machineId: 'another-machine' } } },
        ]) expect(projectExpectedHealthNotice(entry, [operation], scope)).toBe(entry);
    });
    it('explains only the admitted native stop or restart subject, and restores blocking after settlement', () => {
        const entry = notice(), current = reboot();
        for (const operation of ['stop', 'restart'] as const) {
            const running: ActionOperationProjection = { ...current, snapshot: { ...current.snapshot,
                domainRef: { kind: 'machineService', serverId: scope.serverId, operation, generation: 'generation',
                    subject: { kind: 'machineService', machineId: 'machine', serviceId: 'instance/web' } } } };
            expect(projectExpectedHealthNotice(entry, [running], scope).expectedDuring?.kind).toBe(operation);
            expect(projectExpectedHealthNotice(entry, [{ ...running, snapshot: { ...running.snapshot,
                state: 'failed', settledAt: 2 } }], scope)).toBe(entry);
            const ref = running.snapshot.domainRef;
            if (ref?.kind !== 'machineService') throw new Error('Expected native operation');
            expect(projectExpectedHealthNotice(entry, [{ ...running, snapshot: { ...running.snapshot,
                domainRef: { ...ref, subject: { kind: 'machineService', machineId: 'machine', serviceId: 'another' } } } }], scope)).toBe(entry);
        }
    });
    it('uses the existing Deployment operation for its Environment health, keeping other conditions independent', () => {
        const entry = notice(), current = reboot();
        const operation: ActionOperationProjection = { ...current, snapshot: { ...current.snapshot,
            domainRef: { kind: 'deployment', serverId: scope.serverId, environmentId: 'environment', deploymentId: 'deployment' } } };
        expect(projectExpectedHealthNotice(entry, [operation], scope).expectedDuring?.kind).toBe('deploy');
        const source = { kind: 'host' as const, topic: 'service_health' as const,
            subject: { kind: 'environment' as const, environmentId: 'environment', targetLinkId: 'link', condition: 'health' as const } };
        const environment = { ...entry, header: { ...entry.header, source } };
        expect(projectExpectedHealthNotice(environment, [operation], scope).expectedDuring?.kind).toBe('deploy');
        for (const subject of [
            { kind: 'environment' as const, environmentId: 'another', targetLinkId: 'link', condition: 'health' as const },
            { kind: 'backup' as const, environmentId: 'environment', check: 'run' as const },
        ]) {
            const other = { ...entry, header: { ...entry.header, source: { ...source, subject } } };
            expect(projectExpectedHealthNotice(other, [operation], scope)).toBe(other);
        }
    });
    it('explains only the exact retained Domain probe subject, never certificate or another link', () => {
        const artifact = createServiceHealthNoticeArtifactFixture(scope.serverId, { header: { type: 'blocked',
            source: { kind: 'host', topic: 'service_health', subject: { kind: 'domain', environmentId: 'environment',
                targetLinkId: 'link', domainId: 'domain', condition: 'domain_probe_failed' } },
            page: { kind: 'host', page: 'environment', environment: { serverId: scope.serverId,
                projectSourceId: 'source', environmentId: 'environment' }, targetLinkId: 'link' },
        } });
        const header = readAccountNoticeArtifactHeader(artifact, scope.accountId);
        if (!header) throw new Error('Expected owned Domain notice');
        const entry = { artifact, header };
        const current = reboot(), ref = current.snapshot.domainRef;
        if (ref?.kind !== 'machineReboot' || !ref.basis) throw new Error('Expected reboot basis');
        const operation = { ...current, snapshot: { ...current.snapshot, domainRef: { ...ref,
            basis: { ...ref.basis, domains: [{ environmentId: 'environment', targetLinkId: 'link', domainId: 'domain',
                machineId: 'machine', installationId: 'installation' }] } } } };
        expect(projectExpectedHealthNotice(entry, [operation], scope).expectedDuring?.kind).toBe('reboot');
        expect(projectExpectedHealthNotice(entry, [current], scope)).toBe(entry);
        for (const subject of [
            { kind: 'domain' as const, environmentId: 'environment', targetLinkId: 'different', domainId: 'domain', condition: 'domain_probe_failed' as const },
            { kind: 'domain' as const, environmentId: 'environment', targetLinkId: 'link', domainId: 'domain', condition: 'certificate_renewal_failed' as const },
        ]) {
            const other = { ...entry, header: { ...header, source: { kind: 'host' as const, topic: 'service_health' as const, subject } } };
            expect(projectExpectedHealthNotice(other, [operation], scope)).toBe(other);
        }
    });
});
