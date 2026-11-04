import * as React from 'react';
import { Platform, View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type {
  BrowserInteractionStateV1,
  BrowserUploadFileV1,
} from '@happier-dev/protocol';
import { formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation';

import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { GlassPanel } from '@/components/ui/glass/GlassPanel';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon } from '@/components/ui/icons/Icon';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { ModalCardFrame } from '@/modal/components/card/ModalCardFrame';
import {
  ModalChoiceRow,
  type ModalChoice,
} from '@/modal/components/card/ModalChoiceRow';
import { ModalBoundaryProvider } from '@/modal/context/ModalBoundaryContext';
import { nativePickFiles } from '@/utils/files/nativePickFiles';
import { getPreferredLanguage, t } from '@/text';

import type { BrowserViewerInputEvent } from '../adapters/BrowserStreamedTarget';
import { BrowserFrameStatusCapsule } from '../frame/BrowserFrameStatusCapsule';

type Dialog = NonNullable<BrowserInteractionStateV1['dialog']>;
type FileChooser = NonNullable<BrowserInteractionStateV1['fileChooser']>;
type Download = BrowserInteractionStateV1['downloads'][number];

const stylesheet = StyleSheet.create((theme) => ({
  // The page-modal layer: like a browser's own tab-modal dialog, it dims this page only, never the app,
  // so the Session, its other tabs and the presence capsule stay usable while the page waits.
  scrim: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 4,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.space.s16,
    backgroundColor: theme.colors.overlay.scrimSoft,
  },
  cardContent: {
    paddingHorizontal: theme.space.s20,
    paddingTop: theme.space.s20,
    paddingBottom: theme.space.s16,
    gap: theme.space.s6,
  },
  cardTitle: {
    color: theme.colors.text.primary,
  },
  cardBody: {
    color: theme.colors.text.primary,
  },
  cardNote: {
    color: theme.colors.text.secondary,
    marginTop: theme.space.s6,
  },
  promptField: {
    alignSelf: 'stretch',
    marginTop: theme.space.s10,
  },
  // Downloads stand at the page's top-right corner on the floating material, where a browser puts
  // them; on a narrow page they span its width under the top edge.
  downloadsDock: {
    position: 'absolute',
    top: theme.space.s12,
    right: theme.space.s12,
    zIndex: 3,
    width: 320,
    maxWidth: '100%',
  },
  downloadsDockNarrow: {
    left: theme.space.s12,
    width: 'auto',
  },
  downloadsList: {
    paddingVertical: theme.space.s4,
  },
  downloadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s10,
    minHeight: 44,
    paddingLeft: theme.space.s12,
    paddingRight: theme.space.s6,
  },
  downloadText: {
    flex: 1,
    minWidth: 0,
    gap: theme.space.s2,
  },
  downloadName: {
    color: theme.colors.text.primary,
  },
  downloadMeta: {
    color: theme.colors.text.secondary,
    fontVariant: ['tabular-nums'],
  },
  progressTrack: {
    height: 2,
    marginTop: theme.space.s4,
    borderRadius: 1,
    overflow: 'hidden',
    backgroundColor: theme.colors.border.default,
  },
  progressFill: {
    height: 2,
    backgroundColor: theme.colors.text.primary,
  },
}));

/** Below this page width the downloads span the page instead of standing in its corner. */
const NARROW_PAGE_PX = 480;

export type BrowserPageInteractionsProps = Readonly<{
  interaction: BrowserInteractionStateV1 | null | undefined;
  /** The page's host ("localhost:5173") for "localhost:5173 says"; null words it as "This page". */
  pageHost: string | null;
  /**
   * Answers the page as this viewer. Absent while another viewer has control: the dialog and the
   * file request still show, and say who answers them.
   */
  answer?: (event: BrowserViewerInputEvent) => void;
  /** Saves a finished download to this device; absent where this viewer cannot fetch its bytes. */
  onSaveDownload?: (download: Download) => void;
  testID: string;
}>;

