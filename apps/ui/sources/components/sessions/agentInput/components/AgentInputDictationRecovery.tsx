import * as React from 'react';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import type { TextInputDictation } from '@/voice/dictation/useTextInputDictation';
import { resolveVoiceDictationFailureTranslationKey } from '@/voice/dictation/voiceDictationErrorCopy';

type RetainedDictationFailure = NonNullable<TextInputDictation['failure']>;

/**
 * The failure the recovery line shows. The controller drops its failure while a Retry transcribes the
 * kept recording; the line keeps that cause in place (its Retry busy) until the retry settles, so the
 * field does not jump and a repeated failure reads as the same line. Success, Discard or a new start
 * clear it. A failure without a kept recording (`canRetry` absent) is not this line's.
 */
export function useDictationRecoveryFailure(
  failure: TextInputDictation['failure'],
  status: TextInputDictation['status'],
): RetainedDictationFailure | null {
  const shown = React.useRef<RetainedDictationFailure | null>(null);
  const retained = failure && failure.canRetry !== undefined ? failure : null;
  if (retained) shown.current = retained;
  else if (status !== 'transcribing') shown.current = null;
  return shown.current;
}

/**
 * A failed dictation whose recording was kept (Paseo rank 1): one quiet line beside the field that
 * names the cause and offers Retry, with Discard after it. It stays while the recording is retained,
 * keeps its reason through a repeated failure, and leaves the field's text alone. Retry waits while
 * capture is still settling or a retry is already transcribing; both operations dispatch through the
 * field's Dictation Actions (`useTextInputDictation`).
 */
export function AgentInputDictationRecovery(
  props: Readonly<{
    failure: NonNullable<TextInputDictation['failure']>;
    status: TextInputDictation['status'];
    onRetry: TextInputDictation['onRetry'];
    onDiscard: TextInputDictation['onDiscard'];
    testID?: string;
  }>,
): React.ReactElement {
  const testID = props.testID ?? 'agent-input-dictation-recovery';
  const transcribing = props.status === 'transcribing';
  return (
    <SurfaceStateCard
      testID={testID}
      size="line"
      kind="error"
      accessibilitySemantics="alert"
      title={t(
        resolveVoiceDictationFailureTranslationKey(props.failure.reason),
      )}
      action={{
        label: t('common.retry'),
        testID: `${testID}-retry`,
        disabled: props.failure.canRetry !== true || transcribing,
        busy: transcribing,
        onPress: props.onRetry,
      }}
      secondaryAction={{
        label: t('common.discard'),
        testID: `${testID}-discard`,
        disabled: transcribing,
        onPress: props.onDiscard,
      }}
    />
  );
}
