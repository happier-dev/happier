import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getActionSpec, type ActionId } from '@happier-dev/protocol';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { useMachine, useSession } from '@/sync/domains/state/storage';
import { readDisplayMachineIdForSession, readDisplayPathForSession } from '@/sync/ops/sessionMachineTarget';
import { Text } from '@/components/ui/text/Text';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import { formatPathRelativeToHome, getSessionName } from '@/utils/sessions/sessionUtils';
import { t } from '@/text';

export const ApprovalInboxCard = React.memo((props: Readonly<{
  artifact: DecryptedArtifact;
  onPress: () => void;
}>): React.ReactElement => {
  const { theme } = useUnistyles();

  const title = props.artifact.header?.title ?? props.artifact.title ?? t('approvals.untitled');
  const actionIdRaw = typeof props.artifact.header?.actionId === 'string' ? String(props.artifact.header.actionId).trim() : '';
  const sessionId = typeof props.artifact.header?.sessionId === 'string' ? props.artifact.header.sessionId.trim() : '';
  const session = useSession(sessionId);
  const machineId = readDisplayMachineIdForSession({
    sessionId,
    metadata: session?.metadata ?? null,
  });
  const machine = useMachine(machineId);

  const actionTitle = React.useMemo(() => {
    if (!actionIdRaw) return null;
    try {
      return getActionSpec(actionIdRaw as ActionId).title;
    } catch {
      return actionIdRaw;
    }
  }, [actionIdRaw]);

  const sessionTitle = session ? getSessionName(session) : null;
  const displayPath = session
    ? readDisplayPathForSession({
      sessionId,
      metadata: session.metadata ?? null,
    })
    : '';
  const pathLabel = displayPath
    ? formatPathRelativeToHome(displayPath, session?.metadata?.homeDir ?? undefined)
    : null;
  const machineLabel = getMachineDisplayName(machine);

  return (
    <Pressable
      testID={`inbox.approval.${props.artifact.id}`}
      accessibilityRole="button"
      onPress={props.onPress}
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
    >
      <View style={styles.headerRow}>
        <Ionicons name="alert-circle-outline" size={18} color={theme.colors.status.error} />
        <View style={styles.headerText}>
          <Text style={styles.title}>{title}</Text>
          {actionTitle ? <Text style={styles.subtitle}>{actionTitle}</Text> : null}
        </View>
        <Ionicons name="chevron-forward" size={16} color={theme.colors.text.secondary} />
      </View>

      {sessionTitle ? <Text style={styles.meta}>{sessionTitle}</Text> : null}
      {machineLabel ? <Text style={styles.meta}>{machineLabel}</Text> : null}
      {pathLabel ? <Text style={styles.meta}>{pathLabel}</Text> : null}
    </Pressable>
  );
});

ApprovalInboxCard.displayName = 'ApprovalInboxCard';

const styles = StyleSheet.create((theme) => ({
  card: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.colors.border.default,
    backgroundColor: theme.colors.surface.elevated,
    padding: 14,
    gap: 6,
  },
  cardPressed: {
    backgroundColor: theme.colors.surface.pressedOverlay,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  headerText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  title: {
    fontSize: 14,
    fontWeight: '700',
    color: theme.colors.text.primary,
  },
  subtitle: {
    fontSize: 12,
    color: theme.colors.text.secondary,
  },
  meta: {
    fontSize: 12,
    color: theme.colors.text.secondary,
  },
}));
