import { describe, expect, it } from 'vitest';
import type { MachineSetupApplyTargetV1, MachineSetupRemoveInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { MachineSetupEffectPlanV1, MachineRecipeStepV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { countMachineSetupTargetChanges, groupMachineSetupChanges } from './machineSetupReviewChanges';

const target = (overrides: Partial<MachineSetupApplyTargetV1> = {}): MachineSetupApplyTargetV1 => ({
    homeId: 'home', machineId: 'machine', desiredRevision: 0, sources: [], recipePlans: [], ...overrides,
});
const effects = (steps: MachineRecipeStepV1[], satisfied = false): MachineSetupEffectPlanV1 => ({
    v: 1, basis: { kind: 'setup', machineId: 'machine', desiredRevision: 0 }, planDigest: 'a'.repeat(64), steps,
    nativeFacts: steps.map(step => ({ stepId: step.id, status: satisfied ? 'satisfied' : 'unsatisfied' })),
});
const toolchain = { adapterId: 'mise', config: '[tools]\nnode = "22.14.0"' };

describe('Machine setup review changes', () => {
    it('discloses literal recipe install, check and removal script bodies in the ordinary Commands review', () => {
        const body = '#!/bin/bash\nprintf "%s" "$HOME"\n';
        const checkBody = 'test -e /example/installed\n';
        const plan = target({ recipePlans: [{ sourceIndex: 0, itemIndex: 0, plan: effects([
            { id: 'install', kind: 'script', shell: 'bash', body, check: { body: checkBody, unsatisfiedExitCodes: [1] } },
        ]) }], removalPlans: [{ itemKey: 'old', plan: effects([
            { id: 'remove', kind: 'script', shell: 'sh', body: 'remove-owned\n' },
        ]) }] });
        const commands = groupMachineSetupChanges([plan]).find(group => group.kind === 'commands');
        expect(commands).toMatchObject({ added: 1, removed: 1 });
        expect(commands?.lines.map(line => line.operand)).toEqual([body, checkBody, 'remove-owned\n']);
    });
    it('keeps initially satisfied script bytes reviewable without counting another effect', () => {
        const body = 'install-if-needed\n', checkBody = 'check-installed\n';
        const plan = target({ recipePlans: [{ sourceIndex: 0, itemIndex: 0, plan: effects([
            { id: 'install', kind: 'script', shell: 'bash', body, check: { body: checkBody, unsatisfiedExitCodes: [1] } },
        ], true) }] });
        expect(countMachineSetupTargetChanges(plan)).toBe(0);
        expect(groupMachineSetupChanges([plan]).find(group => group.kind === 'commands')?.lines.map(line => line.operand))
            .toEqual([body, checkBody]);
        const pending = target({ machineId: 'other', recipePlans: [{ sourceIndex: 0, itemIndex: 0,
            plan: effects(plan.recipePlans[0]!.plan.steps) }] });
        expect(groupMachineSetupChanges([plan, pending]).find(group => group.kind === 'commands'))
            .toMatchObject({ added: 1, removed: 0 });
    });
    it.each([toolchain.config, ''])('counts and discloses a direct Mise config (%j) without any recipe plans', config => {
        const selected = { ...toolchain, config };
        const plan = target({ sources: [{ kind: 'direct', setup: { toolchain: selected } }] });
        expect(countMachineSetupTargetChanges(plan)).toBe(1);
        expect(groupMachineSetupChanges([plan])).toEqual([{
            kind: 'files', added: 1, removed: 0,
            lines: [{ machineIds: ['machine'], operand: 'mise · '+config, removes: false }],
        }]);
    });

    it('does not call a truly empty or already-satisfied recipe plan a change', () => {
        const plan = target({ sources: [{ kind: 'direct', setup: { scripts: [{ body: '' }] } }],
            recipePlans: [{ sourceIndex: 0, itemIndex: 0, plan: effects([
                { id: 'package', kind: 'package', manager: 'apt', packages: [{ name: 'ffmpeg' }] },
            ], true) }] });
        expect(countMachineSetupTargetChanges(plan)).toBe(0);
        expect(groupMachineSetupChanges([plan])).toEqual([]);
    });

    it('counts a shared toolchain once and keeps every non-empty source script beside pending installs and removals', () => {
        const plan = target({ sources: [
            { kind: 'direct', setup: { toolchain, scripts: [{ body: 'echo first' }] } },
            { kind: 'accountPreset', presetId: 'preset', presetRevision: 1, setup: { toolchain, scripts: [{ body: 'echo second' }] } },
        ], recipePlans: [{ sourceIndex: 0, itemIndex: 0, plan: effects([
            { id: 'install', kind: 'package', manager: 'brew', packages: [{ name: 'firefox', kind: 'cask', version: '132.0' }] },
        ]) }], removalPlans: [{ itemKey: 'old', plan: effects([
            { id: 'remove', kind: 'package', manager: 'winget', state: 'absent', packages: [{ name: 'Mozilla.Firefox', source: 'winget', scope: 'user' }] },
        ]) }] });
        expect(countMachineSetupTargetChanges(plan)).toBe(5);
        const groups = groupMachineSetupChanges([plan]);
        expect(groups.find(group => group.kind === 'commands')?.lines.map(line => line.operand)).toEqual(['$ echo first', '$ echo second']);
        expect(groups.find(group => group.kind === 'packages')).toMatchObject({ added: 1, removed: 1,
            lines: [expect.objectContaining({ operand: 'brew · firefox 132.0 · cask', removes: false }),
                expect.objectContaining({ operand: 'winget · Mozilla.Firefox · winget · user', removes: true })] });
    });

    it('reviews removal operands without replaying the copied toolchain or scripts retained as context', () => {
        const removal: MachineSetupRemoveInputV1 = {
            homeId: 'home', machineId: 'machine', desiredRevision: 0,
            sources: [{ kind: 'direct', setup: { toolchain, scripts: [{ body: 'echo retained' }] } }],
            removeItemKeys: ['old'], removalPlans: [{ itemKey: 'old', plan: effects([
                { id: 'remove', kind: 'package', manager: 'apt', state: 'absent', packages: [{ name: 'ffmpeg' }] },
            ]) }],
        };
        expect(countMachineSetupTargetChanges(removal)).toBe(1);
        expect(groupMachineSetupChanges([removal])).toEqual([{
            kind: 'packages', added: 0, removed: 1,
            lines: [{ machineIds: ['machine'], operand: 'apt · ffmpeg', removes: true }],
        }]);
    });
});


it('discloses signed package repositories using each manager dialect without counting another package', () => {
    const common = { id: 'source', kind: 'packageSource' as const,
        keyPath: '/etc/pki/rpm-gpg/vendor.asc', keyUrl: 'https://vendor.example/key.asc', keyFingerprint: 'A'.repeat(40) };
    const sources: MachineRecipeStepV1[] = [
        { ...common, id: 'apt-source', manager: 'apt', path: '/etc/apt/sources.list.d/vendor.sources',
            url: 'https://vendor.example/deb', suite: 'stable', components: ['main'], architectures: ['amd64'] },
        { ...common, id: 'dnf-source', manager: 'dnf', path: '/etc/yum.repos.d/vendor.repo',
            repositoryId: 'vendor', url: 'https://vendor.example/rpm/$basearch', architectures: ['x86_64'] },
    ];
    const plan = target({ recipePlans: [{ sourceIndex: 0, itemIndex: 0, plan: effects(sources) }] });
    expect(groupMachineSetupChanges([plan])).toEqual([{
        kind: 'packages', added: 0, removed: 0, lines: [
            { machineIds: ['machine'], operand: 'apt · https://vendor.example/deb stable', removes: false },
            { machineIds: ['machine'], operand: 'dnf · https://vendor.example/rpm/$basearch', removes: false },
        ],
    }]);
});
