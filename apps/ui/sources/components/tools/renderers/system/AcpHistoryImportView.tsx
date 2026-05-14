import * as React from 'react';
import { View, TouchableOpacity } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ToolViewProps } from '../core/_registry';
import { resolvePermissionRequestId } from '../core/resolvePermissionRequestId';
import { ToolSectionView } from '../../shell/presentation/ToolSectionView';
import { sessionAllow, sessionDeny } from '@/sync/ops';
import { Modal } from '@/modal';
import { t } from '@/text';
import { Text } from '@/components/ui/text/Text';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';


type HistoryPreviewItem = { role?: string; text?: string };

function asPreviewList(input: unknown): HistoryPreviewItem[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((v) => v && typeof v === 'object')
    .map((v) => {
      const obj = v as any;
      return {
        role: typeof obj.role === 'string' ? obj.role : undefined,
        text: typeof obj.text === 'string' ? obj.text : undefined,
      };
    });
}

export const AcpHistoryImportView = React.memo<ToolViewProps>(({ tool, sessionId, interaction }) => {
  const { theme } = useUnistyles();
  const [loading, setLoading] = React.useState<'import' | 'skip' | null>(null);

  if (!sessionId) return null;
  const permissionId = resolvePermissionRequestId(tool);
  if (!permissionId) return null;

  const canApprovePermissions = interaction?.canApprovePermissions ?? true;
  const disabledMessage =
    interaction?.permissionDisabledReason === 'public'
      ? t('session.sharing.permissionApprovalsDisabledPublic')
      : interaction?.permissionDisabledReason === 'readOnly'
        ? t('session.sharing.permissionApprovalsDisabledReadOnly')
        : t('session.sharing.permissionApprovalsDisabledNotGranted');

  const input = tool.input as any;
  const provider = typeof input?.provider === 'string' ? input.provider : 'acp';
  const remoteSessionId = typeof input?.remoteSessionId === 'string' ? input.remoteSessionId : undefined;
  const localCount = typeof input?.localCount === 'number' ? input.localCount : undefined;
  const remoteCount = typeof input?.remoteCount === 'number' ? input.remoteCount : undefined;
  const localTail = asPreviewList(input?.localTail);
  const remoteTail = asPreviewList(input?.remoteTail);
  const note = typeof input?.note === 'string' ? input.note : undefined;

  const isPending =
    tool.permission?.status === 'pending'
      || (tool.permission == null && tool.state === 'running');

  const onImport = async () => {
    if (!isPending || loading || !canApprovePermissions) return;
    setLoading('import');
    try {
      await sessionAllow(sessionId, permissionId);
    } catch (e) {
      Modal.alert(t('common.error'), e instanceof Error ? e.message : t('errors.failedToSendMessage'));
    } finally {
      setLoading(null);
    }
  };

  const onSkip = async () => {
    if (!isPending || loading || !canApprovePermissions) return;
    setLoading('skip');
    try {
      await sessionDeny(sessionId, permissionId, undefined, undefined, 'denied');
    } catch (e) {
      Modal.alert(t('common.error'), e instanceof Error ? e.message : t('errors.failedToSendMessage'));
    } finally {
      setLoading(null);
    }
  };

  return (
    <ToolSectionView>
      <View style={styles.container}>
        <Text style={styles.title}>{t('tools.acpHistoryImport.title')}</Text>
        <Text style={styles.subtitle}>
          {provider}{remoteSessionId ? ` • ${remoteSessionId}` : ''}
        </Text>
        <Text style={styles.body}>
          {note ?? t('tools.acpHistoryImport.defaultNote')}
        </Text>

        {isPending && !canApprovePermissions ? (
          <Text style={[styles.body, { color: theme.colors.text.secondary }]}>
            {disabledMessage}
          </Text>
        ) : null}

        {(typeof localCount === 'number' || typeof remoteCount === 'number') && (
          <View style={styles.countRow}>
            {typeof localCount === 'number' && <Text style={styles.countText}>{t('tools.acpHistoryImport.counts.local', { count: localCount })}</Text>}
            {typeof remoteCount === 'number' && <Text style={styles.countText}>{t('tools.acpHistoryImport.counts.remote', { count: remoteCount })}</Text>}
          </View>
        )}

        {(localTail.length > 0 || remoteTail.length > 0) && (
          <View style={styles.previewContainer}>
            {localTail.length > 0 && (
              <View style={styles.previewBlock}>
                <Text style={styles.previewHeader}>{t('tools.acpHistoryImport.preview.localTail')}</Text>
                {localTail.map((m, idx) => (
                  <Text key={idx} style={styles.previewLine} numberOfLines={2}>
                    {(m.role ?? t('tools.acpHistoryImport.preview.unknownRole'))}: {m.text ?? ''}
                  </Text>
                ))}
              </View>
            )}
            {remoteTail.length > 0 && (
              <View style={styles.previewBlock}>
                <Text style={styles.previewHeader}>{t('tools.acpHistoryImport.preview.remoteTail')}</Text>
                {remoteTail.map((m, idx) => (
                  <Text key={idx} style={styles.previewLine} numberOfLines={2}>
                    {(m.role ?? t('tools.acpHistoryImport.preview.unknownRole'))}: {m.text ?? ''}
                  </Text>
                ))}
              </View>
            )}
          </View>
        )}

        <View style={styles.actions}>
          <TouchableOpacity
            style={[styles.button, styles.primaryButton, !isPending && styles.disabled]}
            disabled={!isPending || loading !== null || !canApprovePermissions}
            onPress={onImport}
          >
            {loading === 'import' ? <ActivitySpinner color={theme.colors.button.primary.tint} /> : <Text style={styles.primaryText}>{t('tools.acpHistoryImport.actions.import')}</Text>}
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.button, styles.secondaryButton, !isPending && styles.disabled]}
            disabled={!isPending || loading !== null || !canApprovePermissions}
            onPress={onSkip}
          >
            {loading === 'skip' ? <ActivitySpinner color={theme.colors.text.primary} /> : <Text style={styles.secondaryText}>{t('tools.acpHistoryImport.actions.skip')}</Text>}
          </TouchableOpacity>
        </View>
      </View>
    </ToolSectionView>
  );
});

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: 10,
    paddingVertical: 4,
  },
  title: {
    fontSize: 15,
    fontWeight: '700',
    color: theme.colors.text.primary,
  },
  subtitle: {
    fontSize: 12,
    color: theme.colors.text.secondary,
  },
  body: {
    fontSize: 13,
    color: theme.colors.text.primary,
    lineHeight: 18,
  },
  countRow: {
    flexDirection: 'row',
    gap: 12,
  },
  countText: {
    fontSize: 12,
    color: theme.colors.text.secondary,
  },
  previewContainer: {
    gap: 10,
  },
  previewBlock: {
    gap: 6,
    padding: 10,
    borderRadius: 8,
    backgroundColor: theme.colors.surface.elevated,
  },
  previewHeader: {
    fontSize: 12,
    fontWeight: '600',
    color: theme.colors.text.secondary,
    textTransform: 'uppercase',
  },
  previewLine: {
    fontSize: 12,
    color: theme.colors.text.primary,
  },
  actions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 6,
  },
  button: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  primaryButton: {
    backgroundColor: theme.colors.button.primary.background,
  },
  primaryText: {
    color: theme.colors.button.primary.tint,
    fontSize: 14,
    fontWeight: '600',
  },
  secondaryButton: {
    backgroundColor: theme.colors.surface.inset,
    borderWidth: 1,
    borderColor: theme.colors.border.default,
  },
  secondaryText: {
    color: theme.colors.text.primary,
    fontSize: 14,
    fontWeight: '600',
  },
  disabled: {
    opacity: 0.5,
  },
}));
