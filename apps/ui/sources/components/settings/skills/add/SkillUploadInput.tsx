import * as React from 'react';
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type {
  SkillFileInputV1,
  SkillInstallPreviewV1,
} from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';

import { useAddDialogEdge, type CapabilityAddInputContext } from '@/components/capabilities/add/CapabilityAddModal';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { useWebFileDropZone } from '@/hooks/ui/useWebFileDropZone';
import {
  readSkillUpload,
  type SkillUploadError,
  type SkillUploadInput as UploadSource,
} from '@/sync/domains/skills/import/readSkillUpload';
import type { MountedAuthoringActionExecute } from '@/sync/ops/actions/sessionAuthoringActions';
import { t } from '@/text';
import { applyWebDirectoryInputAttributes } from '@/utils/files/applyWebDirectoryInputAttributes';
import { nativePickFiles } from '@/utils/files/nativePickFiles';
import { readWebDroppedEntries } from '@/utils/files/webDroppedEntries';

import { previewSkillInstall } from './skillInstall';
import { SkillFoundAdd, createSkillFoundDraft } from './SkillFoundAdd';

type UploadPreview =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'reading' }>
  | Readonly<{ kind: 'ready'; files: readonly SkillFileInputV1[]; items: readonly SkillInstallPreviewV1[];
      draft: ReturnType<typeof createSkillFoundDraft> }>
  | Readonly<{ kind: 'error'; message: string }>;

export function createSkillUploadDraft() {
  return createStore<{ state: UploadPreview }>(() => ({ state: { kind: 'idle' } }));
}

function describeUploadError(error: SkillUploadError): string {
  switch (error.code) {
    case 'invalid_name':
      return t('capabilities.skillAdd.upload.invalidName', {
        file: error.file,
      });
    case 'unreadable':
      return t('capabilities.skillAdd.upload.unreadable', { file: error.file });
    case 'no_skill':
      return t('capabilities.skillAdd.upload.noSkill');
  }
}

async function fileBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

/** A browser file chooser for one .zip or one folder, without a mounted DOM input. */
function chooseWebFiles(kind: 'zip' | 'folder'): Promise<readonly File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (kind === 'zip') input.accept = '.zip,application/zip';
    else applyWebDirectoryInputAttributes(input);
    input.onchange = () => resolve(Array.from(input.files ?? []));
    input.click();
  });
}

/**
 * Upload (lab sa U): a skill folder or a .zip, read here (`readSkillUpload`, nothing leaves the device until Add),
 * previewed by `skills.install { upload, dryRun }`, then the same list + details as a link: one skill opens its
 * details straight away (Where it's on, Add to library); several are a checklist. A refusal names the file.
 */
