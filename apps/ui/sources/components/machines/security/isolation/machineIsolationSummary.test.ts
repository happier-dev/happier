import { describe, expect, it, vi } from 'vitest';
import type { MachineIsolationPolicyV1 } from '@happier-dev/protocol/machines/machineIsolationV1';

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

const { describeMachineIsolationPolicy } = await import('./machineIsolationSummary');

const docker = { pluginId: 'happier.machine.docker-sandboxes', localId: 'docker-sandboxes' };
const directly = { kind: 'directly' } as const;
const names: Record<string, string> = { node: 'Node 22', py: 'Python 3.12' };
const nameOf = (id: string) => names[id] ?? null;
const keys = (sentences: readonly string[]) => sentences.map(sentence => sentence.split('(')[0]);

describe('machine isolation summary', () => {
    it('says everything runs directly when no kind of work uses a sandbox', () => {
        const policy: MachineIsolationPolicyV1 = { configuredSandboxes: {}, workKinds: { sessions: directly, botsChannels: directly, automationsWorkflows: directly } };
        expect(keys(describeMachineIsolationPolicy({ policy, machineName: 'devbox', nameOf }))).toEqual(['machineDetailPage.isolation.summary.allDirectly']);
    });

    it('names each sandbox it uses', () => {
        const policy: MachineIsolationPolicyV1 = { configuredSandboxes: { node: { provisioner: docker, presetId: 'n' } },
            workKinds: { sessions: { kind: 'sandbox', configuredSandboxId: 'node', lifecycle: 'fresh' }, botsChannels: directly, automationsWorkflows: directly } };
        expect(describeMachineIsolationPolicy({ policy, machineName: 'devbox', nameOf })[0]).toContain('name=Node 22');
    });

    it('says one sentence per kind of work when the choices differ, naming each sandbox and its lifecycle', () => {
        const policy: MachineIsolationPolicyV1 = {
            configuredSandboxes: { node: { provisioner: docker, presetId: 'n' }, py: { provisioner: docker, presetId: 'p' } },
            workKinds: { sessions: { kind: 'sandbox', configuredSandboxId: 'node', lifecycle: 'fresh' },
                botsChannels: { kind: 'sandbox', configuredSandboxId: 'py', lifecycle: 'shared-kept' }, automationsWorkflows: directly },
        };
        expect(keys(describeMachineIsolationPolicy({ policy, machineName: 'devbox', nameOf }))).toEqual([
            'machineDetailPage.isolation.summary.fresh', 'machineDetailPage.isolation.summary.kept', 'machineDetailPage.isolation.summary.directly',
        ]);
    });

    it('says it once when every kind of work shares the same sandbox and lifecycle', () => {
        const same = { kind: 'sandbox', configuredSandboxId: 'node', lifecycle: 'shared-kept' } as const;
        const policy: MachineIsolationPolicyV1 = { configuredSandboxes: { node: { provisioner: docker, presetId: 'n' } },
            workKinds: { sessions: same, botsChannels: same, automationsWorkflows: same } };
        expect(keys(describeMachineIsolationPolicy({ policy, machineName: 'devbox', nameOf }))).toEqual(['machineDetailPage.isolation.summary.allKept']);
    });
});
