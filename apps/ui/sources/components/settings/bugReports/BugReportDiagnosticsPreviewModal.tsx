import { Typography } from '@/constants/Typography';
import { formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation';
import React from 'react';
import { ScrollView, View, Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import type { CustomModalInjectedProps } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

export type BugReportDiagnosticsPreviewArtifact = {
  filename: string;
  sourceKind: string;
  contentType: string;
  sizeBytes: number;
  content: string;
};

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
  },
  body: {
    paddingHorizontal: theme.space.s16,
    paddingVertical: theme.space.s12,
    gap: theme.space.s10,
  },
  helper: {
    color: theme.colors.text.secondary,
    fontSize: 13,
    lineHeight: 18,
  },
  list: {
    gap: theme.space.s10,
  },
  row: {
    paddingVertical: theme.space.s10,
    paddingHorizontal: theme.space.s12,
    borderRadius: 12,
    backgroundColor: theme.colors.surface.inset,
    borderWidth: 1,
    borderColor: theme.colors.border.default,
    gap: theme.space.s4,
  },
  filename: {
    color: theme.colors.text.primary,
    ...Typography.variant('label', 'semiBold'),
  },
  meta: {
    color: theme.colors.text.secondary,
    fontSize: 12,
    lineHeight: 16,
  },
  contentText: {
    color: theme.colors.text.primary,
    fontSize: 12,
    lineHeight: 16,
  },
}));

export function BugReportDiagnosticsPreviewModal(props: Readonly<{
  artifacts: BugReportDiagnosticsPreviewArtifact[];
  onExport?: () => Promise<void>;
}> & CustomModalInjectedProps): React.JSX.Element {
  const { theme } = useUnistyles();
  const s = styles;
  const [selected, setSelected] = React.useState<BugReportDiagnosticsPreviewArtifact | null>(null);

  const leading = React.useMemo(() => {
    if (!selected) return null;
    return (
      <HappierPressable
        onPress={() => setSelected(null)}
        accessibilityRole="button"
        accessibilityLabel={t('common.back')}
      >
        <Icon name="arrow-left" size={16} color={theme.colors.text.secondary} />
      </HappierPressable>
    );
  }, [selected, theme.colors.text.secondary]);

  const chromeTitle = selected ? selected.filename : t('bugReports.composer.diagnostics.preview.title');
  const chromeSubtitle = selected
    ? `${selected.sourceKind} · ${selected.contentType} · ${formatHappierDataBytes(selected.sizeBytes, { kind: 'storage' })}`
    : undefined;
  const chrome = React.useMemo(() => ({
    kind: 'card' as const,
    leading,
    title: chromeTitle,
    subtitle: chromeSubtitle,
  }), [chromeSubtitle, chromeTitle, leading]);

  useModalCardChrome(props.setChrome, chrome);

  return (
    <View style={s.container}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
        {selected ? (
          <Text style={s.contentText}>{selected.content}</Text>
        ) : (
          <>
            <Text style={s.helper}>
              {t('bugReports.composer.diagnostics.preview.helper')}
            </Text>

            {props.onExport ? (
              <Pressable
                style={s.row}
                onPress={() => {
                  void props.onExport?.();
                }}
                accessibilityRole="button"
                accessibilityLabel={t('common.saveAs')}
              >
                <Text style={s.filename}>{t('common.saveAs')}</Text>
                <Text style={s.meta}>{t('bugReports.composer.diagnostics.preview.title')}</Text>
              </Pressable>
            ) : null}

            <View style={s.list}>
              {props.artifacts.length === 0 ? (
                <Text style={s.helper}>{t('bugReports.composer.diagnostics.preview.empty')}</Text>
              ) : (
                props.artifacts.map((artifact) => (
                  <Pressable
                    key={`${artifact.sourceKind}:${artifact.filename}`}
                    style={s.row}
                    onPress={() => setSelected(artifact)}
                    accessibilityRole="button"
                    accessibilityLabel={t('bugReports.composer.diagnostics.preview.openArtifactA11y', {
                      filename: artifact.filename,
                    })}
                  >
                    <Text style={s.filename}>{artifact.filename}</Text>
                    <Text style={s.meta}>
                      {artifact.sourceKind} · {artifact.contentType} · {formatHappierDataBytes(artifact.sizeBytes, { kind: 'storage' })}
                    </Text>
                  </Pressable>
                ))
              )}
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}