/**
 * What the page asks of the person watching it (lab `browser`, human input): its JavaScript dialog,
 * its file request and its downloads, as the daemon projects them on this view's stream. A dialog
 * or a file request is page-modal — one card over the dimmed page, built from the app's dialog card
 * — because the page cannot go on until someone answers. Downloads never block: they stand in the
 * page's corner until dismissed. A capability the browser could not set up says so once, in the
 * page's status capsule.
 */
export function BrowserPageInteractions(
  props: BrowserPageInteractionsProps,
): React.ReactElement | null {
  const [size, setSize] = React.useState<Readonly<{
    width: number;
    height: number;
  }> | null>(null);
  const onLayout = React.useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize((current) =>
      current && current.width === width && current.height === height
        ? current
        : { width, height },
    );
  }, []);
  const interaction = props.interaction ?? null;
  const host = props.pageHost ?? t('browserPresence.interaction.thisPage');
  const unavailable = interaction?.unavailable;
  const unavailableText = unavailable?.fileChooser
    ? t('browserPresence.interaction.chooserUnavailable')
    : unavailable?.download
      ? t('browserPresence.interaction.downloadUnavailable')
      : null;
  return (
    <View
      style={StyleSheet.absoluteFill}
      pointerEvents="box-none"
      onLayout={onLayout}
      testID={props.testID}
    >
      <BrowserDownloads
        downloads={interaction?.downloads ?? []}
        narrow={size !== null && size.width < NARROW_PAGE_PX}
        onSave={props.onSaveDownload}
        testID={`${props.testID}-downloads`}
      />
      <BrowserFrameStatusCapsule
        visible={unavailableText !== null}
        text={unavailableText ?? ''}
        testID={`${props.testID}-unavailable`}
      />
      {interaction?.dialog ? (
        <PageModal size={size}>
          <BrowserPageDialog
            key={interaction.dialog.dialogId}
            dialog={interaction.dialog}
            host={host}
            answer={props.answer}
            testID={`${props.testID}-dialog`}
          />
        </PageModal>
      ) : interaction?.fileChooser ? (
        <PageModal size={size}>
          <BrowserFileRequest
            key={interaction.fileChooser.chooserId}
            chooser={interaction.fileChooser}
            host={host}
            answer={props.answer}
            testID={`${props.testID}-chooser`}
          />
        </PageModal>
      ) : null}
    </View>
  );
}

/** The dimmed page and its one card, sized to the page (the dialog card reads this bound, not the window). */
function PageModal(
  props: Readonly<{
    size: Readonly<{ width: number; height: number }> | null;
    children: React.ReactNode;
  }>,
) {
  const viewport = React.useMemo(
    () =>
      props.size
        ? { width: props.size.width, height: props.size.height, bottomInset: 0 }
        : null,
    [props.size],
  );
  return (
    <View style={stylesheet.scrim}>
      <ModalBoundaryProvider viewport={viewport}>
        {props.children}
      </ModalBoundaryProvider>
    </View>
  );
}

const CARD_DIMENSIONS = { size: 'dialog', viewportMargin: 16 } as const;

