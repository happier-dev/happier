import { describe, expect, it } from 'vitest';
import type { EnvironmentSecretBindingV1 } from '@happier-dev/deployment-protocol';
import * as owner from './environmentSecretBindingsProjection.js';

const secret = { kind: 'secret' as const, ref: 'happier:shared-secret:v1:credential', resourceRevision: 2 };
const bindings: EnvironmentSecretBindingV1[] = [
    { purpose: 'variable', name: 'TOKEN', phase: 'runtime', source: secret },
    { purpose: 'variable', name: 'PUBLIC_ORIGIN', phase: 'build', source: { kind: 'value', value: 'https://app.test' } },
    { purpose: 'registry', targetLinkId: 'link-a', registryOrigin: 'https://registry.test', access: 'pull', source: secret },
    { purpose: 'backupDestination', configKey: 'destination', role: 'repositoryPassword', source: secret },
    { purpose: 'backupDestination', configKey: 'destination', role: 'sshPrivateKey', source: secret },
    { purpose: 'domainCredential', domainId: 'domain', role: 'privateKey', source: secret },
    { purpose: 'dataRole', service: 'postgres', role: 'readOnlyPassword', source: secret },
    { purpose: 'dataRole', targetLinkId: 'managed-data', role: 'readOnlyPassword', source: secret },
    { purpose: 'variable', name: 'OWN_URL', phase: 'runtime', source: { kind: 'deploymentFact', fact: 'primaryUrl' } },
];

describe('canonical purpose binding projection', () => {
    it('projects variable-only controls and public build values without materializing any secret', async () => {
        const rows = owner.projectEnvironmentSecretBindingsV1(bindings, [], { kind: 'team', teamId: 'team-a' });
        expect(rows.map(row => row.hasPhaseControl)).toEqual([true, true, false, false, false, false, false, false, true]);
        expect(rows.map(row => row.masked)).toEqual([true, false, true, true, true, true, true, true, false]);
        expect(rows.filter(row => row.bakedIntoImage).map(row => row.binding)).toEqual([bindings[1]]);
        expect(new Set(rows.map(row => row.identity)).size).toBe(bindings.length);
        expect(rows[0].binding).toBe(bindings[0]);
        expect(rows.map(row => row.secretDisclosure)).toEqual(bindings.map(binding => binding.source.kind === 'secret'
            ? { kind: 'teamEnvironmentMachines', teamId: 'team-a' } : null));
    });

    it('updates disclosure on Team changes without losing equal rows or implying a missing owner means no disclosure', () => {
        const selected = [bindings[0]!, bindings[1]!];
        const first = owner.projectEnvironmentSecretBindingsV1(selected, [], { kind: 'team', teamId: 'team-a' });
        expect(owner.projectEnvironmentSecretBindingsV1(structuredClone(selected), first, { kind: 'team', teamId: 'team-a' })).toBe(first);
        const moved = owner.projectEnvironmentSecretBindingsV1(selected, first, { kind: 'team', teamId: 'team-b' });
        expect(moved[0]!.secretDisclosure).toEqual({ kind: 'teamEnvironmentMachines', teamId: 'team-b' });
        expect(moved[0]).not.toBe(first[0]);
        expect(moved[1]).toBe(first[1]);
        const personal = owner.projectEnvironmentSecretBindingsV1(selected, moved, { kind: 'account', accountId: 'owner' });
        expect(personal[0]!.secretDisclosure).toEqual({ kind: 'environmentMachines' });
        expect(personal[1]).toBe(first[1]);
        expect(owner.projectEnvironmentSecretBindingsV1(selected, personal)).toBe(personal);
    });

    it('retains equal/reordered siblings and replaces only one actually changed purpose row at scale', async () => {
        const many: EnvironmentSecretBindingV1[] = Array.from({ length: 200 }, (_, index) => ({
            purpose: 'variable', name: `SECRET_${index}`, phase: 'runtime',
            source: { kind: 'secret', ref: `happier:shared-secret:v1:resource-${index % 100}`, resourceRevision: 1 },
        }));
        const first = owner.projectEnvironmentSecretBindingsV1(many);
        expect(owner.projectEnvironmentSecretBindingsV1(structuredClone(many), first)).toBe(first);
        const changed = structuredClone(many);
        changed[99] = { ...changed[99], source: { kind: 'value', value: 'public' } };
        const next = owner.projectEnvironmentSecretBindingsV1(changed, first);
        expect(next.filter((row, index) => row !== first[index])).toHaveLength(1);
        const reversed = owner.projectEnvironmentSecretBindingsV1([...changed].reverse(), next);
        expect(reversed.every((row, index) => row === next[next.length - index - 1])).toBe(true);
    });
});
