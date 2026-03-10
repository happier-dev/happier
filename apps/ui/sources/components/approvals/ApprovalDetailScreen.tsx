import * as React from 'react';
import { View, ScrollView, ActivityIndicator } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import { ApprovalRequestV1Schema, getActionSpec, type ActionId } from '@happier-dev/protocol';

import { Text } from '@/components/ui/text/Text';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Modal } from '@/modal';
import { t } from '@/text';
import { sync } from '@/sync/sync';
import { storage, useArtifact, useMachine, useSession } from '@/sync/domains/state/storage';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { resolveServerIdForSessionIdFromLocalCache } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import { layout } from '@/components/ui/layout/layout';
import { ApprovalSessionContextCard } from './ApprovalSessionContextCard';
import { ActionApprovalFieldsCard } from './ActionApprovalFieldsCard';
import { ApprovalPreviewCard } from './ApprovalPreviewCard';

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.groupped.background,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 64,
    maxWidth: layout.maxWidth,
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
    color: theme.colors.text,
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: theme.colors.textSecondary,
    marginBottom: 16,
  },
  cardStack: {
    gap: 12,
  },
  statusCard: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.colors.divider,
    backgroundColor: theme.colors.surfaceHighest,
    padding: 16,
    gap: 8,
  },
  statusLabel: {
    fontSize: 12,
    color: theme.colors.textSecondary,
    fontWeight: '600',
  },
  statusValue: {
    fontSize: 14,
    color: theme.colors.text,
  },
  statusMeta: {
    fontSize: 12,
    color: theme.colors.textSecondary,
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
  const router = useRouter();
  const { theme } = useUnistyles();
  const artifact = useArtifact(props.artifactId);
  const [isLoading, setIsLoading] = React.useState(!artifact?.body);
  const [error, setError] = React.useState<string | null>(null);
  const [isDeciding, setIsDeciding] = React.useState(false);

  const executor = React.useMemo(
    () => createDefaultActionExecutor({ resolveServerIdForSessionId: resolveServerIdForSessionIdFromLocalCache }),
    [],
  );

  React.useEffect(() => {
    if (artifact?.body !== undefined) return;

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
      const res = ApprovalRequestV1Schema.safeParse(json);
      return res.success ? res.data : null;
    } catch {
      return null;
    }
  }, [artifact]);

  const actionTitle = React.useMemo(() => {
    const actionId = parsed?.actionId;
    if (!actionId) return null;
    try {
      const spec = getActionSpec(actionId as ActionId);
      return spec.title || actionId;
    } catch {
      return actionId;
    }
  }, [parsed?.actionId]);

  const sessionId = parsed?.createdBy.sessionId ?? (typeof artifact?.header?.sessionId === 'string' ? artifact.header.sessionId : '');
  const session = useSession(sessionId || '');
  const machineId = typeof session?.metadata?.machineId === 'string' ? session.metadata.machineId : '';
  const machine = useMachine(machineId || '');
  const approvalServerId = React.useMemo(() => {
    if (!parsed) return null;
    const requestServerId = typeof (parsed as { serverId?: unknown }).serverId === 'string'
      ? String((parsed as { serverId?: string }).serverId).trim()
      : '';
    if (requestServerId.length > 0) return requestServerId;
    const headerServerId = typeof artifact?.header?.serverId === 'string' ? String(artifact.header.serverId).trim() : '';
    if (headerServerId.length > 0) return headerServerId;
    return sessionId ? resolveServerIdForSessionIdFromLocalCache(sessionId) : null;
  }, [artifact?.header?.serverId, parsed, sessionId]);

  const decide = React.useCallback(
    async (decision: 'approve' | 'reject') => {
      if (!parsed) return;

      const confirmed = decision === 'approve'
        ? await Modal.confirm(t('approvals.confirmApproveTitle'), t('approvals.confirmApproveBody'), { confirmText: t('approvals.approve') })
        : await Modal.confirm(t('approvals.confirmRejectTitle'), t('approvals.confirmRejectBody'), { confirmText: t('approvals.reject'), destructive: true });

      if (!confirmed) return;

      try {
        setIsDeciding(true);
        const res = await executor.execute(
          'approval.request.decide' as ActionId,
          { artifactId: props.artifactId, decision },
          { surface: 'ui_button', ...(approvalServerId ? { serverId: approvalServerId } : {}) },
        );
        if (!res.ok) {
          throw new Error(res.errorCode);
        }
      } catch (err) {
        Modal.alert(t('common.error'), t('approvals.decisionError'));
      } finally {
        setIsDeciding(false);
      }
    },
    [approvalServerId, executor, parsed, props.artifactId],
  );

  if (isLoading) {
    return (
      <View style={styles.container}>
        <View style={styles.loading}>
          <ActivityIndicator size="large" color={theme.colors.textSecondary} />
        </View>
      </View>
    );
  }

  if (error || !parsed) {
    return (
      <View style={styles.container}>
        <View style={styles.loading}>
          <Text style={{ color: theme.colors.textSecondary }}>{error || t('approvals.loadError')}</Text>
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

  const statusLabel = formatApprovalStatusLabel(parsed.status);

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <Text style={styles.title}>{parsed.summary || t('approvals.untitled')}</Text>
        {actionTitle ? <Text style={styles.subtitle}>{actionTitle}</Text> : null}

        <View style={styles.cardStack}>
          <ApprovalSessionContextCard
            session={session}
            machine={machine}
            requesterAgentId={parsed.createdBy.agentId ?? null}
            requesterSurface={parsed.createdBy.surface}
          />

          <View style={styles.statusCard}>
            <Text style={styles.statusLabel}>{t('approvals.fieldStatus')}</Text>
            <Text style={styles.statusValue}>{statusLabel}</Text>
            <Text style={styles.statusLabel}>{t('approvals.fieldAction')}</Text>
            <Text style={styles.statusValue}>{actionTitle ?? String(parsed.actionId)}</Text>
            {actionTitle && actionTitle !== parsed.actionId ? (
              <Text style={styles.statusMeta}>{String(parsed.actionId)}</Text>
            ) : null}
          </View>

          <ApprovalPreviewCard preview={parsed.preview} />
          <ActionApprovalFieldsCard actionId={String(parsed.actionId)} actionArgs={parsed.actionArgs} />
        </View>

        {parsed.status === 'open' && (
          <View style={styles.actionsRow}>
            <RoundButton
              testID="approvals.reject"
              size="normal"
              title={t('approvals.reject')}
              disabled={isDeciding}
              style={{ backgroundColor: theme.colors.deleteAction }}
              textStyle={{ color: theme.colors.button.primary.tint }}
              onPress={() => decide('reject')}
            />
            <RoundButton
              testID="approvals.approve"
              size="normal"
              title={t('approvals.approve')}
              disabled={isDeciding}
              onPress={() => decide('approve')}
            />
          </View>
        )}
      </ScrollView>
    </View>
  );
});

ApprovalDetailScreen.displayName = 'ApprovalDetailScreen';
