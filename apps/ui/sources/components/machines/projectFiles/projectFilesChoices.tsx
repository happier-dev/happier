import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import {
  PROJECT_FILES_OPTIONS,
  type ProjectFilesOptionId,
} from '@/sync/domains/machines/projectFiles/projectFilesOptions';
import { t } from '@/text';

export type ProjectFilesChoice = Readonly<{
  id: ProjectFilesOptionId;
  title: string;
  subtitle: string;
  rightElement?: React.ReactNode;
  disabled?: boolean;
}>;

/**
 * "How files get in" as menu rows, for the preset's select and the New Session override alike: the option
 * owner's title and meaning, with Default and Advanced beside the check. A choice the host can't store yet
 * stays listed, dimmed.
 */
export function useProjectFilesChoices(
  input: Readonly<{ available: (id: ProjectFilesOptionId) => boolean }>,
): readonly ProjectFilesChoice[] {
  const { available } = input;
  return React.useMemo(
    () =>
      PROJECT_FILES_OPTIONS.map((option) => ({
        id: option.id,
        title: t(option.titleKey),
        subtitle: t(option.subtitleKey),
        ...(option.mark
          ? {
              rightElement: (
                <Text variant="meta" style={styles.mark}>
                  {t(
                    option.mark === 'default'
                      ? 'machineDetailPage.projectFiles.isDefault'
                      : 'machineDetailPage.projectFiles.advanced',
                  )}
                </Text>
              ),
            }
          : {}),
        ...(available(option.id) ? {} : { disabled: true }),
      })),
    [available],
  );
}

const styles = StyleSheet.create((theme) => ({
  mark: { color: theme.colors.text.secondary },
}));
