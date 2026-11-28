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
import { SharePrincipalNamesContext } from '@/components/sharing/sharePrincipalNames';
import { isDeploymentRolloutActionIdV1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { storage } from '@/sync/domains/state/storageStore';
import { getMachineSentenceName } from '@/utils/sessions/machineDisplayNames';
import { ApprovalReviewFacts, type ApprovalReviewFactsInput } from './ApprovalReviewFacts';
import { describeDeploymentBackupConfigureDecision, describeDeploymentReviewDecision, readDeploymentReviewApproval, readSoleDeploymentReviewMachineId,
  useDeploymentEnvironmentDecision } from './DeploymentReviewApprovalFacts';

/** The exact review a receiving executor carried back for the person's own press (`{ review, reviewDigest }`). */
export type ActionConfirmationReviewInput = Pick<ApprovalReviewFactsInput, 'actionId' | 'actionArgs' | 'preview'> & Readonly<{
  principalNames?: ReadonlyMap<string, string>;
  presetSubject?: React.ComponentProps<typeof ApprovalReviewFacts>['presetSubject'];
}>;

type TypedConfirmation = Readonly<{ text: string; placeholder?: string; instruction?: string }>;
type ReviewNotice = Readonly<{ title: string; body: string }>;
type ReviewRetryResult = Readonly<{ ok: true; preview: unknown; summary: string | null }>
  | Readonly<{ ok: false; notice: ReviewNotice }>;
type ReviewRecovery = Readonly<{ notice: ReviewNotice; retry: () => Promise<ReviewRetryResult> }>;

/** The same family facts as a retained approval, without requiring an Artifact. */
export const ActionConfirmationReviewFacts = React.memo(function ActionConfirmationReviewFacts(
  props: ActionConfirmationReviewInput & Readonly<{ serverId: string | null; testID: string; summaryPlacement?: 'body' | 'host' }>,
) {
  return <SharePrincipalNamesContext.Provider value={props.principalNames
    ? { serverId: props.serverId, names: props.principalNames } : null}>
    <ApprovalReviewFacts {...props} />
  </SharePrincipalNamesContext.Provider>;
});

type ConfirmationReviewModalProps = CustomModalInjectedProps &
  ActionConfirmationReviewInput &
  Readonly<{
    serverId: string | null;
    confirmLabel: string;
    irreversible: boolean;
    /** A removal the person can recover from still confirms with a destructive verb, without the irreversible note. */
    destructive?: boolean;
    summaryPlacement?: 'body' | 'host';
    typedConfirmation?: TypedConfirmation;
    reviewRecovery?: ReviewRecovery;
    onAnswer: (confirmed: boolean) => void;
  }>;

function ConfirmationReviewModal(props: ConfirmationReviewModalProps) {
  const { onAnswer, onClose, setChrome, irreversible, destructive, typedConfirmation, reviewRecovery } = props;
  // An Environment update or a preview Create says what it does once its Project and Environment are read
  // ("Turn on previews for field-guide-site Production"): the card's title and its verb, never the Action's name.
  const environmentDecision = useDeploymentEnvironmentDecision(props, props.serverId);
  const confirmLabel = environmentDecision ?? props.confirmLabel;
  const [typedValue, setTypedValue] = React.useState('');
  const [retryResult, setRetryResult] = React.useState<ReviewRetryResult | null>(null);
  const [retrying, setRetrying] = React.useState(false);
  const notice = retryResult ? (retryResult.ok ? null : retryResult.notice) : reviewRecovery?.notice;
  const retryReview = React.useCallback(async () => {
    if (!reviewRecovery || retrying) return;
    setRetrying(true);
    try {
      setRetryResult(await reviewRecovery.retry());
    } finally {
      setRetrying(false);
    }
  }, [reviewRecovery, retrying]);
  const answer = React.useCallback(
    (confirmed: boolean) => {
      onAnswer(confirmed && !notice && (typedConfirmation === undefined || typedValue === typedConfirmation.text));
      onClose();
    },
    [notice, onAnswer, onClose, typedConfirmation, typedValue],
  );
  React.useEffect(() => {
    setChrome?.({
      kind: 'card',
      ...(environmentDecision ? { title: environmentDecision } : {}),
      ...(retryResult?.ok && retryResult.summary ? { subtitle: retryResult.summary } : {}),
      footer: (
        // The same footer as every other confirmation card: Cancel, then the Action's verb, trailing.
        <ModalCardFooterActions
          cancel={{ onPress: () => answer(false), testID: 'actions.confirmation-review.decision-reject' }}
          note={!notice && irreversible ? t('approvals.irreversibleNote') : null}
          noteTestID="approvals.irreversible-note"
        >
          {notice ? <RoundButton
            testID="actions.confirmation-review.retry-review"
            size="normal"
            title={t('common.retry')}
            onPress={retryReview}
            loading={retrying}
            disabled={retrying}
          /> : <RoundButton
            testID="actions.confirmation-review.decision-approve"
            size="normal"
            display={irreversible || destructive ? 'destructive' : 'default'}
            title={confirmLabel}
            onPress={() => answer(true)}
          />}
        </ModalCardFooterActions>
      ),
    });
  }, [answer, confirmLabel, destructive, environmentDecision, irreversible, notice, retryResult, retryReview, retrying, setChrome]);
  return (
    <ListPresentationProvider value="page" pageInsets="contained">
      <View testID="actions.confirmation-review" style={styles.body}>
        {/* A typed challenge answers the card's lead, so it sits right under it; the request's facts and their Technical
            details close the card rather than standing between the question and its answer (R19-D6). */}
        {typedConfirmation && !notice ? <View style={styles.challenge}>
          {typedConfirmation.instruction ? <Text variant="body">{typedConfirmation.instruction}</Text> : null}
          <FieldTextInput testID="actions.confirmation-review.typed-confirmation"
            accessibilityLabel={typedConfirmation.text} value={typedValue} onChangeText={setTypedValue}
            placeholder={typedConfirmation.placeholder ?? typedConfirmation.text} autoCapitalize="none"
            onSubmitEditing={() => answer(true)} returnKeyType="done" />
        </View> : null}
        {notice ? <View accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.challenge}>
          <Text variant="body" emphasis="semiBold">{notice.title}</Text>
          <Text variant="body">{notice.body}</Text>
        </View> : <ActionConfirmationReviewFacts
          actionId={props.actionId}
          actionArgs={props.actionArgs}
          preview={retryResult?.ok ? retryResult.preview : props.preview}
          principalNames={props.principalNames}
          presetSubject={props.presetSubject}
          serverId={props.serverId}
          testID="actions.confirmation-review"
          summaryPlacement={props.summaryPlacement}
        />}
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
      reviewRecovery?: ReviewRecovery;
      confirmLabel: string;
      irreversible: boolean;
      destructive?: boolean;
      serverId: string | null;
      signal?: AbortSignal;
    }>,
): Promise<boolean> {
  const deployment = isDeploymentRolloutActionIdV1(input.actionId) ? readDeploymentReviewApproval(input) : null;
  const machineId = readSoleDeploymentReviewMachineId(deployment);
  const machine = machineId ? resolveServerScopedMachine(storage.getState(), input.serverId, machineId) : null;
  const decision = describeDeploymentReviewDecision(deployment, input.actionId, machine ? getMachineSentenceName(machine) : null)
    ?? describeDeploymentBackupConfigureDecision(input.actionId, input.actionArgs);
  const summary = (decision && 'description' in decision ? decision.description : null) ?? input.summary;
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
        principalNames: input.principalNames,
        presetSubject: input.presetSubject,
        serverId: input.serverId,
        confirmLabel: decision?.approve ?? input.confirmLabel,
        irreversible: input.irreversible,
        destructive: input.destructive === true,
        summaryPlacement: input.summaryPlacement,
        typedConfirmation: input.typedConfirmation,
        reviewRecovery: input.reviewRecovery,
        onAnswer: settle,
      },
      onRequestClose: () => settle(false),
      onHostUnmount: () => settle(false),
      // A stray click outside never answers a consent; Close, Escape and the decisions do.
      closeOnBackdrop: false,
      chrome: {
        kind: 'card',
        title: decision?.title ?? input.title,
        ...(summary ? { subtitle: summary } : {}),
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
