import type { MachineRecipeV1 } from '@happier-dev/plugin-sdk';

const managers = ['apt', 'dnf', 'brew', 'winget'] as const;
type MachineRecipeStepDeclarationV1 = MachineRecipeV1['steps'][number];
type Manager = typeof managers[number];
type Packages = Extract<MachineRecipeStepDeclarationV1, { kind: 'package' }>['packages'];

/** Select one native manager. Package/source/pin failures never select another. */
export function packageSelection(entries: Partial<Record<Manager, Packages>>, optionalInputs = false):
  Pick<MachineRecipeV1, 'checks' | 'steps' | 'removeSteps'> {
  const available = managers.filter(manager => entries[manager] !== undefined);
  const checks = available.map(manager => ({
    id: `manager-${manager}`, kind: 'package' as const, manager, state: 'absent' as const, packages: entries[manager]!,
  }));
  const program = (state: 'present' | 'absent'): MachineRecipeStepDeclarationV1[] => available.map((manager, index) => ({
    id: `packages-${manager}`, kind: 'package', manager, state, packages: entries[manager]!,
    when: [
      ...(optionalInputs ? [{ input: { op: 'truthy' as const, path: manager } }] : []),
      ...available.slice(0, index).map(previous => ({
        checkId: `manager-${previous}`, status: ['packageManagerUnavailable' as const],
        ...(optionalInputs ? { ifInput: { op: 'truthy' as const, path: previous } } : {}),
      })),
      { checkId: `manager-${manager}`, status: ['satisfied', 'drifted'] },
    ],
  }));
  return { checks, steps: program('present'), removeSteps: program('absent') };
}
