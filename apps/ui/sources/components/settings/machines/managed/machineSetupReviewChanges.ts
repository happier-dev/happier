import { mergeMachineSetupsV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import type { MachineSetupApplyInputV1, MachineSetupRemoveInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { resolvePluginLocalizedStringV2Text } from '@happier-dev/protocol/plugins/contributions/publicTypes';

/** The kinds a setup review groups its changes under (lab `setup/review` Changes), in the lab's order. */
export const MACHINE_SETUP_CHANGE_KINDS = ['packages', 'files', 'users', 'ports', 'services', 'commands'] as const;
export type MachineSetupChangeKind = (typeof MACHINE_SETUP_CHANGE_KINDS)[number];

export type MachineSetupChangeLine = Readonly<{
    /** Every target that makes this exact change; a change several Machines share is one line. */
    machineIds: readonly string[];
    /** The exact native operand ("apt · docker-ce 27.3", "happier → docker", "$ corepack enable"). */
    operand?: string;
    /** Public host ports the firewall leaves reachable from outside. */
    publicPorts?: readonly number[];
    /** A firewall change that exposes nothing publicly, or a Machine restart: said in words, not as an operand. */
    note?: 'firewall' | 'reboot';
    removes: boolean;
}>;

export type MachineSetupChangeGroup = Readonly<{
    kind: MachineSetupChangeKind;
    lines: readonly MachineSetupChangeLine[];
    /** Distinct changes: packages count their packages (a package source counts none); every other kind counts its lines. */
    added: number;
    removed: number;
}>;

// Remove carries source copies for review context, never as executable setup operands.
export type MachineSetupReviewChangeTarget = MachineSetupApplyInputV1['targets'][number] | MachineSetupRemoveInputV1;

/** Count the same Plan operands that the grouped review describes. */
export function countMachineSetupTargetChanges(target: MachineSetupReviewChangeTarget): number {
    let count = 0;
    visitMachineSetupTargetChanges(target, (_kind, _line, weight) => { count += weight ?? 1; });
    return count;
}

type LineFacts = Omit<MachineSetupChangeLine, 'machineIds'> & Readonly<{ machineId: string }>;

/**
 * What a reviewed setup changes, grouped by kind across its targets, from the exact effects Plans (and removal Plans)
 * that Apply carries. The same change on several Machines is one line naming them all. Presentation only: the Plan
 * stays the authority for what runs.
 */
export function groupMachineSetupChanges(targets: readonly MachineSetupReviewChangeTarget[]): MachineSetupChangeGroup[] {
    const groups = new Map<MachineSetupChangeKind, { lines: Map<string, { machineIds: string[] } & MachineSetupChangeLine>; weights: Map<string, number>; added: number; removed: number }>();
    const add = (kind: MachineSetupChangeKind, { machineId, ...change }: LineFacts, weight = 1) => {
        const group = groups.get(kind) ?? { lines: new Map(), weights: new Map(), added: 0, removed: 0 };
        groups.set(kind, group);
        const key = JSON.stringify([change.removes, change.operand, change.publicPorts, change.note]);
        const previousWeight = group.weights.get(key) ?? 0;
        const nextWeight = Math.max(previousWeight, weight);
        group.weights.set(key, nextWeight);
        if (change.removes) group.removed += nextWeight - previousWeight; else group.added += nextWeight - previousWeight;
        const known = group.lines.get(key);
        if (known) {
            if (!known.machineIds.includes(machineId)) known.machineIds.push(machineId);
            return;
        }
        group.lines.set(key, { ...change, machineIds: [machineId] });
    };
    for (const target of targets) visitMachineSetupTargetChanges(target, add);
    return MACHINE_SETUP_CHANGE_KINDS.flatMap(kind => {
        const group = groups.get(kind);
        return group ? [{ kind, lines: [...group.lines.values()], added: group.added, removed: group.removed }] : [];
    });
}

/** One projection of executable Plan facts; presentation never parses or resolves toolchain config. */
function visitMachineSetupTargetChanges(target: MachineSetupReviewChangeTarget,
    add: (kind: MachineSetupChangeKind, change: LineFacts, weight?: number) => void): void {
    if ('recipePlans' in target) {
        const merged = mergeMachineSetupsV1(target.sources.map(source => source.setup));
        if (merged.ok) {
            const { toolchain, scripts } = merged.setup;
            if (toolchain) add('files', { machineId: target.machineId,
                operand: `${toolchain.adapterId} · ${toolchain.config}`, removes: false });
            for (const script of scripts ?? []) {
                if (script.body) add('commands', { machineId: target.machineId, operand: `$ ${script.body}`, removes: false });
            }
        }
    }
    const plans = [
        ...('recipePlans' in target ? target.recipePlans.map(recipe => ({ plan: recipe.plan, removal: false })) : []),
        ...(target.removalPlans ?? []).map(removal => ({ plan: removal.plan, removal: true })),
    ];
    for (const { plan, removal } of plans) {
        for (const [index, step] of plan.steps.entries()) {
            const satisfied = plan.nativeFacts[index]?.status === 'satisfied';
            // A preceding effect can invalidate a satisfied script check. All
            // admitted bytes stay reviewable, including on a later Apply.
            if (satisfied && step.kind !== 'script') continue;
            const removes = removal || ('state' in step && step.state === 'absent');
            const consequence = resolvePluginLocalizedStringV2Text(step.review?.description);
            const line = (operand: string) => ({ machineId: target.machineId,
                operand: [operand, consequence].filter(Boolean).join(' · '), removes });
            switch (step.kind) {
                case 'package':
                    add('packages', line(`${step.manager} · ${step.packages.map(item => [item.version ? `${item.name} ${item.version}` : item.name, item.kind, item.source, item.scope].filter(Boolean).join(' · ')).join(', ')}`),
                        step.packages.length);
                    break;
                case 'packageSource':
                    // Where packages come from, listed with them but not one to install.
                    add('packages', line(`${step.manager} · ${step.url} ${step.suite}`), 0);
                    break;
                case 'file':
                    add('files', line(step.path));
                    break;
                case 'directory':
                    add('files', line(step.path.endsWith('/') ? step.path : `${step.path}/`));
                    break;
                case 'user':
                    add('users', line(step.supplementaryGroups?.length ? `${step.username} → ${step.supplementaryGroups.join(', ')}` : step.username));
                    break;
                case 'group':
                    add('users', line(step.members.length ? `${step.members.join(', ')} → ${step.name}` : step.name));
                    break;
                case 'workspaceAccess':
                case 'pathTraversal':
                    add('users', line(`${step.agentUsername} → ${step.path}`));
                    break;
                case 'firewall': {
                    const ports = [...new Set((step.exposures ?? []).filter(exposure => exposure.exposure === 'public')
                        .map(exposure => exposure.hostPort))].sort((a, b) => a - b);
                    add('ports', ports.length ? { machineId: target.machineId, publicPorts: ports, removes }
                        : { machineId: target.machineId, note: 'firewall', removes });
                    break;
                }
                case 'serviceUnit':
                    add('services', line(step.unit));
                    break;
                case 'reboot':
                    add('services', { machineId: target.machineId, note: 'reboot', removes: false });
                    break;
                case 'command':
                    add('commands', line(`$ ${[step.executable, ...step.args].join(' ')}`));
                    break;
                case 'script':
                    add('commands', line(step.body), satisfied ? 0 : 1);
                    if (step.check) add('commands', line(step.check.body), 0);
                    break;
            }
        }
    }

}
