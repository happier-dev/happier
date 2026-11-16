import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { SkillReadResultV1 } from '@happier-dev/protocol/prompts/library/skills/skillReadV1';
import { formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation';

import { Icon } from '@/components/ui/icons/Icon';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { MarkdownCodeEditorField } from '@/components/ui/markdown/editor/MarkdownCodeEditorField';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';

import { useSkillTextAutosave } from './SkillInstructionsSection';
import {
  isSkillScript,
  readSkillText,
  skillTextFile,
} from './skillFileContent';
import type { SkillChange, SkillChangeResult } from './useSkillDetail';
import { readSkillActionFailure } from '../skillActionResult';

/** Past this many files the list shows the first ones and one "N more" row (layout density, not a limit). */
const FOLDED_FILE_COUNT = 40;
const FOLDED_VISIBLE = 8;

type SkillFile = SkillReadResultV1['files'][number];

/** One file's text, opened in place and saved like the instructions (pause and blur). */
function SkillFileEditor(
  props: Readonly<{
    skillId: string;
    file: SkillFile;
    readOnly: boolean;
    readFile: (path: string) => Promise<Readonly<{ text: string | null }>>;
    update: (change: SkillChange) => Promise<SkillChangeResult>;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const [loaded, setLoaded] = React.useState<
    Readonly<{ text: string | null }> |
    Readonly<{ error: ReturnType<typeof readSkillActionFailure> }> | null
  >(null);
  React.useEffect(() => {
    let cancelled = false;
    void props.readFile(props.file.path).then(
      (value) => { if (!cancelled) setLoaded(value); },
      (error: unknown) => { if (!cancelled) setLoaded({ error: readSkillActionFailure(error) }); },
    );
    return () => {
      cancelled = true;
    };
  }, [props.file.path, props.readFile]);
  const { path, unixMode } = props.file;
  const update = props.update;
  const onSave = React.useCallback(
    (text: string) =>
      update({
        files: [{ kind: 'upsert', file: skillTextFile(path, text, unixMode) }],
      }),
    [path, unixMode, update],
  );
  const autosave = useSkillTextAutosave({ saved: loaded && 'text' in loaded ? loaded.text ?? '' : '', onSave });
  if (!loaded)
    return (
      <Text variant="meta" style={{ color: theme.colors.text.tertiary }}>
        {t('capabilities.skillDetail.files.loading')}
      </Text>
    );
  if ('error' in loaded)
    return <SurfaceStateCard testID={`${props.testID}:error`} kind="error" size="line"
      title={t('common.error')} diagnosticCode={loaded.error.code} diagnosticDetail={loaded.error.message}
      accessibilitySemantics="alert" />;
  if (loaded.text === null)
    return (
      <Text variant="meta" style={{ color: theme.colors.text.tertiary }}>
        {t('capabilities.skillDetail.files.binary')}
      </Text>
    );
  return (
    <View style={styles.editor}>
      <MarkdownCodeEditorField
        resetKey={`${props.skillId}:${path}`}
        testID={props.testID}
        value={autosave.text}
        filePath={path}
        onChange={autosave.setText}
        readOnly={props.readOnly}
        sourceOnly
        presentation="canvas"
      />
    </View>
  );
}

/**
 * "Files" (sd D): what the skill carries besides its instructions, in one compact sheet: the path in
 * mono, its size, and "Script" for an entry whose mode has an exec bit (IR-7). A text file opens in place
 * to read or edit; Remove sits in its row's `⋯`; "Add a file" asks for a path and opens the new file.
 */
export function SkillFilesSection(
  props: Readonly<{
    read: SkillReadResultV1;
    readOnly: boolean;
    update: (change: SkillChange) => Promise<SkillChangeResult>;
    readFile: (path: string) => Promise<Readonly<{ text: string | null }>>;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const { read, update } = props;
  const [open, setOpen] = React.useState<string | null>(null);
  const [showAll, setShowAll] = React.useState(false);
  const files = React.useMemo(
    () =>
      [...read.files].sort((a, b) =>
        a.path === 'SKILL.md'
          ? -1
          : b.path === 'SKILL.md'
            ? 1
            : a.path.localeCompare(b.path),
      ),
    [read.files],
  );
  const scripts = files.filter((file) => isSkillScript(file.unixMode)).length;
  const folded = files.length >= FOLDED_FILE_COUNT && !showAll;
  const visible = folded ? files.slice(0, FOLDED_VISIBLE) : files;

  const addFile = React.useCallback(async () => {
    const path = (
      await Modal.prompt(
        t('capabilities.skillDetail.files.addFile'),
        t('capabilities.skillDetail.files.addFilePrompt'),
        {
          placeholder: t('capabilities.skillDetail.files.addFilePlaceholder'),
          confirmText: t('capabilities.skillDetail.files.addFile'),
        },
      )
    )?.trim();
    if (!path) return;
    const result = await update({
      files: [{ kind: 'upsert', file: skillTextFile(path, '') }],
    });
    if (result.ok) setOpen(path);
  }, [update]);

  const removeFile = React.useCallback(
    async (path: string) => {
      const confirmed = await Modal.confirm(
        t('capabilities.skillDetail.files.removeTitle', { path }),
        t('capabilities.skillDetail.files.removeBody'),
        {
          confirmText: t('capabilities.skillDetail.files.remove'),
          destructive: true,
        },
      );
      if (!confirmed) return;
      await update({ files: [{ kind: 'remove', path }] });
      setOpen((current) => (current === path ? null : current));
    },
    [update],
  );

  return (
    <ItemGroup
      testID={props.testID}
      title={t('capabilities.skillDetail.files.title')}
      description={
        scripts > 0
          ? t('capabilities.skillDetail.files.descriptionScripts', {
              count: files.length,
              scripts,
            })
          : t('capabilities.skillDetail.files.description', {
              count: files.length,
            })
      }
      density="compact"
      action={
        props.readOnly ? undefined : (
          <SectionActionButton
            testID={`${props.testID}:add`}
            title={t('capabilities.skillDetail.files.addFile')}
            icon="plus"
            onPress={() => {
              void addFile();
            }}
          />
        )
      }
    >
      {visible.map((file) => {
        const script = isSkillScript(file.unixMode);
        const expandable = file.path !== 'SKILL.md';
        const end = (
          <View style={styles.end}>
            {script ? (
              <StatusPill
                variant="neutral"
                chrome="pill"
                label={t('capabilities.skillDetail.files.script')}
                hideDot
                leading={
                  <Icon
                    name="terminal"
                    size={12}
                    color={theme.colors.text.secondary}
                  />
                }
              />
            ) : null}
            <Text variant="meta" style={styles.size}>
              {formatHappierDataBytes(file.bytes, { kind: 'storage' })}
            </Text>
            {expandable && !props.readOnly ? (
              <ItemRowActions
                title={file.path}
                overflowOnly
                actions={[
                  {
                    id: 'remove',
                    title: t('capabilities.skillDetail.files.remove'),
                    icon: 'trash',
                    destructive: true,
                    onPress: () => {
                      void removeFile(file.path);
                    },
                  },
                ]}
              />
            ) : null}
          </View>
        );
        const row = (headerProps?: Readonly<Record<string, unknown>>) => (
          <Item
            {...(headerProps ?? {})}
            testID={`${props.testID}:file:${file.path}`}
            title={file.path}
            titleStyle={styles.path}
            icon={
              <Icon
                name="file-text"
                size={18}
                color={theme.colors.text.secondary}
              />
            }
            rightElement={end}
            // The overflow menu is a control of its own: it sits beside the row's pressable, never inside it.
            rightElementOutsidePressable={expandable && !props.readOnly}
            showChevron={false}
          />
        );
        if (!expandable)
          return <React.Fragment key={file.path}>{row()}</React.Fragment>;
        const expanded = open === file.path;
        return (
          <ExpandableItem
            key={file.path}
            testID={`${props.testID}:disclosure:${file.path}`}
            expanded={expanded}
            onExpandedChange={(next) => setOpen(next ? file.path : null)}
            showDivider
            header={({ headerProps }) =>
              row(headerProps as Readonly<Record<string, unknown>>)
            }
          >
            {expanded ? (
              <SkillFileEditor
                skillId={read.skillId}
                file={file}
                readOnly={props.readOnly}
                readFile={props.readFile}
                update={update}
                testID={`${props.testID}:editor:${file.path}`}
              />
            ) : null}
          </ExpandableItem>
        );
      })}
      {folded ? (
        <Item
          testID={`${props.testID}:more`}
          title={t('capabilities.skillDetail.files.more', {
            count: files.length - FOLDED_VISIBLE,
          })}
          onPress={() => setShowAll(true)}
          showChevron={false}
          titleStyle={{ color: theme.colors.text.secondary }}
        />
      ) : null}
    </ItemGroup>
  );
}

/** Reads one file's text through `skills.read { file }`; a binary file reads as `null`. */
export function readSkillFileText(
  file:
    | Readonly<{ contentKind: 'utf8' | 'binary'; contentBase64: string }>
    | undefined,
): string | null {
  if (!file || file.contentKind !== 'utf8') return null;
  return readSkillText(file.contentBase64);
}

const styles = StyleSheet.create((theme) => ({
  end: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
  size: { color: theme.colors.text.tertiary, fontVariant: ['tabular-nums'] },
  path: { ...Typography.mono() },
  editor: {
    minHeight: 200,
    paddingHorizontal: PAGE_LIST_METRICS.rowPaddingHorizontalPx,
    paddingBottom: theme.space.s12,
  },
}));
