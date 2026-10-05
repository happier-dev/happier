import * as React from 'react';
import { View, TouchableOpacity } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ToolViewProps } from '../core/_registry';
import { resolvePermissionRequestId } from '../core/resolvePermissionRequestId';
import { ToolSectionView } from '../../shell/presentation/ToolSectionView';
import { useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { Modal } from '@/modal';
import { t } from '@/text';
import { Text } from '@/components/ui/text/Text';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { resolvePermissionDisabledMessage } from '@/components/tools/shell/permissions/permissionDisabledMessage';
import { ToolFindText } from '../core/ToolFindText';
import { toolTextBlock, type ToolDisplayTextProjector } from '../core/toolDisplayTextTypes';


type HistoryPreviewItem = { role?: string; text?: string };

function asPreviewList(input: unknown): HistoryPreviewItem[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((v) => v && typeof v === 'object')
    .map((v) => {
      const obj = v as Record<string, unknown>;
      return {
        role: typeof obj.role === 'string' ? obj.role : undefined,
        text: typeof obj.text === 'string' ? obj.text : undefined,
      };
    });
}

function readHistoryImportDisplay(tool: ToolViewProps['tool']) {
  const input = tool.input && typeof tool.input === 'object' ? tool.input as Record<string, unknown> : null;
  const provider = typeof input?.provider === 'string' ? input.provider : 'acp';
  const remoteSessionId = typeof input?.remoteSessionId === 'string' ? input.remoteSessionId : undefined;
  const previewText = (item: HistoryPreviewItem) => `${item.role ?? t('tools.acpHistoryImport.preview.unknownRole')}: ${item.text ?? ''}`;
  return {
    title: t('tools.acpHistoryImport.title'),
    subtitle: `${provider}${remoteSessionId ? ` • ${remoteSessionId}` : ''}`,
    note: typeof input?.note === 'string' ? input.note : t('tools.acpHistoryImport.defaultNote'),
    localCount: typeof input?.localCount === 'number' ? t('tools.acpHistoryImport.counts.local', { count: input.localCount }) : null,
    remoteCount: typeof input?.remoteCount === 'number' ? t('tools.acpHistoryImport.counts.remote', { count: input.remoteCount }) : null,
    localHeader: t('tools.acpHistoryImport.preview.localTail'),
    remoteHeader: t('tools.acpHistoryImport.preview.remoteTail'),
    localTail: asPreviewList(input?.localTail).map(previewText),
    remoteTail: asPreviewList(input?.remoteTail).map(previewText),
  };
}

export const projectAcpHistoryImportDisplayText: ToolDisplayTextProjector = (tool) => {
  if (!resolvePermissionRequestId(tool)) return [];
  const display = readHistoryImportDisplay(tool);
  return [
    ...toolTextBlock('tool-history-title', display.title),
    ...toolTextBlock('tool-history-subtitle', display.subtitle),
    ...toolTextBlock('tool-history-note', display.note),
    ...toolTextBlock('tool-history-local-count', display.localCount),
    ...toolTextBlock('tool-history-remote-count', display.remoteCount),
    ...toolTextBlock('tool-history-local-header', display.localTail.length ? display.localHeader : null),
    ...display.localTail.flatMap((text, index) => toolTextBlock(`tool-history-local-${index}`, text)),
    ...toolTextBlock('tool-history-remote-header', display.remoteTail.length ? display.remoteHeader : null),
    ...display.remoteTail.flatMap((text, index) => toolTextBlock(`tool-history-remote-${index}`, text)),
  ];
};

export const AcpHistoryImportView = React.memo<ToolViewProps>(({ tool, sessionId, interaction, messageId }) => {
  const source = useSessionTranscriptSource();
  const sourceInteraction = source.useInteraction();
  const actions = source.actions;
  const { theme } = useUnistyles();
  const [loading, setLoading] = React.useState<'import' | 'skip' | null>(null);

  if (!sessionId) return null;
  const permissionId = resolvePermissionRequestId(tool);
  if (!permissionId) return null;

  const canApprovePermissions = actions !== null && sourceInteraction.canApprovePermissions && interaction?.canApprovePermissions !== false;
  const disabledMessage =
    resolvePermissionDisabledMessage(interaction?.permissionDisabledReason ?? sourceInteraction.permissionDisabledReason);

  const display = readHistoryImportDisplay(tool);
  const { localTail, remoteTail } = display;

  const isPending =
    tool.permission?.status === 'pending'
      || (tool.permission == null && tool.state === 'running');

  const onImport = async () => {
    if (!isPending || loading || !canApprovePermissions) return;
    setLoading('import');
    try {
      if (!actions) return;
      await actions.respondToPermission({ id: permissionId, approved: true });
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
      if (!actions) return;
      await actions.respondToPermission({ id: permissionId, approved: false, decision: 'denied' });
    } catch (e) {
      Modal.alert(t('common.error'), e instanceof Error ? e.message : t('errors.failedToSendMessage'));
    } finally {
      setLoading(null);
    }
  };

  return (
    <ToolSectionView>
      <View style={styles.container}>
        <ToolFindText text={display.title} blockId="tool-history-title" messageId={messageId} style={styles.title} />
        <ToolFindText text={display.subtitle} blockId="tool-history-subtitle" messageId={messageId} style={styles.subtitle} />
        <ToolFindText text={display.note} blockId="tool-history-note" messageId={messageId} style={styles.body} />

        {isPending && !canApprovePermissions ? (
          <Text style={[styles.body, { color: theme.colors.text.secondary }]}>
            {disabledMessage}
          </Text>
        ) : null}

        {(display.localCount !== null || display.remoteCount !== null) && (
          <View style={styles.countRow}>
            {display.localCount !== null && <ToolFindText text={display.localCount} blockId="tool-history-local-count" messageId={messageId} style={styles.countText} />}
            {display.remoteCount !== null && <ToolFindText text={display.remoteCount} blockId="tool-history-remote-count" messageId={messageId} style={styles.countText} />}
          </View>
        )}

        {(localTail.length > 0 || remoteTail.length > 0) && (
          <View style={styles.previewContainer}>
            {localTail.length > 0 && (
              <View style={styles.previewBlock}>
                <ToolFindText text={display.localHeader} blockId="tool-history-local-header" messageId={messageId} style={styles.previewHeader} />
                {localTail.map((m, idx) => (
                  <ToolFindText key={idx} text={m} blockId={`tool-history-local-${idx}`} messageId={messageId} style={styles.previewLine} numberOfLines={2} />
                ))}
              </View>
            )}
            {remoteTail.length > 0 && (
              <View style={styles.previewBlock}>
                <ToolFindText text={display.remoteHeader} blockId="tool-history-remote-header" messageId={messageId} style={styles.previewHeader} />
                {remoteTail.map((m, idx) => (
                  <ToolFindText key={idx} text={m} blockId={`tool-history-remote-${idx}`} messageId={messageId} style={styles.previewLine} numberOfLines={2} />
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
