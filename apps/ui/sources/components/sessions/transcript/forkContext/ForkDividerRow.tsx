import * as React from 'react';
import { Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { TranscriptSeparatorRow } from '@/components/sessions/transcript/separators/TranscriptSeparatorRow';
import { useSession } from '@/sync/domains/state/storage';
import { getSessionName } from '@/utils/sessions/sessionUtils';

export function ForkDividerRow(props: Readonly<{
  parentSessionId: string;
  childSessionId: string;
  parentCutoffSeqInclusive: number;
}>): React.ReactElement {
  const { theme } = useUnistyles();
  const router = useRouter();
  const parentSession = useSession(props.parentSessionId);
  const dividerId = `${props.parentSessionId}:${props.childSessionId}`;
  const parentName = parentSession ? getSessionName(parentSession) : null;
  const title =
    parentName
      ? t('session.forking.dividerTitleWithParent', { parent: parentName })
      : t('session.forking.dividerTitle');

  const handleOpenParent = React.useCallback(() => {
    const seq = Math.max(0, Math.trunc(props.parentCutoffSeqInclusive));
    router.push((`/session/${props.parentSessionId}?jumpSeq=${seq}`) as any);
  }, [props.parentCutoffSeqInclusive, props.parentSessionId, router]);

  return (
    <TranscriptSeparatorRow
      testID={`transcript-fork-divider:${dividerId}`}
      iconName="git-branch-outline"
      title={title}
      subtitle={t('session.forking.dividerSubtitle')}
      rightAccessory={(
        <Pressable
          testID={`transcript-fork-divider-open-parent:${dividerId}`}
          onPress={handleOpenParent}
          accessibilityRole="button"
          accessibilityLabel={t('session.forking.openParentA11y')}
          hitSlop={12}
          style={({ pressed }) => [styles.openButton, pressed ? { opacity: 0.65 } : null]}
        >
          <Text style={[styles.openButtonText, { color: theme.colors.text.link }]}>{t('session.forking.openParent')}</Text>
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  openButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.colors.border.default,
  },
  openButtonText: {
    fontSize: 12,
    fontWeight: '600',
  },
}));