function BrowserPageDialog(
  props: Readonly<{
    dialog: Dialog;
    host: string;
    answer?: (event: BrowserViewerInputEvent) => void;
    testID: string;
  }>,
) {
  const { dialog, answer } = props;
  const [promptText, setPromptText] = React.useState(
    dialog.defaultPrompt ?? '',
  );
  const respond = (accept: boolean) =>
    answer?.({
      kind: 'dialog',
      dialogId: dialog.dialogId,
      accept,
      ...(accept && dialog.type === 'prompt' ? { promptText } : {}),
    });
  const leaving = dialog.type === 'beforeunload';
  const title = leaving
    ? t('browserPresence.interaction.leaveTitle')
    : t('browserPresence.interaction.says', { host: props.host });
  const body = leaving
    ? t('browserPresence.interaction.leaveBody')
    : dialog.message;
  const choices: ModalChoice[] =
    dialog.type === 'alert'
      ? [
          {
            text: t('common.ok'),
            testID: `${props.testID}-ok`,
            onPress: () => respond(true),
          },
        ]
      : leaving
        ? [
            {
              text: t('browserPresence.interaction.stay'),
              role: 'cancel',
              testID: `${props.testID}-cancel`,
              onPress: () => respond(false),
            },
            {
              text: t('browserPresence.interaction.leave'),
              testID: `${props.testID}-ok`,
              onPress: () => respond(true),
            },
          ]
        : [
            {
              text: t('common.cancel'),
              role: 'cancel',
              testID: `${props.testID}-cancel`,
              onPress: () => respond(false),
            },
            // A prompt's typed value is read on press-in, before a blur can race it (as the app's prompt does).
            {
              text: t('common.ok'),
              testID: `${props.testID}-ok`,
              onPressIn:
                dialog.type === 'prompt' ? () => respond(true) : undefined,
              onPress: () => respond(true),
            },
          ];
  return (
    <ModalCardFrame
      header="none"
      title={title}
      dimensions={CARD_DIMENSIONS}
      testID={props.testID}
    >
      <View style={stylesheet.cardContent} accessibilityRole="alert">
        <Text variant="heading" style={stylesheet.cardTitle} numberOfLines={2}>
          {title}
        </Text>
        {body ? (
          <Text variant="body" style={stylesheet.cardBody}>
            {body}
          </Text>
        ) : null}
        {dialog.type === 'prompt' ? (
          <FieldTextInput
            testID={`${props.testID}-input`}
            style={stylesheet.promptField}
            accessibilityLabel={dialog.message || title}
            value={promptText}
            onChangeText={setPromptText}
            editable={answer !== undefined}
            autoCapitalize="none"
            autoFocus={Platform.OS === 'web' && answer !== undefined}
            onSubmitEditing={() => respond(true)}
            returnKeyType="done"
          />
        ) : null}
        {answer ? null : (
          <Text variant="meta" style={stylesheet.cardNote}>
            {t('browserPresence.interaction.otherViewer')}
          </Text>
        )}
      </View>
      {answer ? <ModalChoiceRow choices={choices} /> : null}
    </ModalCardFrame>
  );
}

async function readPickedFiles(
  multiple: boolean,
): Promise<BrowserUploadFileV1[]> {
  const picked = await nativePickFiles({ multiple });
  const files: BrowserUploadFileV1[] = [];
  for (const entry of picked) {
    if (entry.kind === 'web') {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(entry.file);
      });
      files.push({
        name: entry.file.name,
        dataBase64: dataUrl.slice(dataUrl.indexOf(',') + 1),
      });
    } else {
      const { File } = await import('expo-file-system');
      files.push({ name: entry.name, dataBase64: await new File(entry.uri).base64() });
    }
  }
  return files;
}

function BrowserFileRequest(
  props: Readonly<{
    chooser: FileChooser;
    host: string;
    answer?: (event: BrowserViewerInputEvent) => void;
    testID: string;
  }>,
) {
  const { chooser, answer } = props;
  const [busy, setBusy] = React.useState(false);
  const send = (files: BrowserUploadFileV1[]) =>
    answer?.({ kind: 'fileChooser', chooserId: chooser.chooserId, files });
  // The system picker must open inside the press, so the card's own button is the user gesture.
  const choose = () => {
    if (busy) return;
    setBusy(true);
    void readPickedFiles(chooser.multiple)
      .then((files) => {
        if (files.length > 0) send(files);
      })
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };
  const title = chooser.multiple
    ? t('browserPresence.interaction.chooserTitleMultiple', {
        host: props.host,
      })
    : t('browserPresence.interaction.chooserTitle', { host: props.host });
  return (
    <ModalCardFrame
      header="none"
      title={title}
      dimensions={CARD_DIMENSIONS}
      testID={props.testID}
    >
      <View style={stylesheet.cardContent}>
        <Text variant="heading" style={stylesheet.cardTitle} numberOfLines={2}>
          {title}
        </Text>
        <Text variant="body" style={stylesheet.cardBody}>
          {t('browserPresence.interaction.chooserBody')}
        </Text>
        {answer ? null : (
          <Text variant="meta" style={stylesheet.cardNote}>
            {t('browserPresence.interaction.otherViewer')}
          </Text>
        )}
      </View>
      {answer ? (
        <ModalChoiceRow
          choices={[
            {
              text: t('common.cancel'),
              role: 'cancel',
              testID: `${props.testID}-cancel`,
              onPress: () => send([]),
            },
            {
              text: chooser.multiple
                ? t('browserPresence.interaction.chooseFiles')
                : t('browserPresence.interaction.chooseFile'),
              testID: `${props.testID}-choose`,
              onPress: choose,
            },
          ]}
        />
      ) : null}
    </ModalCardFrame>
  );
}

