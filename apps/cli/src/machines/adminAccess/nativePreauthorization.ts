import type { MachineAdminAccessObservationV1, MachinePreauthorizationIssueV1 } from '@happier-dev/protocol/machines/adminAccessV1';
import { buildManagedSudoersSteps } from './managedSudoers';

function consoleRemedy(daemonUsername: string | null): MachinePreauthorizationIssueV1['remedy'] {
    if (!daemonUsername) return undefined;
    try {
        const [step] = buildManagedSudoersSteps({ daemonUsername,
            previousPolicy: { version: 1, mode: 'none' }, policy: { version: 1, mode: 'preauthorized' } });
        if (step?.content?.kind !== 'literal') return undefined;
        return { kind: 'console', where: 'target_machine_console', command: 'sudo visudo',
            sudoersRule: step.content.value.trimEnd() };
    } catch {
        // A native username outside the sudoers builder's grammar cannot appear in a suggested rule.
        return undefined;
    }
}

type NativePreauthorization =
    | { kind: 'platform_unsupported' }
    | { kind: 'authorized'; elevation: 'root' | 'sudo' }
    | { kind: 'not_preauthorized'; preauthorizationIssue: MachinePreauthorizationIssueV1 };

export function resolveNativePreauthorization(observation: MachineAdminAccessObservationV1): NativePreauthorization {
    if (observation.reasonCode === 'platformUnsupported') return { kind: 'platform_unsupported' };
    if (observation.daemonUid === 0) return { kind: 'authorized', elevation: 'root' };
    switch (observation.passwordlessSudoToRoot) {
        case 'allowed': return { kind: 'authorized', elevation: 'sudo' };
        case 'unavailable': return { kind: 'not_preauthorized', preauthorizationIssue: { cause: 'sudo_unavailable' } };
        case 'unknown': return { kind: 'not_preauthorized', preauthorizationIssue: { cause: 'sudo_unknown' } };
        case 'denied': {
            const remedy = consoleRemedy(observation.daemonUsername);
            return { kind: 'not_preauthorized', preauthorizationIssue: { cause: 'sudo_denied', ...(remedy ? { remedy } : {}) } };
        }
    }
}
