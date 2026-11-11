import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import type { TextInputDictation, TextInputDictationNotice } from '@/voice/dictation/useTextInputDictation';
import { resolveVoiceDictationFailureTranslationKey, voiceDictationFailureNeedsSetup } from '@/voice/dictation/voiceDictationErrorCopy';
import { DictationModelPackRecovery } from '@/voice/dictation/DictationModelPackRecovery';
import { AGENT_INPUT_QUIET_ICON_SIZE_PX } from './agentInputChromeStyles';

type RetainedDictationFailure = NonNullable<TextInputDictation['failure']>;

type DictationRecoveryActions = Pick<TextInputDictation, 'status' | 'onRetry' | 'onDiscard' | 'onOpenSetup'> & Readonly<{
  failure: RetainedDictationFailure;
  testID: string;
}>;

/** Both field layouts consume the same recovery actions and their availability. */
function projectDictationRecovery(props: DictationRecoveryActions) {
  const transcribing = props.status === 'transcribing';
  return {
    reason: t(resolveVoiceDictationFailureTranslationKey(props.failure.reason)),
    modelRecovery: props.failure.reason === 'transcription_model_not_installed' ? <DictationModelPackRecovery /> : null,
    setup: voiceDictationFailureNeedsSetup(props.failure.reason)
      ? { label: t('voicePresence.recovery.setUp'), onPress: props.onOpenSetup, testID: `${props.testID}-setup` }
      : null,
    retry: { label: t('common.retry'), testID: `${props.testID}-retry`,
      disabled: props.failure.canRetry !== true || transcribing, busy: transcribing, onPress: props.onRetry },
    discard: { label: t('common.discard'), testID: `${props.testID}-discard`,
      disabled: transcribing, onPress: props.onDiscard },
  };
}

/** The same kept-recording recovery in a plugin field's accessory slot. */
export function DictationRecoveryAccessory(props: DictationRecoveryActions): React.ReactElement {
  const recovery = projectDictationRecovery(props);
  return <View style={accessoryStyles.recovery}>
    {recovery.setup ? <IconButton testID={recovery.setup.testID} iconName="gear" variant="plain"
      size={AGENT_INPUT_QUIET_ICON_SIZE_PX} iconSize={16} accessibilityLabel={recovery.setup.label}
      tooltip={recovery.setup.label} tooltipPlacement="bottom" onPress={recovery.setup.onPress} /> : null}
    <IconButton testID={recovery.retry.testID} iconName="arrow-clockwise" variant="plain" tone="danger" size={AGENT_INPUT_QUIET_ICON_SIZE_PX} iconSize={16}
      accessibilityLabel={`${recovery.retry.label}. ${recovery.reason}`} tooltip={recovery.reason} tooltipPlacement="bottom"
      disabled={recovery.retry.disabled} onPress={() => { void recovery.retry.onPress(); }} />
    <IconButton testID={recovery.discard.testID} iconName="x" variant="plain" size={AGENT_INPUT_QUIET_ICON_SIZE_PX} iconSize={14}
      accessibilityLabel={recovery.discard.label} tooltip={recovery.discard.label} tooltipPlacement="bottom"
      disabled={recovery.discard.disabled} onPress={() => { void recovery.discard.onPress(); }} />
  </View>;
}

const accessoryStyles = StyleSheet.create((theme) => ({
  recovery: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s2 },
}));

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
 * A missing daemon model adds the existing pack installer beside the kept recording's Retry.
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
  const recovery = projectDictationRecovery({ ...props, failure: props.failure, testID });
  return (
    <>
      <SurfaceStateCard
        testID={testID}
        size="line"
        kind="error"
        accessibilitySemantics="alert"
        title={recovery.reason}
        reasonContent={recovery.setup ? (
          <TextLinkButton testID={recovery.setup.testID} size="meta" label={recovery.setup.label} onPress={recovery.setup.onPress} />
        ) : undefined}
        reason={recovery.setup?.label}
        action={recovery.retry}
        secondaryAction={recovery.discard}
      />
      {recovery.modelRecovery}
    </>
  );
}
