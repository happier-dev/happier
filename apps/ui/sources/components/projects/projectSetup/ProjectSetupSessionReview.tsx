import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { useActionOperationStopControl } from '@/components/inbox/actionOperations/useActionOperationStopControl';
import { useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { ApprovalDecisionFooter } from '@/components/tools/shell/approvals/ApprovalDecisionFooter';
import { ApprovalPromptChrome } from '@/components/tools/shell/approvals/ApprovalPromptChrome';
import { alertApprovalFailure } from '@/components/tools/shell/approvals/useApprovalDecisionHandler';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { actionOperationAddressKey } from '@/sync/domains/actionOperations/qualifiedActionOperation';
import { useSessionActionOperations } from '@/sync/domains/actionOperations/useActionOperations';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeBindings, type ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';

import { decideProjectSetupConsent, type ProjectSetupDecision } from './projectSetupConsentDecision';
import { DEFAULT_PROJECT_SETUP_SCOPE, ProjectSetupReviewFacts, ProjectSetupScopeChoice, projectSetupRunLabel } from './ProjectSetupReview';
import { useProjectSetupMachine } from './useProjectSetupMachine';

type Decision = ProjectSetupDecision;

/**
 * The session asks (lab `s-setup` ASK, plan 20s3 / D18): every live finite command this Session's
 * agent started that is held on a setup review shows the exact effect and asks the person here, like
 * any other approval in the transcript. The held operation is the source; nothing is inferred from tool
 * text. This time and Skip decide the original target-held invocation; Until it changes writes the
 * person's Project Trust grant. Deny stops that operation. An agent cannot supply these decisions.
 */
export const ProjectSetupSessionReviews = React.memo(
  function ProjectSetupSessionReviews(
    props: Readonly<{ sessionId: string; serverId?: string | null }>,
  ) {
    const transcriptSource = useSessionTranscriptSource();
    const interaction = transcriptSource.useInteraction();
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
        Readonly<{ decision: Decision; operation: ActionOperationProjection; binding: ServerCredentialAccountScopeBinding; digest: string }>
      >
    >(() => new Map());
    React.useEffect(() => {
      if (!binding) return;
      const retirement = binding.onRetire(() => setDecided((current) =>
        new Map([...current].filter(([, entry]) => entry.binding !== binding)),
      ));
      return () => retirement.dispose();
    }, [binding]);
    const onDecided = React.useCallback(
      (operation: ActionOperationProjection, decision: Decision) => {
        const digest = operation.snapshot.setupReview?.reviewedEffectDigest;
        if (!binding?.isCurrent() || operation.snapshot.scope.accountId !== binding.accountId || !digest) return;
        setDecided((current) => {
          if (!binding.isCurrent()) return current;
          const next = new Map([...current].filter(([, entry]) => reviewKey(entry.operation) !== reviewKey(operation)));
          next.set(JSON.stringify([binding.accountId, reviewKey(operation), digest]), { decision, operation, binding, digest });
          return next;
        });
      },
      [binding],
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
      (entry) => entry.binding === binding && entry.binding.isCurrent() && !liveKeys.has(reviewKey(entry.operation)),
    );
    if (live.length === 0 && settled.length === 0) return null;
    return (
      <View style={styles.list}>
        {settled.map((entry) => (
          <ProjectSetupConsentReviewCard
            key={JSON.stringify([entry.binding.accountId, reviewKey(entry.operation), entry.digest])}
            operation={entry.operation}
            scope={scope}
            decided={entry.decision}
            onDecided={onDecided}
            canApprovePermissions={interaction.canApprovePermissions}
          />
        ))}
        {live.map((operation) => (
          <ProjectSetupConsentReviewCard
            key={JSON.stringify([accountId, reviewKey(operation), operation.snapshot.setupReview?.reviewedEffectDigest])}
            operation={operation}
            scope={scope}
            decided={null}
            onDecided={onDecided}
            canApprovePermissions={interaction.canApprovePermissions}
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

export const ProjectSetupConsentReviewCard = React.memo(
  function ProjectSetupConsentReviewCard(
    props: Readonly<{
      operation: ActionOperationProjection;
      scope: ServerAccountScope;
      decided: Decision | null;
      canApprovePermissions: boolean;
      onDecided: (
        operation: ActionOperationProjection,
        decision: Decision,
      ) => void;
    }>,
  ) {
    const { theme } = useUnistyles();
    const { operation, scope, onDecided } = props;
    const attachment =
      operation.snapshot.domainRef?.kind === 'projectCommand'
        ? operation.snapshot.domainRef
        : null;
    const review = operation.snapshot.setupReview ?? null;
    // Setup runs on the actual target the operation was admitted to.
    const { machineName, sharedRunAs } = useProjectSetupMachine(
      attachment?.serverId ?? null,
      attachment?.machineId ?? null,
    );
    const stop = useActionOperationStopControl(
      props.decided === null ? operation : null,
    );
    const [deciding, setDeciding] = React.useState(false);
    const [decision, setDecision] = React.useState<Decision>(DEFAULT_PROJECT_SETUP_SCOPE);
    const testID = `project-setup-session-review:${operation.snapshot.operationId}`;
    const lifetime = React.useMemo(() => new AbortController(), [scope.serverId, scope.accountId]);
    React.useEffect(() => () => lifetime.abort(), [lifetime]);
    const approval = useActionApprovalContinuation({ scopeKey: JSON.stringify([scope, testID]),
      serverId: scope.serverId, onExecuted: () => {} });

    const allow = React.useCallback(async () => {
      const workspace = attachment?.sourceWorkspace;
      if (!review || !workspace || deciding) return;
      setDeciding(true);
      try {
        const result = await decideProjectSetupConsent({
          scope,
          workspace,
          operation,
          reviewedEffectDigest: review.reviewedEffectDigest,
          decision, signal: lifetime.signal, onApprovalPending: approval.requestApproval,
        });
        if (result.kind === 'remembered' || result.kind === 'continued') onDecided(operation, decision);
        else if (result.kind === 'changed') Modal.alert(t('common.error'), t('projects.authoring.effectChanged'));
        else alertApprovalFailure({ errorCode: result.code });
      } catch (error) {
        alertApprovalFailure(error);
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
      decision,
      lifetime,
      approval.requestApproval,
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
                {props.decided === 'untilChanged' ? t('projects.authoring.allowedUntilChanged')
                  : t(props.decided === 'skip' ? 'projects.scripts.setup.consequenceSkip' : 'projects.scripts.setup.consequenceThisTime')}
              </Text>
            </View>
          }
        />
      );
    }
    if (!review) return null;
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
              disabled={!props.canApprovePermissions}
              approveDisabled={!attachment?.sourceWorkspace}
              isDeciding={deciding || stop.pending}
              approveLabel={decision === 'skip' ? t('common.skip') : projectSetupRunLabel(machineName, sharedRunAs)}
              rejectLabel={t('projects.authoring.deny')}
              onApprove={() => {
                void allow();
              }}
              onReject={stop.requestStop}
            />
          )
        }
      >
        <ProjectSetupReviewFacts
          testID={testID}
          reviewedEffect={review.reviewedEffect}
          machineName={machineName}
          sharedRunAs={sharedRunAs}
        />
        <ProjectSetupScopeChoice testID={testID} scope={decision} onChange={setDecision} />
      </ApprovalPromptChrome>
    );
  },
);

const styles = StyleSheet.create(() => ({
  list: { gap: 12, paddingTop: 12 },
  settled: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  settledText: { ...Typography.default(), ...happierPageTextMetrics('rowDescription') },
}));
