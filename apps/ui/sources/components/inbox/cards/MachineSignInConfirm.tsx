import * as React from 'react';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import type { InboxMachineSignInTarget } from '@/components/inbox/inboxItems';
import { presentActionExecutionFailure } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { alertActionFailure } from '@/utils/errors/alertActionFailure';
import { t } from '@/text';

/** The row is itself a target: its button keeps to its own gaps (as the approval rows' answers do). */
const ROW_BUTTON_REACH = { top: 0, bottom: 0 } as const;

/**
 * A pending machine sign-in's one answer from its Inbox row: "Confirm sign-in", through the member-client approval
 * the Machine's page uses. A confirmed row keeps no button while the occurrence's owner withdraws it; a refusal is
 * said by the shared failure presentation and the action is offered again.
 */
export const MachineSignInConfirm = React.memo(function MachineSignInConfirm(
  props: Readonly<{
    target: InboxMachineSignInTarget;
    confirm: (target: InboxMachineSignInTarget) => Promise<ActionExecuteResult>;
    testID: string;
  }>,
) {
  const [phase, setPhase] = React.useState<'idle' | 'confirming' | 'confirmed'>(
    'idle',
  );
  const running = React.useRef(false);
  const { confirm, target } = props;
  const run = React.useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setPhase('confirming');
    let result: ActionExecuteResult;
    try {
      result = await confirm(target);
    } catch {
      result = {
        ok: false,
        errorCode: 'action_failed',
        error: 'action_failed',
      };
    }
    running.current = false;
    if (result.ok) {
      setPhase('confirmed');
      return;
    }
    setPhase('idle');
    const presentation = presentActionExecutionFailure(result);
    alertActionFailure({
      // The opener's own refusal: the task it was bound to is no longer the one waiting.
      reason: result.errorCode === 'no_prompt' ? t('machineSignIn.notWaiting') : (presentation.reason ?? result.error),
      code: result.errorCode,
      requestId: result.requestId,
      context: Object.fromEntries(
        presentation.technicalDetails
          .filter((line) => line.key !== 'code' && line.key !== 'requestId')
          .map((line) => [line.key, line.value]),
      ),
    });
  }, [confirm, target]);
  if (phase === 'confirmed') return null;
  return (
    <RoundButton
      testID={props.testID}
      size="small"
      display="secondary"
      hitReach={ROW_BUTTON_REACH}
      title={t('machineSignIn.confirm')}
      loading={phase === 'confirming'}
      disabled={phase !== 'idle'}
      onPress={() => {
        void run();
      }}
    />
  );
});
