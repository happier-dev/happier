import { buildSessionHostOnboardingInputV1 } from '@happier-dev/protocol/sessions';
import type { SessionCreationHostContinuationV1 } from '@happier-dev/protocol/actions/executor/types';
import type { CreateSpawnedSessionParams } from '@/session/services/createSpawnedSession';

/** Host-only initial turn. Template text is data; the sample task is not an instruction to execute. */
export function buildHostOnboardingInput(
  onboarding: NonNullable<SessionCreationHostContinuationV1['hostOnboarding']>,
): Pick<CreateSpawnedSessionParams, 'initialInput' | 'buildInitialInputHandoff'> {
  const prepared = buildSessionHostOnboardingInputV1(onboarding);
  return {
    initialInput: prepared.initialInput,
    buildInitialInputHandoff: () => ({ inputAdmission: prepared.inputAdmission }),
  };
}
