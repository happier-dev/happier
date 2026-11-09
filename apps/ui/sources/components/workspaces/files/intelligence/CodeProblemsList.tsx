import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import type { LanguageIntelligenceDiagnostic } from '@happier-dev/protocol/machines/languageIntelligence';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { FileIcon } from '@/components/ui/media/FileIcon';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import type {
  CodeProblemGroup,
  LanguageStateNote,
} from './codeIntelligencePresentation';

export type CodeProblemsListProps = Readonly<{
  groups: readonly CodeProblemGroup[];
  state: 'idle' | 'ready' | 'checking' | 'unavailable';
  count: number | null;
  progress: LanguageStateNote | null;
  selected?: LanguageIntelligenceDiagnostic | null;
  onOpen: (item: LanguageIntelligenceDiagnostic) => void;
  onCheck: () => void;
  scope?: 'open' | 'project';
  onScopeChange?: (scope: 'open' | 'project') => void;
  onCheckProject?: () => void;
  onCancelProject?: () => void;
  projectChecking?: boolean;
  partial?: boolean;
  /** "Ask Claude to fix 3 problems" / "Save and ask…"; absent when no one can be asked. */
  ask: Readonly<{ label: string; busy: boolean; onPress: () => void }> | null;
  asked?: boolean;
}>;

/**
 * The problems in files you have open (LS1 L2, LS4): by server when more than one speaks, then by
 * file, `glyph · message · line:col`; one Ask at the foot. "No problems" only from a confirmed answer.
 * The list scrolls inside the panel and the Ask stays at its foot, so a long list never hides it.
 */
