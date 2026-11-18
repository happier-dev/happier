import type { MachineIsolationPolicyV1 } from '@happier-dev/protocol/machines/machineIsolationV1';
import type { MachineAuthorityPresentationV1 } from '@happier-dev/protocol/machines/machineAuthorityV1';
import { describeMachineShareTrust } from '@/components/sharing/machines/machineShareTrust';

import { t } from '@/text';

import { MACHINE_ISOLATION_WORK_KINDS } from './machineIsolationChoices';

/**
 * The sentences that say a Machine's isolation policy back in plain words. The Isolation page leads with it and
 * Security and Overview show it as their row value; nothing else words the policy.
 */
export function describeMachineIsolationPolicy(input: Readonly<{
    policy: MachineIsolationPolicyV1;
    authority: Pick<MachineAuthorityPresentationV1, 'separateUsers' | 'isolation'>;
    machineName: string;
    /** A configured sandbox's preset name, or null while it is unknown. */
    nameOf: (configuredSandboxId: string) => string | null;
}>): readonly string[] {
    const { policy, machineName, authority } = input;
    const placement = authority.separateUsers.placement;
    const userIsolation = placement !== 'daemon'
        ? describeMachineShareTrust(placement, false, machineName, authority.isolation).lead : null;
    const name = (id: string) => input.nameOf(id) ?? t('machineDetailPage.isolation.summary.unnamed');
    const choices = MACHINE_ISOLATION_WORK_KINDS.map(kind => policy.workKinds[kind]);
    const [first] = choices;
    const same = first !== undefined && choices.every(choice => choice.kind === first.kind
        && (choice.kind === 'directly' || first.kind === 'sandbox'
            && choice.configuredSandboxId === first.configuredSandboxId && choice.lifecycle === first.lifecycle));
    if (same && first) {
        // Direct sandbox placement does not mean that everyone shares Happier's operating-system user.
        if (first.kind === 'directly' && userIsolation) return [userIsolation];
        return [...(userIsolation ? [userIsolation] : []), first.kind === 'directly' ? t('machineDetailPage.isolation.summary.allDirectly', { machine: machineName })
            : first.lifecycle === 'fresh' ? t('machineDetailPage.isolation.summary.allFresh', { name: name(first.configuredSandboxId) })
            : t('machineDetailPage.isolation.summary.allKept', { name: name(first.configuredSandboxId) })];
    }
    return [...(userIsolation ? [userIsolation] : []), ...MACHINE_ISOLATION_WORK_KINDS.map(kind => {
        const choice = policy.workKinds[kind];
        const subject = t(`machineDetailPage.isolation.workKinds.${kind}`);
        return choice.kind === 'directly' ? t('machineDetailPage.isolation.summary.directly', { kind: subject, machine: machineName })
            : choice.lifecycle === 'fresh' ? t('machineDetailPage.isolation.summary.fresh', { kind: subject, name: name(choice.configuredSandboxId) })
            : t('machineDetailPage.isolation.summary.kept', { kind: subject, name: name(choice.configuredSandboxId) });
    })];
}
