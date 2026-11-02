import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Text } from '@/components/ui/text/Text';
import { formatKeycapLabel, useKeyboardShortcutLabel } from '@/keyboard/shortcutLabels';
import { t } from '@/text';

import type { ImageAnnotator } from './annotatorStore';
import { useImageAnnotatorState } from './useImageAnnotator';

/** Stands level with the capsule's round wells. */
const ACTION_HEIGHT = 28;

/**
 * Reset · Cancel · Crop ↩ (lab `an · ANc`). Reset brings back the whole picture without leaving Crop,
 * Cancel keeps the crop as it was, and Crop applies. Keys say the same: Esc and Return.
 */
export function AnnotatorCropActions(props: Readonly<{ annotator: ImageAnnotator }>) {
  const { annotator } = props;
  const { theme } = useUnistyles();
  const shortcut = formatKeycapLabel(useKeyboardShortcutLabel('annotation.cropApply') ?? 'Enter');
  const whole = useImageAnnotatorState(annotator, (state) => {
    const draft = state.cropDraft;
    return !draft || (draft.x === 0 && draft.y === 0 && draft.width === annotator.source.width && draft.height === annotator.source.height);
  });
  return (
    <View style={styles.row} testID="annotator-crop-actions">
      <View style={styles.link}>
        <TextLinkButton
          label={t('common.reset')}
          tone="quiet"
          disabled={whole}
          onPress={() => annotator.previewCrop({ x: 0, y: 0, width: annotator.source.width, height: annotator.source.height })}
          testID="annotator-crop-reset"
        />
      </View>
      <View style={styles.link}>
        <TextLinkButton
          label={t('common.cancel')}
          tone="quiet"
          onPress={annotator.cancelCrop}
          testID="annotator-crop-cancel"
        />
      </View>
      <RoundButton
        size="small"
        capsuleHeight={ACTION_HEIGHT}
        title={t('files.annotate.tools.crop')}
        trailing={<Text variant="micro" style={{ color: theme.colors.button.primary.tint }}>{shortcut}</Text>}
        onPress={annotator.commitCrop}
        testID="annotator-crop-apply"
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s2,
    flex: 1,
    justifyContent: 'center',
  },
  link: {
    paddingHorizontal: theme.space.s8,
  },
}));
