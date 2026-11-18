import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { readSkillFrontmatterV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';

import { MarkdownView } from '@/components/markdown/MarkdownView';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DiffViewer } from '@/components/ui/code/diff/DiffViewer';
import type { CodeEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';
import { Icon } from '@/components/ui/icons/Icon';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { MarkdownCodeEditorField } from '@/components/ui/markdown/editor/MarkdownCodeEditorField';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { t } from '@/text';

import type { SkillChangeResult } from './useSkillDetail';

/** How long typing pauses before the edit saves (sd E "on pause"); blur and Done save at once. */
const AUTOSAVE_PAUSE_MS = 800;

export type SkillInstructionsSaveState =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'saving' }>
  | Readonly<{ kind: 'saved' }>
  | Readonly<{ kind: 'failed' }>
  | Readonly<{ kind: 'conflict' }>;

/** The frontmatter body without its block, for the rendered view (agents read the frontmatter; people read this). */
function stripFrontmatter(markdown: string): string {
  return markdown
    .replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?/, '')
    .trimStart();
}

/** What the bundle validator would say about the frontmatter, as one quiet line. */
export function lintSkillMarkdown(
  markdown: string,
): Readonly<{ ok: boolean; message: string }> {
  if (!/^---\s*\r?\n[\s\S]*?\r?\n---/.test(markdown))
    return {
      ok: false,
      message: t('capabilities.skillDetail.instructions.lintNoFrontmatter'),
    };
  const frontmatter = readSkillFrontmatterV1(markdown);
  if (!frontmatter.name)
    return {
      ok: false,
      message: t('capabilities.skillDetail.instructions.lintMissingName'),
    };
  if (!frontmatter.description)
    return {
      ok: false,
      message: t(
        'capabilities.skillDetail.instructions.lintMissingDescription',
      ),
    };
  return {
    ok: true,
    message: t('capabilities.skillDetail.instructions.lintOk'),
  };
}

/**
 * The text an edit keeps and when it saves: every pause and every blur sends the newest text once
 * (`onSave`), never two saves at the same time; a refusal keeps the text. A `revision_conflict` stops
 * saving until the person chooses Keep mine or Take theirs.
 */
export function useSkillTextAutosave(
  input: Readonly<{
    saved: string;
    onSave: (text: string) => Promise<SkillChangeResult>;
    onDirtyChange?: (dirty: boolean) => void;
  }>,
) {
  const { saved, onSave, onDirtyChange } = input;
  const [text, setTextState] = React.useState(saved);
  const [saveState, setSaveState] = React.useState<SkillInstructionsSaveState>({
    kind: 'idle',
  });
  const textRef = React.useRef(saved);
  const savedRef = React.useRef(saved);
  const inFlight = React.useRef<Promise<void> | null>(null);
  const conflictRef = React.useRef(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSaveRef = React.useRef(onSave);
  onSaveRef.current = onSave;
  const onDirtyRef = React.useRef(onDirtyChange);
  onDirtyRef.current = onDirtyChange;

  // A newer read that the page did not cause (no edit pending) replaces the text.
  React.useEffect(() => {
    if (textRef.current === savedRef.current) {
      textRef.current = saved;
      setTextState(saved);
    }
    savedRef.current = saved;
  }, [saved]);

  const flush = React.useCallback(async (): Promise<void> => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (inFlight.current) {
      await inFlight.current;
    }
    if (conflictRef.current) return;
    const next = textRef.current;
    if (next === savedRef.current) return;
    setSaveState({ kind: 'saving' });
    const run = (async () => {
      const result = await onSaveRef.current(next);
      if (result.ok) {
        savedRef.current = next;
        setSaveState({ kind: 'saved' });
        if (textRef.current === next) onDirtyRef.current?.(false);
      } else if (result.code === 'revision_conflict') {
        conflictRef.current = true;
        setSaveState({ kind: 'conflict' });
      } else {
        setSaveState({ kind: 'failed' });
      }
    })();
    inFlight.current = run;
    try {
      await run;
    } finally {
      if (inFlight.current === run) inFlight.current = null;
    }
    // Typing that arrived during the save goes out next.
    if (
      !conflictRef.current &&
      textRef.current !== savedRef.current &&
      !timer.current
    ) {
      timer.current = setTimeout(() => {
        timer.current = null;
        void flush();
      }, AUTOSAVE_PAUSE_MS);
    }
  }, []);

  const setText = React.useCallback(
    (next: string) => {
      textRef.current = next;
      setTextState(next);
      onDirtyRef.current?.(next !== savedRef.current);
      if (conflictRef.current) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        void flush();
      }, AUTOSAVE_PAUSE_MS);
    },
    [flush],
  );

  /** The conflict is settled: `base` is the library's current text; `keep` is what stays on the page. */
  const resolve = React.useCallback(
    (base: string, keep: string) => {
      conflictRef.current = false;
      savedRef.current = base;
      textRef.current = keep;
      setTextState(keep);
      setSaveState({ kind: 'idle' });
      onDirtyRef.current?.(keep !== base);
      if (keep !== base) void flush();
    },
    [flush],
  );

  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return { text, setText, flush, saveState, resolve } as const;
}