/** A file size as the app says it everywhere ("6.1 MB"): storage units in the viewer's locale. */
function formatBytes(bytes: number): string {
    return formatHappierDataBytes(bytes, { kind: 'storage', locale: getPreferredLanguage() });
}

function downloadMeta(download: Download): string {
  if (download.state === 'canceled')
    return t('browserPresence.interaction.downloadCanceled');
  if (download.state === 'completed')
    return formatBytes(download.totalBytes || download.receivedBytes);
  return download.totalBytes > 0
    ? t('browserPresence.interaction.downloadProgress', {
        received: formatBytes(download.receivedBytes),
        total: formatBytes(download.totalBytes),
      })
    : formatBytes(download.receivedBytes);
}

function BrowserDownloads(
  props: Readonly<{
    downloads: readonly Download[];
    narrow: boolean;
    onSave?: (download: Download) => void;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  // Dismissal is this viewer's: it hides the downloads it has seen, and a new one brings the list back.
  const [dismissed, setDismissed] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const shown = props.downloads.filter(
    (download) => !dismissed.has(download.downloadId),
  );
  if (shown.length === 0) return null;
  return (
    <View
      style={[
        stylesheet.downloadsDock,
        props.narrow ? stylesheet.downloadsDockNarrow : null,
      ]}
      pointerEvents="box-none"
    >
      <GlassPanel shadowLevel={2} innerShadow={false} testID={props.testID}>
        <View
          style={stylesheet.downloadsList}
          accessibilityRole="list"
          accessibilityLabel={t('browserPresence.interaction.downloadsA11y')}
        >
          {shown.map((download, index) => (
            <View
              key={download.downloadId}
              style={stylesheet.downloadRow}
              testID={`${props.testID}-${download.downloadId}`}
            >
              <Icon
                name="file-arrow-down"
                size={18}
                color={theme.colors.text.secondary}
              />
              <View style={stylesheet.downloadText}>
                <Text
                  variant="label"
                  style={stylesheet.downloadName}
                  numberOfLines={1}
                  ellipsizeMode="middle"
                >
                  {download.name}
                </Text>
                <Text
                  variant="meta"
                  style={stylesheet.downloadMeta}
                  numberOfLines={1}
                >
                  {downloadMeta(download)}
                </Text>
                {download.state === 'inProgress' && download.totalBytes > 0 ? (
                  <View style={stylesheet.progressTrack}>
                    <View
                      style={[
                        stylesheet.progressFill,
                        {
                          width: `${Math.min(100, (download.receivedBytes / download.totalBytes) * 100)}%`,
                        },
                      ]}
                    />
                  </View>
                ) : null}
              </View>
              {download.state === 'completed' && props.onSave ? (
                <RoundButton
                  size="small"
                  display="secondary"
                  title={t('browserPresence.interaction.save')}
                  onPress={() => props.onSave?.(download)}
                  testID={`${props.testID}-${download.downloadId}-save`}
                />
              ) : null}
              {index === 0 ? (
                <IconButton
                  variant="plain"
                  iconName="x"
                  size={28}
                  accessibilityLabel={t(
                    'browserPresence.interaction.dismissDownloads',
                  )}
                  onPress={() =>
                    setDismissed(
                      new Set(props.downloads.map((entry) => entry.downloadId)),
                    )
                  }
                  testID={`${props.testID}-dismiss`}
                />
              ) : (
                <View style={{ width: 28 }} />
              )}
            </View>
          ))}
        </View>
      </GlassPanel>
    </View>
  );
}
