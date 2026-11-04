import { HAPPIER_COLLECTION_LIST_METRICS } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { Platform, type LayoutChangeEvent, type NativeSyntheticEvent, type TextInputKeyPressEventData, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';

import { sessionListStyles } from '../shell/sessionListStyles';
import { resolveSessionSectionIcon } from './sessionSectionIcons';
import type { SessionSectionDraft } from './useSessionSectionDraft';
import { useHappierTouchPrimaryPointer } from '@happier-dev/plugin-ui/environment';

const M = HAPPIER_COLLECTION_LIST_METRICS;

const stylesheet = StyleSheet.create((theme) => ({
  block: {
    paddingTop: M.groupGap,
  },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    minHeight: M.groupLabelHeight,
    marginHorizontal: M.rowInset,
    paddingLeft: M.contentInset - M.rowInset,
    paddingRight: theme.space.s10,
    borderRadius: M.rowRadius,
    borderWidth: 1,
    borderColor: theme.colors.border.strong,
    backgroundColor: theme.colors.surface.base,
  },
  mark: {
    width: 16,
    height: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  input: {
    flex: 1,
    minWidth: 0,
    paddingVertical: 0,
    ...Typography.variant('meta', 'medium'),
    color: theme.colors.text.primary,
    outlineStyle: 'none',
  } as object,
  key: {
    color: theme.colors.text.tertiary,
  },
  failed: {
    color: theme.colors.state.danger.textForeground,
  },
}));

/**
 * The inline New section field (lab `clsections:custom`): a section header that is still being named,
 * growing in from nothing (220 ms), with the place it will hold under it. Enter creates, Escape leaves.
 */
export function SessionSectionDraftField(
  props: Readonly<{
    draft: SessionSectionDraft;
    onSubmit: (name: string) => void;
    onCancel: () => void;
  }>,
) {
  const styles = stylesheet;
  const { theme } = useUnistyles();
  const reducedMotion = useReducedMotionPreference();
  const [name, setName] = React.useState(props.draft.name);
  const creating = props.draft.phase === 'creating';
  const touchPrimary = useHappierTouchPrimaryPointer(Platform.OS);
  const height = useSharedValue(0);
  const inputRef = React.useRef<React.ElementRef<typeof TextInput> | null>(null);
  const [measured, setMeasured] = React.useState<number | null>(null);
  const handleLayout = React.useCallback((event: LayoutChangeEvent) => {
    const next = Math.ceil(event.nativeEvent.layout.height);
    setMeasured((previous) => (previous === next ? previous : next));
  }, []);
  React.useEffect(() => {
    if (measured === null) return;
    // The field is where the section will land, which may be below the fold: bring it into view.
    (inputRef.current as unknown as { scrollIntoView?: (options: object) => void } | null)
      ?.scrollIntoView?.({ block: 'nearest' });
    height.value = reducedMotion
      ? measured
      : withTiming(measured, {
          duration: reanimatedMotionTokens.durationMs.base,
          easing: reanimatedMotionTokens.easing.standard,
        });
  }, [height, measured, reducedMotion]);
  const growStyle = useAnimatedStyle(
    () => ({
      height: height.value,
      opacity: measured ? Math.min(1, height.value / measured) : 0,
    }),
    [measured],
  );
  const handleKeyPress = React.useCallback(
    (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      if (event.nativeEvent.key === 'Escape') props.onCancel();
    },
    [props],
  );
  const handleBlur = React.useCallback(() => {
    // Leaving an empty field puts the list back as it was; a typed name stays until Enter or Escape.
    if (!name.trim() && !creating) props.onCancel();
  }, [creating, name, props]);

  return (
    <Animated.View
      style={[{ overflow: 'hidden' }, growStyle]}
      testID="session-section-draft"
    >
      <View
        onLayout={handleLayout}
        style={[
          styles.block,
          { position: 'absolute', left: 0, right: 0, top: 0 },
        ]}
      >
        <View style={styles.field}>
          <View style={styles.mark}>
            <Icon
              name={resolveSessionSectionIcon(null)}
              size={13}
              color={theme.colors.text.tertiary}
            />
          </View>
          <TextInput
            ref={inputRef}
            testID="session-section-draft-input"
            value={creating ? props.draft.name : name}
            onChangeText={setName}
            editable={!creating}
            autoFocus
            placeholder={t('sessionsList.sectionNamePlaceholder')}
            placeholderTextColor={theme.colors.text.tertiary}
            accessibilityLabel={t('sessionsList.newSection')}
            returnKeyType="done"
            blurOnSubmit={false}
            onSubmitEditing={() => props.onSubmit(name)}
            onKeyPress={handleKeyPress}
            onBlur={handleBlur}
            style={styles.input}
          />
          <Text
            variant="micro"
            style={styles.key}
            accessibilityElementsHidden
            importantForAccessibility="no"
          >
            ↵
          </Text>
        </View>
        <View
          style={sessionListStyles.sectionQuietHint}
        >
          <Text
            variant="meta"
            numberOfLines={1}
            style={
              props.draft.failed
                ? styles.failed
                : sessionListStyles.sectionDropHintText
            }
          >
            {props.draft.failed
              ? t('sessionsList.sectionCreateFailed')
              : touchPrimary
                ? t('sessionsList.sectionDropHintTouch')
                : t('sessionsList.sectionDropHint')}
          </Text>
        </View>
      </View>
    </Animated.View>
  );
}
