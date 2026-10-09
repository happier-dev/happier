import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useActionOperationStopControl } from '@/components/inbox/actionOperations/useActionOperationStopControl';
import { useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { ApprovalDecisionFooter } from '@/components/tools/shell/approvals/ApprovalDecisionFooter';
import { ApprovalPromptChrome } from '@/components/tools/shell/approvals/ApprovalPromptChrome';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { actionOperationAddressKey } from '@/sync/domains/actionOperations/qualifiedActionOperation';
import { useSessionActionOperations } from '@/sync/domains/actionOperations/useActionOperations';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { useServerScopedMachine } from '@/sync/store/hooks';
import { t } from '@/text';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';

import { rememberProjectSetupConsent } from './projectSetupConsentDecision';
import { listReviewedSetupCommands } from './projectSetupEffectPresentation';

type Decision = 'untilChanged';

/**
 * The session asks (lab `s-setup` ASK, plan 20s3 / D18): every live finite command this Session's
 * agent started that is held on a setup review shows the exact effect and asks the person here, like
 * any other approval in the transcript. The held operation is the source; nothing is inferred from tool
 * text. "Until it changes" writes the person's own Project Trust grant and the daemon resumes the same
 * original invocation; Deny stops that operation. An agent never reaches either decision.
 */
export const ProjectSetupSessionReviews = React.memo(
  function ProjectSetupSessionReviews(
    props: Readonly<{ sessionId: string; serverId?: string | null }>,
  ) {
    const serverId = props.serverId
      ? resolveServerProfileScopeIdForIdentifier(props.serverId)
      : null;
    const homes = React.useMemo(() => (serverId ? [serverId] : []), [serverId]);
    const bindings = useServerCredentialAccountScopeBindings(homes);
    const binding = serverId ? bindings.get(serverId) : undefined;
    const accountId = binding?.isCurrent() ? binding.accountId : null;
    const operations = useSessionActionOperations({
      serverId,
      sessionId: props.sessionId,
      accountId,
    });
    // A decided review stays as its settled line after the hold clears, for this mounted transcript.
    const [decided, setDecided] = React.useState<
      ReadonlyMap<
        string,
        Readonly<{ decision: Decision; operation: ActionOperationProjection }>
      >
    >(() => new Map());
    const onDecided = React.useCallback(
      (operation: ActionOperationProjection, decision: Decision) => {
        setDecided((current) =>
          new Map(current).set(reviewKey(operation), { decision, operation }),
        );
      },
      [],
    );
    if (!serverId || !accountId) return null;
    const scope: ServerAccountScope = { serverId, accountId };
    const live = operations.filter(
      (operation) =>
        operation.snapshot.setupReview !== undefined &&
        operation.snapshot.domainRef?.kind === 'projectCommand',
    );
    const liveKeys = new Set(live.map(reviewKey));
    const settled = [...decided.values()].filter(
      (entry) => !liveKeys.has(reviewKey(entry.operation)),
    );
    if (live.length === 0 && settled.length === 0) return null;
    return (
      <View style={styles.list}>
        {settled.map((entry) => (
          <ProjectSetupSessionReviewCard
            key={reviewKey(entry.operation)}
            operation={entry.operation}
            scope={scope}
            decided={entry.decision}
            onDecided={onDecided}
          />
        ))}
        {live.map((operation) => (
          <ProjectSetupSessionReviewCard
            key={reviewKey(operation)}
            operation={operation}
            scope={scope}
            decided={decided.get(reviewKey(operation))?.decision ?? null}
            onDecided={onDecided}
          />
        ))}
      </View>
    );
  },
);

function reviewKey(operation: ActionOperationProjection): string {
  return actionOperationAddressKey({
    serverId: operation.serverId,
    operationId: operation.snapshot.operationId,
  });
}

const ProjectSetupSessionReviewCard = React.memo(
  function ProjectSetupSessionReviewCard(
    props: Readonly<{
      operation: ActionOperationProjection;
      scope: ServerAccountScope;
      decided: Decision | null;
      onDecided: (
        operation: ActionOperationProjection,
        decision: Decision,
      ) => void;
    }>,
  ) {
    const { theme } = useUnistyles();
    const transcriptSource = useSessionTranscriptSource();
    const interaction = transcriptSource.useInteraction();
    const { operation, scope, onDecided } = props;
    const attachment =
      operation.snapshot.domainRef?.kind === 'projectCommand'
        ? operation.snapshot.domainRef
        : null;
    const review = operation.snapshot.setupReview ?? null;
    // Setup runs on the actual target the operation was admitted to.
    const machine = useServerScopedMachine(
      attachment?.serverId ?? null,
      attachment?.machineId ?? '',
    );
    const machineName =
      getMachineDisplayName(machine) ?? attachment?.machineId ?? '';
    const sharedRunAs = machine?.isShared
      ? (machine.metadata?.username ?? null)
      : null;
    const stop = useActionOperationStopControl(
      props.decided === null ? operation : null,
    );
    const [deciding, setDeciding] = React.useState(false);
    const testID = `project-setup-session-review:${operation.snapshot.operationId}`;

    const allow = React.useCallback(async () => {
      const workspace = attachment?.sourceWorkspace;
      if (!review || !workspace || deciding) return;
      setDeciding(true);
      try {
        const result = await rememberProjectSetupConsent({
          scope,
          workspace,
          reviewedEffectDigest: review.reviewedEffectDigest,
        });
        if (result.kind === 'remembered') onDecided(operation, 'untilChanged');
        else
          Modal.alert(
            t('common.error'),
            result.kind === 'changed'
              ? t('projects.authoring.effectChanged')
              : t('approvals.decisionError'),
          );
      } catch {
        Modal.alert(t('common.error'), t('approvals.decisionError'));
      } finally {
        setDeciding(false);
      }
    }, [
      attachment?.sourceWorkspace,
      deciding,
      onDecided,
      operation,
      review,
      scope,
    ]);
    const title = t('projects.authoring.sessionAsk', { machine: machineName });
    if (props.decided) {
      return (
        <ApprovalPromptChrome
          testID={testID}
          title={title}
          titleNumberOfLines={1}
          footer={
            <View style={styles.settled} testID={`${testID}.settled`}>
              <Icon
                name="check"
                size={14}
                color={theme.colors.text.secondary}
              />
              <Text
                style={[
                  styles.settledText,
                  { color: theme.colors.text.secondary },
                ]}
              >
                {t('projects.authoring.allowedUntilChanged')}
              </Text>
            </View>
          }
        />
      );
    }
    if (!review) return null;
    const commands = listReviewedSetupCommands(review.reviewedEffect);
    return (
      <ApprovalPromptChrome
        testID={testID}
        title={title}
        subtitle={
          review.code === 'project_setup_effect_changed'
            ? t('projects.authoring.effectChanged')
            : null
        }
        tone={
          review.code === 'project_setup_effect_changed'
            ? 'attention'
            : 'neutral'
        }
        footer={
          stop.stopRequested ? (
            // Requested, not settled: the held operation leaves this list only when it actually ends.
            <Text
              style={[
                styles.settledText,
                { color: theme.colors.text.secondary },
              ]}
              testID={`${testID}.stopping`}
            >
              {t('projects.scripts.run.stopping')}
            </Text>
          ) : (
            <ApprovalDecisionFooter
              testIDPrefix={testID}
              disabled={!interaction.canApprovePermissions}
              approveDisabled={!attachment?.sourceWorkspace}
              isDeciding={deciding || stop.pending}
              approveLabel={t('projects.authoring.allowUntilChanged')}
              rejectLabel={t('projects.authoring.deny')}
              onApprove={() => {
                void allow();
              }}
              onReject={stop.requestStop}
            />
          )
        }
      >
        <Text
          style={[styles.body, { color: theme.colors.text.secondary }]}
          testID={`${testID}.effect`}
        >
          {[commands?.join(' · '), t('projects.authoring.sessionAskScope')]
            .filter(Boolean)
            .join('. ')}
        </Text>
        {sharedRunAs ? (
          <Text
            style={[styles.body, { color: theme.colors.text.secondary }]}
            testID={`${testID}.shared`}
          >
            {t('projects.scripts.setup.sharedScope', {
              osUser: sharedRunAs,
              machine: machineName,
            })}
          </Text>
        ) : null}
      </ApprovalPromptChrome>
    );
  },
);

const styles = StyleSheet.create(() => ({
  list: { gap: 12, paddingTop: 12 },
  body: { fontSize: 12, lineHeight: 17 },
  settled: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  settledText: { fontSize: 12 },
}));