export function CodeProblemsList(
  props: CodeProblemsListProps,
): React.ReactElement {
  const { theme } = useUnistyles();
  const severityColor = (
    severity: LanguageIntelligenceDiagnostic['severity'],
  ) =>
    severity === 'error'
      ? theme.colors.state.danger.foreground
      : severity === 'warning'
        ? theme.colors.state.warning.foreground
        : theme.colors.text.tertiary;
  const sectioned = props.groups.length > 1;
  const project = props.scope === 'project';
  const empty = props.count === 0 && props.state === 'ready' && !props.partial;
  return (
    <View style={styles.container} testID="code-problems">
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        {props.onScopeChange ? (
          <View style={styles.state}>
            <SegmentedTabBar
              compact
              tabs={[
                { id: 'open', label: t('files.pane.intelligence.openFiles') },
                { id: 'project', label: t('files.pane.intelligence.wholeProject') },
              ]}
              activeTabId={props.scope ?? 'open'}
              onSelectTab={props.onScopeChange}
              testIDPrefix="code-problems-scope"
            />
          </View>
        ) : (
          <Text variant="meta" style={styles.caption}>
            {t('files.pane.intelligence.problemsScope')}
          </Text>
        )}
        {/* The project check belongs to its own scope: Open files never offers it, and before the first
            check the scope says what it covers, the same way the open-files scope does. */}
        {props.onCheckProject && project ? (
          <View style={styles.state}>
            {props.state === 'idle' ? (
              <Text variant="body" style={styles.stateText}>{t('files.pane.intelligence.projectProblemsIdle')}</Text>
            ) : null}
            <View style={styles.stateAction}>
              <RoundButton
                size="small"
                display="secondary"
                title={props.projectChecking ? t('common.cancel') : t('files.pane.intelligence.checkWholeProject')}
                onPress={props.projectChecking ? props.onCancelProject : props.onCheckProject}
                testID={props.projectChecking ? 'code-project-problems-cancel' : 'code-project-problems-check'}
              />
            </View>
          </View>
        ) : null}
        {props.state === 'unavailable' && project ? (
          <View style={styles.state}>
            <Text variant="body" style={styles.stateText}>{t('files.pane.intelligence.projectProblemsUnavailable')}</Text>
          </View>
        ) : props.state === 'idle' && !project ? (
          <View style={styles.state}>
            <Text variant="body" style={styles.stateText}>
              {t('files.pane.intelligence.problemsIdle')}
            </Text>
            <View style={styles.stateAction}>
              <RoundButton
                size="small"
                display="secondary"
                title={t('files.pane.intelligence.checkProblems')}
                onPress={props.onCheck}
                testID="code-problems-check"
              />
            </View>
          </View>
        ) : props.state === 'checking' || props.progress ? (
          <View style={styles.state} testID="code-problems-checking">
            <Text variant="body" style={styles.stateText}>
              {props.progress?.text ?? t('files.pane.intelligence.checking')}
            </Text>
            {props.progress?.detail ? (
              <Text variant="meta" style={styles.stateDetail}>
                {props.progress.detail}
              </Text>
            ) : null}
          </View>
        ) : empty ? (
          <View style={styles.state} testID="code-problems-none">
            <Text variant="body" style={styles.stateText}>
              {project ? t('files.pane.intelligence.projectNoProblems') : t('files.pane.intelligence.noProblems')}
            </Text>
          </View>
        ) : null}
        {props.partial && props.state === 'ready' ? (
          <Text variant="meta" style={styles.caption}>{t('files.pane.intelligence.projectProblemsPartial')}</Text>
        ) : null}
        {props.groups.map((group) => (
          <View key={group.serverId}>
            {sectioned ? (
              <Text variant="label" emphasis="medium" style={styles.section}>
                {group.serverLabel}
              </Text>
            ) : null}
            {group.files.map((file) => (
              <View key={file.path}>
                <View style={styles.fileRow}>
                  <FileIcon fileName={file.path} size={14} appearance="line" />
                  <Text variant="label" numberOfLines={1} style={styles.fileName}>
                    {file.path.split('/').at(-1) ?? file.path}
                  </Text>
                  <Text variant="meta" style={styles.count}>
                    {file.items.length}
                  </Text>
                </View>
                {file.items.map((item, index) => {
                  const selected = props.selected === item;
                  return (
                    <HappierPressable
                      key={`${item.range.start.line}:${item.range.start.character}:${index}`}
                      accessibilityRole="button"
                      testID={`code-problem-${file.path}:${item.range.start.line + 1}`}
                      selected={selected}
                      onPress={() => props.onOpen(item)}
                      style={({ hovered, pressed }) => [
                        styles.row,
                        selected || pressed
                          ? styles.rowSelected
                          : hovered
                            ? styles.rowHovered
                            : null,
                      ]}
                    >
                      <View style={styles.glyph}>
                        <Icon
                          name={
                            item.severity === 'error'
                              ? 'x-circle'
                              : 'warning-circle'
                          }
                          size={14}
                          color={severityColor(item.severity)}
                        />
                      </View>
                      <Text variant="body" style={styles.message}>
                        {item.message}
                        <Text
                          variant="meta"
                          style={styles.position}
                        >{`  ${item.range.start.line + 1}:${item.range.start.character + 1}`}</Text>
                      </Text>
                    </HappierPressable>
                  );
                })}
              </View>
            ))}
          </View>
        ))}
      </ScrollView>
      {props.asked ? (
        <View style={styles.footer} testID="code-problems-asked">
          <Icon
            name="check-circle"
            size={14}
            color={theme.colors.text.secondary}
          />
          <Text variant="label" style={styles.stateText}>
            {t('files.pane.intelligence.addedToMessage')}
          </Text>
        </View>
      ) : props.ask ? (
        <View style={styles.footer}>
          <RoundButton
            size="normal"
            display="secondary"
            title={props.ask.label}
            loading={props.ask.busy}
            onPress={props.ask.onPress}
            leading={
              <Icon
                name="sparkle"
                size={14}
                color={theme.colors.text.primary}
              />
            }
            testID="code-problems-ask"
            style={styles.askButton}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
  },
  scroll: {
    flex: 1,
    minHeight: 0,
  },
  scrollContent: {
    paddingTop: theme.space.s8,
    paddingBottom: theme.space.s12,
  },
  caption: {
    color: theme.colors.text.tertiary,
    paddingHorizontal: theme.space.s16,
    paddingBottom: theme.space.s6,
  },
  state: {
    paddingHorizontal: theme.space.s16,
    paddingVertical: theme.space.s8,
    gap: theme.space.s8,
  },
  stateText: {
    color: theme.colors.text.secondary,
  },
  // The detail sits in the state block's own inset, under its sentence.
  stateDetail: {
    color: theme.colors.text.tertiary,
  },
  stateAction: {
    flexDirection: 'row',
  },
  section: {
    color: theme.colors.text.primary,
    paddingHorizontal: theme.space.s16,
    paddingTop: theme.space.s12,
  },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    paddingHorizontal: theme.space.s16,
    paddingTop: theme.space.s10,
    paddingBottom: theme.space.s4,
  },
  fileName: {
    flex: 1,
    color: theme.colors.text.secondary,
  },
  count: {
    color: theme.colors.text.tertiary,
    fontVariant: ['tabular-nums'],
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space.s8,
    marginHorizontal: theme.space.s6,
    paddingHorizontal: theme.space.s10,
    paddingVertical: theme.space.s6,
    borderRadius: theme.borderRadius.sm,
  },
  rowHovered: {
    backgroundColor: theme.colors.surface.pressed,
  },
  rowSelected: {
    backgroundColor: theme.colors.surface.selected,
  },
  glyph: {
    paddingTop: 3,
  },
  message: {
    flex: 1,
    color: theme.colors.text.primary,
  },
  position: {
    color: theme.colors.text.tertiary,
    fontVariant: ['tabular-nums'],
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space.s6,
    paddingHorizontal: theme.space.s16,
    paddingVertical: theme.space.s12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.subtle,
  },
  askButton: {
    flex: 1,
  },
}));