export function SkillInstructionsSection(
  props: Readonly<{
    skillId: string;
    skillMd: string;
    /** Host-owned (built in or from a plugin): never edited here; its note says whose it is. */
    readOnly: false | Readonly<{ note?: string }>;
    /** The draft page starts in the editor and never autosaves (the person adds it once). */
    draft?: Readonly<{ text: string; onChange: (text: string) => void }>;
    onSave: (text: string) => Promise<SkillChangeResult>;
    onDirtyChange: (dirty: boolean) => void;
    /** The library's current SKILL.md, for Review both. */
    readTheirs: () => Promise<Readonly<{
      text: string;
      revision: string;
    }> | null>;
    /** Adopt the library's current revision as the page's base (Keep mine / Take theirs). */
    adoptTheirs: () => Promise<void>;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const draftMode = props.draft !== undefined;
  const [editing, setEditing] = React.useState(draftMode);
  const [tab, setTab] = React.useState<'preview' | 'edit'>('edit');
  const [expanded, setExpanded] = React.useState(false);
  const [clipped, setClipped] = React.useState(false);
  const [review, setReview] = React.useState<Readonly<{
    theirs: string;
  }> | null>(null);
  const editorRef = React.useRef<CodeEditorHandle | null>(null);
  const autosave = useSkillTextAutosave({
    saved: props.skillMd,
    onSave: props.onSave,
    onDirtyChange: props.onDirtyChange,
  });
  const text = props.draft ? props.draft.text : autosave.text;
  const setText = props.draft ? props.draft.onChange : autosave.setText;
  const lint = React.useMemo(() => lintSkillMarkdown(text), [text]);
  const body = React.useMemo(
    () => stripFrontmatter(editing ? text : props.skillMd),
    [editing, props.skillMd, text],
  );
  const clipHeight = PAGE_LIST_METRICS.readingClipHeightPx;

  const done = React.useCallback(async () => {
    try {
      await editorRef.current?.flushPendingChange();
      await autosave.flush();
      setEditing(false);
      setTab('edit');
    } catch {
      await Modal.alert(t('common.error'), t('errors.operationFailed'));
    }
  }, [autosave]);

  const openReview = React.useCallback(async () => {
    const theirs = await props.readTheirs();
    if (theirs) setReview({ theirs: theirs.text });
  }, [props]);

  const keepMine = React.useCallback(async () => {
    const theirs = await props.readTheirs();
    if (!theirs) return;
    await props.adoptTheirs();
    setReview(null);
    autosave.resolve(theirs.text, autosave.text);
  }, [autosave, props]);

  const takeTheirs = React.useCallback(async () => {
    const theirs = await props.readTheirs();
    if (!theirs) return;
    await props.adoptTheirs();
    setReview(null);
    autosave.resolve(theirs.text, theirs.text);
  }, [autosave, props]);

  const status = autosave.saveState;
  const statusText =
    status.kind === 'saving'
      ? t('capabilities.skillDetail.instructions.saving')
      : status.kind === 'saved'
        ? t('capabilities.skillDetail.instructions.saved')
        : status.kind === 'failed'
          ? t('capabilities.skillDetail.instructions.saveFailed')
          : null;

  return (
    <ItemGroup
      testID={props.testID}
      title={t('capabilities.skillDetail.instructions.title')}
      description={
        props.readOnly ? props.readOnly.note : undefined
      }
      action={
        props.readOnly || draftMode ? undefined : (
          <SectionActionButton
            testID={`${props.testID}:${editing ? 'done' : 'edit'}`}
            title={
              editing
                ? t('capabilities.skillDetail.instructions.done')
                : t('capabilities.skillDetail.instructions.edit')
            }
            icon={editing ? 'check' : 'pencil'}
            onPress={() => {
              if (editing) void done();
              else setEditing(true);
            }}
          />
        )
      }
    >
      {editing ? (
        <>
          <SectionContentRow showDivider testID={`${props.testID}:bar`}>
            <View style={styles.bar}>
              <SegmentedTabBar
                tabs={[
                  {
                    id: 'preview',
                    label: t('capabilities.skillDetail.instructions.preview'),
                  },
                  {
                    id: 'edit',
                    label: t('capabilities.skillDetail.instructions.edit'),
                  },
                ]}
                activeTabId={tab}
                onSelectTab={async (next) => {
                  try {
                    if (next === 'preview')
                      await editorRef.current?.flushPendingChange();
                    setTab(next);
                  } catch {
                    await Modal.alert(t('common.error'), t('errors.operationFailed'));
                  }
                }}
                compact
                segmentSizing="content"
                testIDPrefix={`${props.testID}:tab`}
              />
              <View style={styles.barEnd}>
                {status.kind === 'conflict' ? (
                  <View
                    style={styles.conflict}
                    testID={`${props.testID}:conflict`}
                  >
                    <Icon
                      name="warning"
                      size={14}
                      color={theme.colors.state.warning.foreground}
                    />
                    <Text variant="meta" style={styles.conflictText}>
                      {t('capabilities.skillDetail.instructions.conflict')}
                    </Text>
                    <RoundButton
                      testID={`${props.testID}:reviewBoth`}
                      size="small"
                      display="secondary"
                      title={t(
                        'capabilities.skillDetail.instructions.reviewBoth',
                      )}
                      onPress={() => {
                        void openReview();
                      }}
                    />
                  </View>
                ) : statusText ? (
                  <View
                    style={styles.saved}
                    testID={`${props.testID}:saveState`}
                  >
                    {status.kind === 'saved' ? (
                      <Icon
                        name="check"
                        size={13}
                        color={theme.colors.text.tertiary}
                      />
                    ) : null}
                    <Text
                      variant="meta"
                      style={
                        status.kind === 'failed' ? styles.failed : styles.quiet
                      }
                    >
                      {statusText}
                    </Text>
                  </View>
                ) : null}
              </View>
            </View>
          </SectionContentRow>
          {review ? (
            <SectionContentRow showDivider testID={`${props.testID}:review`}>
              <View style={styles.review}>
                <View style={styles.reviewLabels}>
                  <Text variant="label" style={styles.quiet}>
                    {t('capabilities.skillDetail.instructions.theirs')}
                  </Text>
                  <Text variant="label" style={styles.quiet}>
                    {t('capabilities.skillDetail.instructions.yours')}
                  </Text>
                </View>
                <DiffViewer
                  mode="text"
                  oldText={review.theirs}
                  newText={text}
                  filePath="SKILL.md"
                  wrapLines
                  presentationStyleOverride="split"
                />
                <View style={styles.reviewActions}>
                  <RoundButton
                    testID={`${props.testID}:takeTheirs`}
                    size="small"
                    display="secondary"
                    title={t(
                      'capabilities.skillDetail.instructions.takeTheirs',
                    )}
                    onPress={() => {
                      void takeTheirs();
                    }}
                  />
                  <RoundButton
                    testID={`${props.testID}:keepMine`}
                    size="small"
                    display="default"
                    title={t('capabilities.skillDetail.instructions.keepMine')}
                    onPress={() => {
                      void keepMine();
                    }}
                  />
                </View>
              </View>
            </SectionContentRow>
          ) : null}
          {tab === 'edit' ? (
            <View style={styles.editor} testID={`${props.testID}:editor`}>
              <MarkdownCodeEditorField
                resetKey={props.skillId}
                testID={`${props.testID}:field`}
                value={text}
                readOnly={Boolean(props.readOnly)}
                filePath="SKILL.md"
                onChange={setText}
                editorRef={editorRef}
                sourceOnly
                presentation="canvas"
              />
            </View>
          ) : (
            <SectionContentRow showDivider testID={`${props.testID}:preview`}>
              <MarkdownView markdown={body} selectable profile="document" />
            </SectionContentRow>
          )}
          <SectionContentRow
            showDivider={false}
            testID={`${props.testID}:lint`}
          >
            <View style={styles.lint}>
              <Icon
                name={lint.ok ? 'check' : 'warning'}
                size={13}
                color={
                  lint.ok
                    ? theme.colors.text.tertiary
                    : theme.colors.state.warning.foreground
                }
              />
              <Text
                variant="meta"
                style={lint.ok ? styles.quiet : styles.lintWarning}
              >
                {lint.message}
              </Text>
            </View>
          </SectionContentRow>
        </>
      ) : (
        <SectionContentRow showDivider={false} testID={`${props.testID}:view`}>
          <View
            style={[
              styles.clip,
              !expanded && clipped ? { maxHeight: clipHeight } : null,
            ]}
          >
            <View
              onLayout={(event) => {
                if (!expanded)
                  setClipped(event.nativeEvent.layout.height > clipHeight);
              }}
            >
              <MarkdownView markdown={body} selectable profile="document" />
            </View>
          </View>
          {clipped ? (
            <View style={styles.more}>
              <RoundButton
                testID={`${props.testID}:showAll`}
                size="small"
                display="inverted"
                title={
                  expanded
                    ? t('capabilities.skillDetail.instructions.showLess')
                    : t('capabilities.skillDetail.instructions.showAll')
                }
                onPress={() => setExpanded((value) => !value)}
              />
            </View>
          ) : null}
        </SectionContentRow>
      )}
    </ItemGroup>
  );
}

const styles = StyleSheet.create((theme) => ({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.space.s12,
    flexWrap: 'wrap',
  },
  barEnd: { flexShrink: 1, alignItems: 'flex-end' },
  saved: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s4 },
  conflict: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
  },
  conflictText: { color: theme.colors.text.primary },
  quiet: { color: theme.colors.text.tertiary },
  failed: { color: theme.colors.state.danger.textForeground },
  editor: {
    minHeight: 320,
    paddingHorizontal: PAGE_LIST_METRICS.rowPaddingHorizontalPx,
    paddingVertical: theme.space.s12,
  },
  lint: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s6 },
  lintWarning: { color: theme.colors.text.secondary },
  clip: { overflow: 'hidden' },
  more: { marginTop: theme.space.s8, alignItems: 'flex-start' },
  review: { gap: theme.space.s10 },
  reviewLabels: { flexDirection: 'row', justifyContent: 'space-between' },
  reviewActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: theme.space.s8,
  },
}));
