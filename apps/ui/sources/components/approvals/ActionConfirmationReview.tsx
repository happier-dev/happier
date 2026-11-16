import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';

import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { ModalCardFooterActions } from '@/modal/components/card/ModalCardFooterActions';
import type { CustomModalInjectedProps } from '@/modal/types';
import { t } from '@/text';
import { ApprovalReviewFacts, type ApprovalReviewFactsInput } from './ApprovalReviewFacts';

/** The exact review a receiving executor carried back for the person's own press (`{ review, reviewDigest }`). */
export type ActionConfirmationReviewInput = Pick<ApprovalReviewFactsInput, 'actionId' | 'actionArgs' | 'preview'>;

type TypedConfirmation = Readonly<{ text: string; placeholder?: string; instruction?: string }>;

/** The same family facts as a retained approval, without requiring an Artifact. */
export const ActionConfirmationReviewFacts = React.memo(function ActionConfirmationReviewFacts(
  props: ActionConfirmationReviewInput & Readonly<{ serverId: string | null; testID: string; summaryPlacement?: 'body' | 'host' }>,
) {
  return <ApprovalReviewFacts {...props} />;
});

type ConfirmationReviewModalProps = CustomModalInjectedProps &
  ActionConfirmationReviewInput &
  Readonly<{
    serverId: string | null;
    confirmLabel: string;
    irreversible: boolean;
    summaryPlacement?: 'body' | 'host';
    typedConfirmation?: TypedConfirmation;
    onAnswer: (confirmed: boolean) => void;
  }>;

function ConfirmationReviewModal(props: ConfirmationReviewModalProps) {
  const { onAnswer, onClose, setChrome, confirmLabel, irreversible, typedConfirmation } = props;
  const [typedValue, setTypedValue] = React.useState('');
  const answer = React.useCallback(
    (confirmed: boolean) => {
      onAnswer(confirmed && (typedConfirmation === undefined || typedValue === typedConfirmation.text));
      onClose();
    },
    [onAnswer, onClose, typedConfirmation, typedValue],
  );
  React.useEffect(() => {
    setChrome?.({
      kind: 'card',
      footer: (
        // The same footer as every other confirmation card: Cancel, then the Action's verb, trailing.
        <ModalCardFooterActions
          cancel={{ onPress: () => answer(false), testID: 'actions.confirmation-review.decision-reject' }}
          note={irreversible ? t('approvals.irreversibleNote') : null}
          noteTestID="approvals.irreversible-note"
        >
          <RoundButton
            testID="actions.confirmation-review.decision-approve"
            size="normal"
            display={irreversible ? 'destructive' : 'default'}
            title={confirmLabel}
            onPress={() => answer(true)}
          />
        </ModalCardFooterActions>
      ),
    });
  }, [answer, confirmLabel, irreversible, setChrome]);
  return (
    <ListPresentationProvider value="page" pageInsets="contained">
      <View testID="actions.confirmation-review" style={styles.body}>
        <ActionConfirmationReviewFacts
          actionId={props.actionId}
          actionArgs={props.actionArgs}
          preview={props.preview}
          serverId={props.serverId}
          testID="actions.confirmation-review"
          summaryPlacement={props.summaryPlacement}
        />
        {typedConfirmation ? <View style={styles.challenge}>
          {typedConfirmation.instruction ? <Text variant="body">{typedConfirmation.instruction}</Text> : null}
          <FieldTextInput testID="actions.confirmation-review.typed-confirmation"
            accessibilityLabel={typedConfirmation.text} value={typedValue} onChangeText={setTypedValue}
            placeholder={typedConfirmation.placeholder ?? typedConfirmation.text} autoCapitalize="none"
            onSubmitEditing={() => answer(true)} returnKeyType="done" />
        </View> : null}
      </View>
    </ListPresentationProvider>
  );
}

/**
 * The person's native confirmation of a receiving executor's carried review: the Action's question and consequence
 * lead, the reviewed facts fill the body, and the decision stays in the card's footer (a bottom sheet on a phone).
 * Closing it is a cancel.
 */
export function confirmActionReview(
  input: ActionConfirmationReviewInput &
    Readonly<{
      title: string;
      summary: string | null;
      /** Custom hosts keep local annotations in chrome; the default presenter already places the review sentence there. */
      summaryPlacement?: 'body' | 'host';
      typedConfirmation?: TypedConfirmation;
      confirmLabel: string;
      irreversible: boolean;
      serverId: string | null;
      signal?: AbortSignal;
    }>,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (confirmed: boolean) => {
      if (settled) return;
      settled = true;
      input.signal?.removeEventListener('abort', onAbort);
      resolve(confirmed);
    };
    const onAbort = () => {
      Modal.hide(id);
      settle(false);
    };
    const id = Modal.show({
      component: ConfirmationReviewModal,
      props: {
        actionId: input.actionId,
        actionArgs: input.actionArgs,
        preview: input.preview,
        serverId: input.serverId,
        confirmLabel: input.confirmLabel,
        irreversible: input.irreversible,
        summaryPlacement: input.summaryPlacement,
        typedConfirmation: input.typedConfirmation,
        onAnswer: settle,
      },
      onRequestClose: () => settle(false),
      onHostUnmount: () => settle(false),
      // A stray click outside never answers a consent; Close, Escape and the decisions do.
      closeOnBackdrop: false,
      chrome: {
        kind: 'card',
        title: input.title,
        ...(input.summary ? { subtitle: input.summary } : {}),
        testID: 'actions.confirmation-review.modal',
        phonePresentation: 'sheet',
        scrollHost: 'bounded',
        bodyScroll: 'auto',
        dimensions: {
          width: HAPPIER_PAGE_METRICS.dialogWidthPx.wide,
          maxHeightRatio: 0.9,
          size: 'md',
        },
      },
    });
    if (input.signal?.aborted) onAbort();
    else input.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const styles = StyleSheet.create((theme) => ({
  // Card chrome pads only its header and footer; the body aligns with the title's edge.
  body: { gap: theme.space.s16, paddingHorizontal: theme.space.s16, paddingBottom: theme.space.s16 },
  challenge: { gap: theme.space.s8 },
}));
