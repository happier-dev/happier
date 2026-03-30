import React from 'react';
import { ScrollView, View, Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';

import { Text } from '@/components/ui/text/Text';
import type { CustomModalInjectedProps } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { t } from '@/text';

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
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 10,
  },
  helper: {
    color: theme.colors.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
  list: {
    gap: 10,
  },
  row: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: theme.colors.surfaceHigh,
    borderWidth: 1,
    borderColor: theme.colors.divider,
    gap: 4,
  },
  filename: {
    color: theme.colors.text,
    fontSize: 14,
    fontWeight: '600',
  },
  meta: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    lineHeight: 16,
  },
  contentText: {
    color: theme.colors.text,
    fontSize: 12,
    lineHeight: 16,
  },
}));

function formatBytes(bytes: number): string {
  const value = Number.isFinite(bytes) ? Math.max(0, Math.floor(bytes)) : 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function BugReportDiagnosticsPreviewModal(props: Readonly<{
  artifacts: BugReportDiagnosticsPreviewArtifact[];
}> & CustomModalInjectedProps): React.JSX.Element {
  const { theme } = useUnistyles();
  const s = styles;
  const [selected, setSelected] = React.useState<BugReportDiagnosticsPreviewArtifact | null>(null);

  const leading = React.useMemo(() => {
    if (!selected) return null;
    return (
      <Pressable
        onPress={() => setSelected(null)}
        accessibilityRole="button"
        accessibilityLabel={t('common.back')}
        hitSlop={10}
      >
        <Ionicons name="arrow-back" size={18} color={theme.colors.textSecondary} />
      </Pressable>
    );
  }, [selected, theme.colors.textSecondary]);

  const chromeTitle = selected ? selected.filename : t('bugReports.composer.diagnostics.preview.title');
  const chromeSubtitle = selected
    ? `${selected.sourceKind} · ${selected.contentType} · ${formatBytes(selected.sizeBytes)}`
    : undefined;
  const chrome = React.useMemo(() => ({
    kind: 'card' as const,
    leading,
    title: chromeTitle,
    subtitle: chromeSubtitle,
    layout: 'fill' as const,
  }), [chromeSubtitle, chromeTitle, leading]);

  useModalCardChrome(props.setChrome, chrome);

  return (
    <View style={s.container}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
        {selected ? (
          <>
            <Text style={s.helper}>
              {selected.sourceKind} · {selected.contentType} · {formatBytes(selected.sizeBytes)}
            </Text>
            <Text style={s.contentText}>{selected.content}</Text>
          </>
        ) : (
          <>
            <Text style={s.helper}>
              {t('bugReports.composer.diagnostics.preview.helper')}
            </Text>

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
                      {artifact.sourceKind} · {artifact.contentType} · {formatBytes(artifact.sizeBytes)}
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
