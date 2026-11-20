import type { MachineRecipeStepV1, MachineSetupEffectPlanV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';

type PackageStep = Extract<MachineRecipeStepV1, { kind: 'package' }>;
function matchesPackage(manager: string, pkg: PackageStep['packages'][number], native: Readonly<Record<string, unknown>>): boolean {
    return native.manager === manager && native.name === pkg.name && native.kind === pkg.kind
        && native.source === pkg.source && native.scope === pkg.scope;
}

/** Unknown steps cannot establish that this operation first installed an item. */
export function readMachineSetupInitialPresenceV1(plan: MachineSetupEffectPlanV1): 'present' | 'absent' | undefined {
    // Package-selection checks name the installed targets. Supporting packages
    // and repository trust do not establish that those targets pre-existed.
    const targets = (plan.checks ?? []).flatMap(check => check.kind === 'package'
      && plan.selectedCheckIds?.includes(check.id)
      ? check.packages.map(pkg => ({ manager: check.manager, ...pkg })) : []);
    const presence = plan.steps.flatMap((step, index): Array<boolean | undefined> => {
      // Script execution has no independent persisted identity. A recipe's native
      // footprint establishes first-presence; script-only recipes remain unknown.
      if (step.kind === 'script' || step.kind === 'packageSource' && targets.length > 0) return [];
      const selectedPackages = step.kind === 'package' ? step.packages.filter(pkg => targets.length === 0
        || targets.some(target => matchesPackage(step.manager, pkg, target))) : [];
      if (step.kind === 'package' && selectedPackages.length === 0) return [];
      const observation = plan.nativeFacts[index];
      if (!observation || observation.stepId !== step.id
        || observation.status !== 'satisfied' && observation.status !== 'drifted') return [undefined];
      const facts = observation.facts;
      if (step.kind === 'package') {
        const packages = facts.packages;
        if (facts.manager !== step.manager || !Array.isArray(packages)) return [undefined];
        return selectedPackages.map(pkg => {
          const matches = packages.flatMap(value => {
            if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
            const native = value as Readonly<Record<string, unknown>>;
            return matchesPackage(step.manager, pkg, native) ? [native] : [];
          });
          const match = matches.length === 1 ? matches[0] : undefined;
          return match && typeof match.present === 'boolean' ? match.present : undefined;
        });
      }
      if (step.kind === 'firewall') {
        const digests = [facts.rulesDigest, facts.unitDigest, facts.ownedTableDigest];
        if (digests.some(digest => typeof digest === 'string') || facts.bootEnabled === true || facts.bootActive === true) return [true];
        return [digests.every(digest => digest === null) && facts.bootEnabled === false && facts.bootActive === false
          ? false : undefined];
      }
      return [(['file', 'directory', 'user', 'group'].includes(step.kind) && typeof facts.present === 'boolean')
        ? facts.present : undefined];
    });
    return presence.includes(true) ? 'present'
      : presence.length > 0 && presence.every(value => value === false) ? 'absent' : undefined;
}
