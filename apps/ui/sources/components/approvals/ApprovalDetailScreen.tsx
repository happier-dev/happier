import * as React from 'react';
import { View, ScrollView } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import {
  ApprovalRequestV1Schema,
  ExecutionRunHostActionApprovalRequestV1Schema,
  TargetActionApprovalRequestV1Schema,
  getActionSpec,
  type ActionId,
  type ExecutionRunHostActionApprovalRequestV1,
  type TargetActionApprovalRequestV1,
} from '@happier-dev/protocol';

import { Text } from '@/components/ui/text/Text';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Modal } from '@/modal';
import { t } from '@/text';
import { sync } from '@/sync/sync';
import { storage, useArtifact, useMachine, useSession } from '@/sync/domains/state/storage';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { readDisplayMachineIdForSession } from '@/sync/ops/sessionMachineTarget';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { ApprovalSessionContextCard } from './ApprovalSessionContextCard';
import { ActionApprovalFieldsCard } from './ActionApprovalFieldsCard';
import { ApprovalPreviewCard } from './ApprovalPreviewCard';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background.canvas,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 64,
    width: '100%',
    alignSelf: 'center',
  },
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: theme.colors.text.primary,
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: theme.colors.text.secondary,
    marginBottom: 16,
  },
  cardStack: {
    gap: 12,
  },
  statusCard: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.colors.border.default,
    backgroundColor: theme.colors.surface.elevated,
    padding: 16,
    gap: 8,
  },
  statusLabel: {
    fontSize: 12,
    color: theme.colors.text.secondary,
    fontWeight: '600',
  },
  statusValue: {
    fontSize: 14,
    color: theme.colors.text.primary,
  },
  statusMeta: {
    fontSize: 12,
    color: theme.colors.text.secondary,
  },
  actionsRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 16,
  },
}));

function formatApprovalStatusLabel(status: string): string {
  switch (status) {
    case 'open':
      return t('approvals.status.open');
    case 'approved':
      return t('approvals.status.approved');
    case 'rejected':
      return t('approvals.status.rejected');
    case 'executed':
      return t('approvals.status.executed');
    case 'failed':
      return t('approvals.status.failed');
    case 'canceled':
      return t('approvals.status.canceled');
    default:
      return status;
  }
}

