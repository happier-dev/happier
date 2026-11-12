import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { Modal } from '@/modal';
import { ModalCardFooterActions } from '@/modal/components/card/ModalCardFooterActions';
import type { CustomModalInjectedProps } from '@/modal/types';
import { t } from '@/text';

import {
  ApprovalIncludedSteps,
  readApprovalIncludedSteps,
} from './ApprovalIncludedSteps';
import {
  DeploymentReviewApprovalFacts,
  readDeploymentReviewApproval,
} from './DeploymentReviewApprovalFacts';
import {
  ProjectCommandApprovalFacts,
  readProjectCommandApproval,
} from './ProjectCommandApprovalFacts';

/** The exact review a receiving executor carried back for the person's own press (`{ review, reviewDigest }`). */
export type ActionConfirmationReviewInput = Readonly<{
  actionId: string;
  actionArgs: unknown;
  preview: unknown;
}>;

/**
 * Whether a carried review has host-discovered facts beyond its one-line summary: the exact command a Service
 * starts, a deploy's reviewed effect, or the steps it includes. Those read through the same family presenters
 * the Inbox review uses; a summary-only review stays a sentence in the plain confirmation.
 */
export function hasActionConfirmationReviewFacts(
  input: ActionConfirmationReviewInput,
): boolean {
  return (
    readDeploymentReviewApproval({ preview: input.preview }) !== null ||
    readProjectCommandApproval(input) !== null ||
    readApprovalIncludedSteps(input.preview).length > 0
  );
}

/**
 * What the receiving executor reviewed, in the approval families' own presenters (the same pieces and order as
 * `useApprovalReview`'s sections). It decides nothing: the native confirmation and in-flow steps own the answer.
 */
export const ActionConfirmationReviewFacts = React.memo(
  function ActionConfirmationReviewFacts(
    props: ActionConfirmationReviewInput &
      Readonly<{
        serverId: string | null;
        testID: string;
      }>,
  ) {
    const { actionId, actionArgs, preview } = props;
    const deploymentReview = React.useMemo(
      () => readDeploymentReviewApproval({ preview }),
      [preview],
    );
    const projectCommand = React.useMemo(
      () =>
        deploymentReview
          ? null
          : readProjectCommandApproval({ actionId, actionArgs, preview }),
      [actionArgs, actionId, deploymentReview, preview],
    );
    return (
      <>
        {deploymentReview ? (
          <DeploymentReviewApprovalFacts
            approval={deploymentReview}
            serverId={props.serverId}
            testID={`${props.testID}.deployment`}
          />
        ) : projectCommand ? (
          // The dialog's title already names the Action: the command stands as its one block, unheaded.
          <ItemGroup>
            <SectionContentRow>
              <ProjectCommandApprovalFacts
                presentation={projectCommand}
                testID={`${props.testID}.command`}
              />
            </SectionContentRow>
          </ItemGroup>
        ) : (
          // The command or deploy effect already says what runs; included steps speak only when nothing else does.
          <ApprovalIncludedSteps
            preview={preview}
            serverId={props.serverId}
            testID={`${props.testID}.included-steps`}
          />
        )}
      </>
    );
  },
);

type ConfirmationReviewModalProps = CustomModalInjectedProps &
  ActionConfirmationReviewInput &
  Readonly<{
    serverId: string | null;
    confirmLabel: string;
    irreversible: boolean;
    onAnswer: (confirmed: boolean) => void;
  }>;

function ConfirmationReviewModal(props: ConfirmationReviewModalProps) {
  const { onAnswer, onClose, setChrome, confirmLabel, irreversible } = props;
  const answer = React.useCallback(
    (confirmed: boolean) => {
      onAnswer(confirmed);
      onClose();
    },
    [onAnswer, onClose],
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
        />
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
}));
