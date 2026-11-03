import { setMachineAccessGrantInTx } from '@/app/machines/machineAccess';
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';

type Tx = Parameters<typeof setMachineAccessGrantInTx>[0];

/**
 * Fixture writer: makes an Account recipient the actor's friend (the one share-eligibility rule),
 * then grants through the real Machine grant writer.
 */
export async function setEligibleMachineAccessGrantInTx(
  tx: Tx,
  input: Parameters<typeof setMachineAccessGrantInTx>[1],
): ReturnType<typeof setMachineAccessGrantInTx> {
  if (input.principal.kind === 'account') {
    await makeShareEligibleForTest(input.actorAccountId, input.principal.accountId, tx);
  }
  return setMachineAccessGrantInTx(tx, input);
}
