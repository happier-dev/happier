import { projectExternalActionBrowserSessionIdV1 } from '@happier-dev/protocol/actions/executor/browser';
import type { ExternalActionExecutionAuthorizationBindingV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { resolveEffectiveSessionAccess } from '@/app/session/access/sessionAccess';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import type { Tx } from '@/storage/inTx';

/** One Session-access decision when minting a Use guest's Browser command. */
export async function admitExternalActionBrowserSessionInTx(reader: Tx, input: Readonly<{
    binding: ExternalActionExecutionAuthorizationBindingV1;
    actionInput?: unknown;
    browserSessionId?: string;
    authentication: SessionAccessAuthentication;
}>): Promise<boolean> {
    const binding = input.binding;
    if (binding.accountId === binding.custodianAccountId || binding.admittedMachineRole === 'manage') return true;
    const sessionId = input.browserSessionId ?? projectExternalActionBrowserSessionIdV1(binding.actionId, input.actionInput);
    // Session-less Browser operations retain their domain owner's addressing.
    // Encrypted routing must match the actual operands before the receiver executes.
    if (!sessionId) return true;
    return await resolveEffectiveSessionAccess(reader, { accountId: binding.accountId,
        sessionId, authentication: input.authentication }) !== null;
}