export function SkillUploadInput(
  props: Readonly<{
    ctx: CapabilityAddInputContext;
    execute: MountedAuthoringActionExecute;
    onAdded: (skillId: string) => void | Promise<void>;
    /** A detail's Add closed the dialog: the page selects that skill. */
    onSelectAdded: (skillId: string) => void | Promise<void>;
    /** Closes the dialog (the footer's Done when everything found is already held). */
    onDone: () => void;
    testID: string;
    draft?: ReturnType<typeof createSkillUploadDraft>;
  }>,
) {
  const { theme } = useUnistyles();
  const edge = useAddDialogEdge();
  const { ctx } = props;
  const [localDraft] = React.useState(createSkillUploadDraft);
  const draft = props.draft ?? localDraft;
  const state = useStore(draft, state => state.state);
  const setState = React.useCallback((state: UploadPreview) => draft.setState({ state }), [draft]);
  const [dragging, setDragging] = React.useState(false);

  const accept = React.useCallback(
    async (source: UploadSource) => {
      ctx.openDetail(null);
      const reading = { kind: 'reading' } as const;
      setState(reading);
      const read = await readSkillUpload(source);
      if (draft.getState().state !== reading) return;
      if (!read.ok) {
        setState({ kind: 'error', message: describeUploadError(read.error) });
        return;
      }
      const preview = await previewSkillInstall(props.execute, {
        kind: 'upload',
        files: [...read.files],
      });
      if (draft.getState().state !== reading) return;
      if (!preview.ok || preview.items.length === 0) {
        setState({
          kind: 'error',
          message: t('capabilities.skillAdd.upload.failed'),
        });
        return;
      }
      setState({ kind: 'ready', files: read.files, items: preview.items, draft: createSkillFoundDraft(preview.items) });
      // One skill is the details themselves: Where it's on, then Add.
      if (preview.items.length === 1) ctx.openDetail(preview.items[0]!.path);
    },
    [ctx, draft, props.execute, setState],
  );

  const acceptWebFiles = React.useCallback(
    async (
      files: readonly Readonly<{ file: File; relativePath: string }>[],
    ) => {
      if (files.length === 0) return;
      const only = files[0]!;
      if (files.length === 1 && /\.zip$/i.test(only.file.name)) {
        await accept({
          kind: 'zip',
          name: only.file.name,
          bytes: await fileBytes(only.file),
        });
        return;
      }
      await accept({
        kind: 'folder',
        files: await Promise.all(
          files.map(async (entry) => ({
            path: entry.relativePath,
            bytes: await fileBytes(entry.file),
          })),
        ),
      });
    },
    [accept],
  );

  const drop = useWebFileDropZone({
    enabled: Platform.OS === 'web',
    onFileDragActiveChange: setDragging,
    onFilesDropped: async (event) => {
      const transfer = event.dataTransfer as DataTransfer | null | undefined;
      if (!transfer) return;
      await acceptWebFiles(await readWebDroppedEntries(transfer));
    },
  });

  const choose = React.useCallback(
    async (kind: 'zip' | 'folder') => {
      if (Platform.OS === 'web') {
        const files = await chooseWebFiles(kind);
        await acceptWebFiles(
          files.map((file) => ({
            file,
            relativePath:
              (file as File & { webkitRelativePath?: string })
                .webkitRelativePath || file.name,
          })),
        );
        return;
      }
      const picked = await nativePickFiles({
        multiple: false,
        type: ['application/zip'],
      });
      const first = picked[0];
      if (!first) return;
      if (first.kind === 'web') {
        await accept({
          kind: 'zip',
          name: first.file.name,
          bytes: await fileBytes(first.file),
        });
        return;
      }
      const response = await fetch(first.uri);
      await accept({
        kind: 'zip',
        name: first.name,
        bytes: new Uint8Array(await response.arrayBuffer()),
      });
    },
    [accept, acceptWebFiles],
  );

  const choosers = (size: 'small' | 'normal') => (
    <View style={styles.chooseRow}>
      <RoundButton
        size={size}
        display="secondary"
        title={t('capabilities.skillAdd.upload.chooseZip')}
        onPress={() => void choose('zip')}
        testID={`${props.testID}.zip`}
      />
      {Platform.OS === 'web' ? (
        <RoundButton
          size={size}
          display="secondary"
          title={t('capabilities.skillAdd.upload.chooseFolder')}
          onPress={() => void choose('folder')}
          testID={`${props.testID}.folder`}
        />
      ) : null}
    </View>
  );

  const ready = state.kind === 'ready' ? state : null;
  return (
    <SkillFoundAdd
      // Another upload is a new set to choose from: its ticks, adds and details start over.
      key={ready ? String(ready.files.length) + ready.items.map((item) => item.path).join('|') : ''}
      ctx={ctx}
      draft={ready?.draft}
      execute={props.execute}
      source={ready ? { kind: 'upload', files: ready.files } : null}
      items={ready?.items ?? null}
      isCurrentInput={() => draft.getState().state === state}
      // One skill leaves nothing to choose: the heading says what the upload holds (lab `k:upload`).
      groupTitle={ready?.items.length === 1 ? t('capabilities.skillAdd.upload.found', { count: 1 }) : t('capabilities.skillAdd.link.chooseWhich')}
      // Once something is read, choosing again stands where Browse has its search.
      {...(ready ? { field: choosers('small') } : {})}
      empty={
        <View style={[styles.body, edge]}>
          <View
            {...(drop as object)}
            testID={`${props.testID}.drop`}
            style={[
              styles.drop,
              {
                borderColor: dragging
                  ? theme.colors.border.focus
                  : theme.colors.border.default,
              },
            ]}
          >
            <Icon
              name="upload"
              size={ICON_SIZE.lg}
              color={theme.colors.text.secondary}
            />
            <View style={styles.dropText}>
              <Text variant="label" emphasis="semiBold" style={{ color: theme.colors.text.primary, textAlign: 'center' }}>
                {state.kind === 'reading'
                  ? t('capabilities.skillAdd.upload.reading')
                  : t('capabilities.skillAdd.upload.dropHere')}
              </Text>
              <Text variant="body" style={{ color: theme.colors.text.secondary, textAlign: 'center' }}>
                {t('capabilities.skillAdd.upload.body')}
              </Text>
            </View>
            {choosers('small')}
          </View>
          {state.kind === 'error' ? (
            <Text
              variant="meta"
              style={{ color: theme.colors.status.error }}
              testID={`${props.testID}.error`}
            >
              {state.message}
            </Text>
          ) : null}
        </View>
      }
      factsSource={() => ({ kind: 'you' })}
      note={
        <>
          <Icon name="lock" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
          <Text variant="meta" numberOfLines={1} style={styles.noteText}>
            {t('capabilities.skillAdd.upload.neverRuns')}
          </Text>
        </>
      }
      noteWhileEmpty
      onAdded={props.onAdded}
      onSelectAdded={props.onSelectAdded}
      onDone={props.onDone}
      testID={props.testID}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    paddingTop: theme.space.s16,
    paddingBottom: theme.space.s24,
    gap: theme.space.s16,
  },
  drop: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space.s12,
    paddingVertical: theme.space.s32,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderRadius: theme.borderRadius.lg,
  },
  chooseRow: { flexDirection: 'row', gap: theme.space.s8 },
  dropText: { alignItems: 'center', gap: theme.space.s4, paddingHorizontal: theme.space.s16 },
  noteText: { flexShrink: 1, color: theme.colors.text.secondary },
}));
