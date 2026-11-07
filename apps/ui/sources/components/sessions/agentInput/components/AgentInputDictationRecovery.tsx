import * as React from 'react';

import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import type { TextInputDictation, TextInputDictationNotice } from '@/voice/dictation/useTextInputDictation';
import { resolveVoiceDictationFailureTranslationKey, voiceDictationFailureNeedsSetup } from '@/voice/dictation/voiceDictationErrorCopy';

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
 * Dictation's one recovery look, a quiet line beside the field for every failure (Paseo rank 1).
 *
 * A failure whose recording was kept names the cause and offers Retry, with Discard after it; a cause
 * fixed in Dictation's setup also offers Set up in its sentence. It stays while the recording is
 * retained, keeps its reason through a repeated failure, and leaves the field's text alone. Retry waits
 * while capture is still settling or a retry is already transcribing; both operations dispatch through
 * the field's Dictation Actions (`useTextInputDictation`). A dictation that kept nothing (a refused
 * microphone, a setup problem, no speech) is a `notice`: its cause, its one action and a close.
 */
export function AgentInputDictationRecovery(
  props: Readonly<{
    failure: TextInputDictation['failure'];
    notice: TextInputDictationNotice | null;
    status: TextInputDictation['status'];
    onRetry: TextInputDictation['onRetry'];
    onDiscard: TextInputDictation['onDiscard'];
    onDismissNotice: TextInputDictation['onDismissNotice'];
    onOpenSetup: TextInputDictation['onOpenSetup'];
    testID?: string;
  }>,
): React.ReactElement | null {
  const testID = props.testID ?? 'agent-input-dictation-recovery';
  if (!props.failure) {
    const { notice } = props;
    if (!notice) return null;
    return (
      <SurfaceStateCard
        testID={testID}
        size="line"
        kind={notice.kind === 'message' ? 'warning' : 'error'}
        accessibilitySemantics="alert"
        title={notice.title}
        action={notice.action ? { label: notice.action.label, testID: `${testID}-action`, onPress: notice.action.onPress } : undefined}
        secondaryAction={{ label: t('common.close'), testID: `${testID}-close`, onPress: props.onDismissNotice }}
      />
    );
  }
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
      reasonContent={voiceDictationFailureNeedsSetup(props.failure.reason) ? (
        <TextLinkButton testID={`${testID}-setup`} size="meta" label={t('voicePresence.recovery.setUp')} onPress={props.onOpenSetup} />
      ) : undefined}
      reason={voiceDictationFailureNeedsSetup(props.failure.reason) ? t('voicePresence.recovery.setUp') : undefined}
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