export const ApprovalDetailScreen = React.memo((props: Readonly<{ artifactId: string }>) => {
  // Composed at render time: the module-scope stylesheet evaluates once, so a
  // baked-in `layout.maxWidth` would freeze the user's content-width preference.
  const contentMaxWidthStyle = useLayoutMaxWidthStyle();
  const scrollContentStyle = React.useMemo(
    () => [styles.scrollContent, contentMaxWidthStyle],
    [contentMaxWidthStyle],
  );
  const router = useRouter();
  const { theme } = useUnistyles();
  const artifact = useArtifact(props.artifactId);
  const [isLoading, setIsLoading] = React.useState(
    artifact?.isDecrypted !== false && artifact?.body == null,
  );
  const [error, setError] = React.useState<string | null>(null);
  const [isDeciding, setIsDeciding] = React.useState(false);
  const decisionInFlightRef = React.useRef(false);

  const executor = React.useMemo(
    () => createDefaultActionExecutor({
      resolveServerIdForSessionId: (sessionId) => resolvePreferredServerIdForSessionId(sessionId) ?? null,
    }),
    [],
  );

  React.useEffect(() => {
    if (artifact?.isDecrypted === false || artifact?.body != null) return;

    let cancelled = false;

    (async () => {
      try {
        setIsLoading(true);
        setError(null);

        const credentials = sync.getCredentials();
        if (!credentials) throw new Error('Not authenticated');

        const full = await sync.fetchArtifactWithBody(props.artifactId);
        if (!cancelled && full) {
          storage.getState().updateArtifact(full);
        } else if (!cancelled) {
          setError(t('approvals.loadError'));
        }
      } catch (err) {
        if (!cancelled) {
          setError(t('approvals.loadError'));
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [artifact, props.artifactId]);

  const parsed = React.useMemo(() => {
    if (!artifact || typeof artifact.body !== 'string') return null;
    try {
      const json = JSON.parse(artifact.body);
      if (artifact.header?.kind === 'execution_run_host_action_approval.v1') {
        const hostAction = ExecutionRunHostActionApprovalRequestV1Schema.safeParse(json);
        if (!hostAction.success) return null;
        const request = hostAction.data;
        if (artifact.header.approvalStatus !== request.status
          || artifact.header.actionId !== request.actionId
          || artifact.header.sessionId !== request.sessionId
          || artifact.header.runId !== request.runId
          || artifact.header.serverId !== request.serverId
          || artifact.header.subjectFingerprint !== request.subjectFingerprint
          || artifact.header.title !== request.summary) return null;
        return { kind: 'host_action' as const, request };
      }
      if (artifact.header?.kind === 'target_action_approval.v1') {
        const targetAction = TargetActionApprovalRequestV1Schema.safeParse(json);
        if (!targetAction.success) return null;
        const request = targetAction.data;
        if (artifact.header.approvalStatus !== request.status
          || artifact.header.qualifiedActionId !== request.qualifiedActionId
          || artifact.header.subjectFingerprint !== request.subjectFingerprint
          || artifact.header.title !== request.summary) {
          return null;
        }
        return { kind: 'target' as const, request };
      }
      if (artifact.header?.kind === 'approval_request.v1') {
        const builtIn = ApprovalRequestV1Schema.safeParse(json);
        return builtIn.success ? { kind: 'built_in' as const, request: builtIn.data } : null;
      }
      return null;
    } catch {
      return null;
    }
  }, [artifact]);

  const actionTitle = React.useMemo(() => {
    const actionId = parsed?.kind === 'built_in' || parsed?.kind === 'host_action'
      ? parsed.request.actionId
      : null;
    if (!actionId) return null;
    try {
      const spec = getActionSpec(actionId as ActionId);
      return spec.title || actionId;
    } catch {
      return actionId;
    }
  }, [parsed]);

  const request = parsed?.request ?? null;
  const sessionId = request?.createdBy.sessionId ?? (typeof artifact?.header?.sessionId === 'string' ? artifact.header.sessionId : '');
  const session = useSession(sessionId || '');
  const ownerMetadata = session ? readSessionOwnerMetadataView(session) : null;
  const machineId = readDisplayMachineIdForSession({
    sessionId,
    metadata: ownerMetadata,
  });
  const machine = useMachine(machineId || '');
  const approvalServerId = React.useMemo(() => {
    if (!parsed) return null;
    const requestServerId = parsed?.kind === 'built_in' && typeof (parsed.request as { serverId?: unknown }).serverId === 'string'
      ? String((parsed.request as { serverId?: string }).serverId).trim()
      : '';
    if (requestServerId.length > 0) return requestServerId;
    const headerServerId = typeof artifact?.header?.serverId === 'string' ? String(artifact.header.serverId).trim() : '';
    if (headerServerId.length > 0) return headerServerId;
    return sessionId ? resolvePreferredServerIdForSessionId(sessionId) : null;
  }, [artifact?.header?.serverId, parsed, sessionId]);

  const decide = React.useCallback(
    async (decision: 'approve' | 'reject' | 'cancel') => {
      if (!parsed || decisionInFlightRef.current || parsed.request.status !== 'open') return;

      try {
        decisionInFlightRef.current = true;
        setIsDeciding(true);
        if (parsed.kind === 'target') {
          const now = Date.now();
          const nextRequest: TargetActionApprovalRequestV1 = decision === 'cancel'
            ? { ...parsed.request, status: 'canceled', updatedAtMs: now }
            : {
              ...parsed.request,
              status: decision === 'approve' ? 'approved' : 'rejected',
              updatedAtMs: now,
              decision: { kind: decision, decidedAtMs: now },
            };
          const validated = TargetActionApprovalRequestV1Schema.parse(nextRequest);
          await sync.updateArtifactWithHeader(props.artifactId, {
            v: 1,
            kind: 'target_action_approval.v1',
            title: validated.summary,
            approvalStatus: validated.status,
            qualifiedActionId: validated.qualifiedActionId,
            subjectFingerprint: validated.subjectFingerprint,
            ...(sessionId ? { sessions: [sessionId], sessionId } : {}),
          }, JSON.stringify(validated));
        } else if (parsed.kind === 'host_action') {
          const now = Date.now();
          const nextRequest: ExecutionRunHostActionApprovalRequestV1 = decision === 'cancel'
            ? { ...parsed.request, status: 'canceled', updatedAtMs: now }
            : {
              ...parsed.request,
              status: decision === 'approve' ? 'approved' : 'rejected',
              updatedAtMs: now,
              decision: { kind: decision, decidedAtMs: now },
            };
          const validated = ExecutionRunHostActionApprovalRequestV1Schema.parse(nextRequest);
          await sync.updateArtifactWithHeader(props.artifactId, {
            v: 1,
            kind: 'execution_run_host_action_approval.v1',
            title: validated.summary,
            approvalStatus: validated.status,
            actionId: validated.actionId,
            sessionId: validated.sessionId,
            sessions: [validated.sessionId],
            runId: validated.runId,
            subjectFingerprint: validated.subjectFingerprint,
            serverId: validated.serverId,
          }, JSON.stringify(validated));
        } else {
          if (decision === 'cancel') return;
          const res = await executor.execute(
            'approval.request.decide' as ActionId,
            { artifactId: props.artifactId, decision },
            { surface: 'ui', ...(approvalServerId ? { serverId: approvalServerId } : {}) },
          );
          if (!res.ok) throw new Error(res.errorCode);
        }
      } catch (err) {
        const isVersionConflict = err instanceof Error && err.message.includes('modified by another client');
        if (isVersionConflict) {
          try {
            const current = await sync.fetchArtifactWithBody(props.artifactId);
            if (current) storage.getState().updateArtifact(current);
          } catch {
            // The original conflict remains authoritative and is still shown below.
          }
        }
        const message = isVersionConflict ? err.message : t('approvals.decisionError');
        Modal.alert(t('common.error'), message);
      } finally {
        decisionInFlightRef.current = false;
        setIsDeciding(false);
      }
    },
    [approvalServerId, executor, parsed, props.artifactId, sessionId],
  );

  if (isLoading) {
    return (
      <View style={styles.container}>
        <View style={styles.loading}>
          <ActivitySpinner size="large" color={theme.colors.text.secondary} />
        </View>
      </View>
    );
  }

  if (artifact?.isDecrypted === false) {
    const lockedMessage = artifact.availability.reason === 'encryption_material_unavailable'
      ? t('settingsAccount.secretKeyMissing')
      : t('approvals.loadError');

    return (
      <View style={styles.container}>
        <View style={styles.loading}>
          <Text style={{ color: theme.colors.text.secondary }}>{lockedMessage}</Text>
          <View style={{ height: 12 }} />
          <RoundButton
            size="normal"
            title={t('common.back')}
            onPress={() => router.back()}
          />
        </View>
      </View>
    );
  }

  if (error || !parsed) {
    return (
      <View style={styles.container}>
        <View style={styles.loading}>
          <Text style={{ color: theme.colors.text.secondary }}>{error || t('approvals.loadError')}</Text>
          <View style={{ height: 12 }} />
          <RoundButton
            size="normal"
            title={t('common.back')}
            onPress={() => router.back()}
          />
        </View>
      </View>
    );
  }

  const statusLabel = formatApprovalStatusLabel(parsed.request.status);
  const targetActionParts = parsed.kind === 'target'
    ? parsed.request.qualifiedActionId.split('/actions/')
    : null;

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={scrollContentStyle}>
        <Text style={styles.title}>{parsed.request.summary || t('approvals.untitled')}</Text>
        {parsed.kind === 'target' && parsed.request.detail ? (
          <Text testID="approvals.target-action-detail" style={styles.subtitle}>{parsed.request.detail}</Text>
        ) : null}
        {actionTitle ? <Text style={styles.subtitle}>{actionTitle}</Text> : null}
        {targetActionParts ? <Text style={styles.subtitle}>{targetActionParts[0]} · {targetActionParts[1]}</Text> : null}
        {parsed.kind === 'host_action' ? (
          <Text style={styles.subtitle}>
            {parsed.request.pluginId} · {t('approvals.proposedComments', { count: parsed.request.proposalCount })}
          </Text>
        ) : null}

        <View style={styles.cardStack}>
          <ApprovalSessionContextCard
            session={session}
            machine={machine}
            requesterAgentId={parsed.request.createdBy.agentId ?? null}
            requesterSurface={parsed.request.createdBy.surface}
          />

          <View style={styles.statusCard}>
            <Text style={styles.statusLabel}>{t('approvals.fieldStatus')}</Text>
            <Text style={styles.statusValue}>{statusLabel}</Text>
            <Text style={styles.statusLabel}>{t('approvals.fieldAction')}</Text>
            <Text style={styles.statusValue}>{actionTitle ?? (parsed.kind === 'target' ? parsed.request.qualifiedActionId : String(parsed.request.actionId))}</Text>
            {actionTitle && parsed.kind === 'built_in' && actionTitle !== parsed.request.actionId ? (
              <Text style={styles.statusMeta}>{String(parsed.request.actionId)}</Text>
            ) : null}
            {parsed.kind === 'host_action' ? <Text style={styles.statusMeta}>{parsed.request.actionId}</Text> : null}
            {parsed.kind === 'target' ? (
              <Text style={styles.statusMeta}>{t('approvals.generation', { generation: parsed.request.generation })}</Text>
            ) : null}
            {parsed.kind === 'host_action' ? <Text style={styles.statusMeta}>{parsed.request.profileId}</Text> : null}
          </View>

          {parsed.kind === 'built_in' ? <ApprovalPreviewCard preview={parsed.request.preview} /> : null}
          {parsed.kind === 'built_in' ? <ActionApprovalFieldsCard actionId={String(parsed.request.actionId)} actionArgs={parsed.request.actionArgs} /> : null}
          {parsed.kind === 'host_action' ? parsed.request.proposalPreview.map((proposal, index) => (
            <View key={`${proposal.pathSha256}:${proposal.bodySha256}:${index}`} style={styles.statusCard}>
              <Text style={styles.statusLabel}>{proposal.pathLabel}{proposal.startLine ? `:${proposal.startLine}` : ''}</Text>
              <Text style={styles.statusValue}>{proposal.bodyPreview}</Text>
              {proposal.severity ? <Text style={styles.statusMeta}>{proposal.severity}</Text> : null}
            </View>
          )) : null}
        </View>

        {parsed.request.status === 'open' && (
          <View style={styles.actionsRow}>
            <RoundButton
              testID="approvals.approve"
              size="normal"
              title={t('approvals.approve')}
              accessibilityLabel={t('approvals.approve')}
              disabled={isDeciding}
              onPress={() => decide('approve')}
            />
            <RoundButton
              testID="approvals.reject"
              size="normal"
              title={t('approvals.reject')}
              accessibilityLabel={t('approvals.reject')}
              disabled={isDeciding}
              style={{ backgroundColor: theme.colors.state.danger.foreground }}
              textStyle={{ color: theme.colors.button.primary.tint }}
              onPress={() => decide('reject')}
            />
            {parsed.kind === 'target' || parsed.kind === 'host_action' ? (
              <RoundButton
                testID="approvals.cancel"
                size="normal"
                title={t('common.cancel')}
                accessibilityLabel={t('common.cancel')}
                disabled={isDeciding}
                onPress={() => decide('cancel')}
              />
            ) : null}
          </View>
        )}
      </ScrollView>
    </View>
  );
});

ApprovalDetailScreen.displayName = 'ApprovalDetailScreen';
