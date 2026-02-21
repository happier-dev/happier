import React from 'react';
import { ScrollView, View, Pressable, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/ui/text/Text';

export type BugReportDiagnosticsPreviewArtifact = {
  filename: string;
  sourceKind: string;
  contentType: string;
  sizeBytes: number;
  content: string;
};

const styles = StyleSheet.create((theme) => ({
  card: {
    width: '92%',
    maxWidth: 560,
    backgroundColor: theme.colors.surface,
    borderRadius: 16,
    overflow: 'hidden',
    flexShrink: 1,
    shadowColor: theme.colors.shadow.color,
    shadowOffset: { width: 0, height: 0.5 },
    shadowOpacity: theme.colors.shadow.opacity,
    shadowRadius: 0,
    elevation: 2,
  },
  header: {
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.divider,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
    paddingRight: 10,
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    color: theme.colors.text,
    flexShrink: 1,
  },
  closeButton: {
    padding: 6,
    borderRadius: 10,
  },
  backButton: {
    padding: 6,
    borderRadius: 10,
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
  onClose: () => void;
}>): React.JSX.Element {
  const { theme } = useUnistyles();
  const s = styles;
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const maxHeight = Math.max(240, Math.floor(window.height - (insets.top + insets.bottom + 96)));
  const [selected, setSelected] = React.useState<BugReportDiagnosticsPreviewArtifact | null>(null);

  return (
    <View style={[s.card, { maxHeight }]}>
      <View style={s.header}>
        <View style={s.headerLeft}>
          {selected ? (
            <Pressable
              onPress={() => setSelected(null)}
              accessibilityRole="button"
              accessibilityLabel="Back"
              style={s.backButton}
              hitSlop={10}
            >
              <Ionicons name="arrow-back" size={18} color={theme.colors.textSecondary} />
            </Pressable>
          ) : null}
          <Text style={s.title} numberOfLines={1}>
            {selected ? selected.filename : 'Diagnostics preview'}
          </Text>
        </View>
        <Pressable
          onPress={props.onClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
          style={s.closeButton}
          hitSlop={10}
        >
          <Ionicons name="close" size={18} color={theme.colors.textSecondary} />
        </Pressable>
      </View>

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
              These artifacts will be uploaded with your report (sanitized and size-bounded). Tap an item to view its full contents.
            </Text>

            <View style={s.list}>
              {props.artifacts.length === 0 ? (
                <Text style={s.helper}>No diagnostics artifacts would be sent.</Text>
              ) : (
                props.artifacts.map((artifact) => (
                  <Pressable
                    key={`${artifact.sourceKind}:${artifact.filename}`}
                    style={s.row}
                    onPress={() => setSelected(artifact)}
                    accessibilityRole="button"
                    accessibilityLabel={`Open ${artifact.filename}`}
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

