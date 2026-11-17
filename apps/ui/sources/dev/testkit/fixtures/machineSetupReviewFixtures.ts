import { MachineSetupApplyInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import {
  MachineSetupEffectPlanV1Schema,
  type MachineRecipeStepV1,
} from '@happier-dev/protocol/machines/setup/machineRecipeV1';

import type { MachineSetupPreparedApply } from '@/components/settings/machines/managed/machineSetupReview';

/**
 * A prepared Machine setup review for one Machine, as the effects Plan returns it: a dev box's packages,
 * a toolchain command, and a group, none in place yet. Parsed through the wire schemas so a contract
 * change fails here rather than in a quietly stale literal.
 */
export function machineSetupPreparedReviewFixture(
  input: Readonly<{
    homeId?: string;
    machineId: string;
    administratorRequired?: boolean;
  }>,
): Extract<MachineSetupPreparedApply, { ok: true }> {
  const homeId = input.homeId ?? 'home';
  const steps: MachineRecipeStepV1[] = [
    {
      id: 'packages',
      kind: 'package',
      manager: 'apt',
      packages: [
        { name: 'git' },
        { name: 'nodejs', version: '22' },
        { name: 'docker-ce' },
      ],
    },
    {
      id: 'corepack',
      kind: 'command',
      executable: 'corepack',
      args: ['enable'],
      check: {
        executable: 'corepack',
        args: ['-v'],
        unsatisfiedExitCodes: [1],
      },
    },
    { id: 'docker-group', kind: 'group', name: 'docker', members: ['happier'] },
  ];
  const plan = MachineSetupEffectPlanV1Schema.parse({
    v: 1,
    basis: { kind: 'setup', machineId: input.machineId, desiredRevision: 1 },
    planDigest: 'd'.repeat(64),
    steps,
    nativeFacts: steps.map((step) => ({
      stepId: step.id,
      status: 'drifted',
      facts: {},
    })),
  });
  return {
    ok: true,
    input: MachineSetupApplyInputV1Schema.parse({
      homeId,
      machineId: input.machineId,
      targets: [
        {
          homeId,
          machineId: input.machineId,
          sources: [{ kind: 'direct', setup: {} }],
          desiredRevision: 1,
          recipePlans: [{ sourceIndex: 0, itemIndex: 0, plan }],
        },
      ],
    }),
    facts: [
      {
        homeId,
        machineId: input.machineId,
        support: [],
        review: {
          target: { homeId, machineId: input.machineId },
          administratorRequired: input.administratorRequired ?? true,
          downtime: 'none',
        },
      },
    ],
  };
}
