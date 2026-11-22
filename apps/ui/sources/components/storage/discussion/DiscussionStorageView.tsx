import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Collection, type CollectionAnatomy, type CollectionRowActions } from '@happier-dev/plugin-ui';
import { formatHappierDataBytes, useHappierCollection, type CompositionSegment } from '@happier-dev/plugin-ui/presentation';

import { formatStorageDay } from '@/components/machines/storage/storageCategoryText';
import { StorageCapacityRow } from '@/components/storage/StorageCapacityRow';
import { StorageSaySection } from '@/components/storage/StorageSayLine';
import { StorageSizeCell } from '@/components/storage/StorageSizeBar';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Icon } from '@/components/ui/icons/Icon';
import type { IconName } from '@/components/ui/icons/iconRegistry.generated';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { NavigationLargeTitleProvider } from '@/components/ui/layout/navigationTitleChrome';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';
import { useDeviceType } from '@/utils/platform/responsive';

/**
 * One file in a Discussion as the storage read owner reports it, named from its loaded message. `canRemove` is the
 * server's admission (`viewerMayRemove`, owner Q2: the message's author or the Discussion's owner); the view never decides it.
 */
export type DiscussionStorageFile = Readonly<{
    key: string;
    name: string;
    /** Who sent its message; `null` while the message is not loaded on this device. */
    author: string | null;
    /** When the server stored it; `null` when it does not say. */
    at: number | null;
    bytes: number | null;
    canRemove: boolean;
}>;

const formatBytes = (bytes: number) => formatHappierDataBytes(bytes, { kind: 'storage' });

function fileIcon(name: string): IconName {
    const extension = name.split('.').pop()?.toLowerCase() ?? '';
    if (['mov', 'mp4', 'webm', 'mkv'].includes(extension)) return 'video-camera';
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic'].includes(extension)) return 'image';
    if (['md', 'txt'].includes(extension)) return 'file-text';
    return 'file';
}

function fileByline(file: DiscussionStorageFile): string {
    const date = file.at === null ? null : formatStorageDay(file.at);
    if (file.author !== null && date !== null) return t('artifacts.browser.storageView.discussion.byline', { author: file.author, date });
    return file.author ?? date ?? '';
}

type FileCommands = Readonly<{
    show: ((file: DiscussionStorageFile) => void) | null;
    download: ((file: DiscussionStorageFile) => void) | null;
    remove: (file: DiscussionStorageFile) => void;
    busy: boolean;
}>;

const FileCommandsContext = React.createContext<FileCommands | null>(null);

/**
 * The Storage view scoped to one Discussion (storage-view lab scene 5 A ★): the same sentence, capacity row and size
 * cell as the Account's view, then the Discussion's files as rows, largest first, as the read owner pages them. `pane`
 * is the Details tab's own sub-view; `page` is the phone's pushed page with its own header. The binding
 * (`DiscussionStorage`) reads the Discussion's scope and names its files; `/dev/storage` binds fixtures.
 */
export function DiscussionStorageView(props: Readonly<{
    /** The Discussion's stored bytes as the scoped read reports them; `null` while it is read. */
    totalBytes: number | null;
    /** The Account's total (the pane's share row); `null` while it is read. */
    accountTotalBytes: number | null;
    files: readonly DiscussionStorageFile[];
    presentation: 'pane' | 'page';
    /** The read failed and nothing is kept: the sentence says so and offers Try again. */
    onRetry?: (() => void) | null;
    /** Reads the owner's next page; `null` when it has none. */
    onMore?: (() => void) | null;
    loadingMore?: boolean;
    /** A removal is running: every row's Remove waits. */
    busy?: boolean;
    onShowInMessage?: ((file: DiscussionStorageFile) => void) | null;
    onDownload?: ((file: DiscussionStorageFile) => void) | null;
    onRemove: (file: DiscussionStorageFile) => void;
}>): React.ReactElement {
    usePreferredLanguage();
    const { theme } = useUnistyles();
    const phone = useDeviceType() === 'phone';
    const model = useHappierCollection<DiscussionStorageFile>({ items: props.files, keyOf: readFileKey, openKey: null, onOpenChange: noop });
    const share = React.useMemo((): readonly CompositionSegment[] => props.totalBytes === null || props.accountTotalBytes === null ? NO_SEGMENTS : [
        { id: 'discussion', label: t('artifacts.browser.storageView.kinds.shortNames.discussionAttachments'), value: props.totalBytes,
            color: theme.colors.text.secondary },
    ], [props.accountTotalBytes, props.totalBytes, theme.colors.text.secondary]);
    const anatomy = React.useMemo((): CollectionAnatomy<DiscussionStorageFile> => ({
        glyph: (file) => <Icon name={fileIcon(file.name)} size={16} color={theme.colors.text.secondary} />,
        title: (file) => file.name,
        // A file's name stays on one line, cut at its end (lab scene 5 A), never broken mid-word in the narrow pane.
        titleTruncates: true,
        byline: (file) => <Text variant="meta" numberOfLines={1} style={stylesheet.byline}>{fileByline(file)}</Text>,
        titleMeta: (file) => <StorageSizeCell label={file.name} bytes={file.bytes ?? undefined} largest={0} bar={false}
            testID={`storage:discussion:file:${file.key}:size`} unknownLabel={t('artifacts.browser.storage.sizeUnknown')} />,
        accessibilityLabel: (file) => t('artifacts.browser.storageView.items.rowLabel', { name: file.name, kind: fileByline(file),
            size: file.bytes === null ? t('artifacts.browser.storage.sizeUnknown') : formatBytes(file.bytes) }),
        testID: (file) => `storage:discussion:file:${file.key}`,
        columnTitles: { title: t('artifacts.browser.storageView.items.name') },
    }), [theme.colors.text.secondary]);
    const commands = React.useMemo((): FileCommands => ({ show: props.onShowInMessage ?? null, download: props.onDownload ?? null,
        remove: props.onRemove, busy: props.busy === true }), [props.busy, props.onDownload, props.onRemove, props.onShowInMessage]);
    const size = props.totalBytes === null ? null : formatBytes(props.totalBytes);
    return (
        // A phone's pushed page names itself with its large title under the bar's Back, as its other pages do.
        <NavigationLargeTitleProvider largeTitle={phone && props.presentation === 'page'}>
        {/* The page's header starts it on the page's edge; in the pane the list keeps its own leading space. */}
        <ItemList testID="storage:discussion" style={props.presentation === 'page' ? PAGE_LIST_STYLE : stylesheet.paneList}>
            {props.presentation === 'page' ? (
                <PageHeader title={t('artifacts.browser.storageView.title')} description={t('artifacts.browser.storageView.discussion.description')} />
            ) : null}
            {props.onRetry ? (
                <StorageSaySection testID="storage:discussion:say" lead={t('artifacts.browser.storageView.say.failed')}
                    text={t('artifacts.browser.storageView.say.failedBody')}
                    trailing={<TextLinkButton testID="storage:discussion:retry" tone="strong" label={t('common.retry')} onPress={props.onRetry} />} />
            ) : (
                <StorageSaySection testID="storage:discussion:say"
                    lead={size === null ? null : t('artifacts.browser.storageView.discussion.say', { size, count: String(props.files.length) })}
                    text={t('artifacts.browser.storageView.discussion.sayBody')} />
            )}
            {props.presentation === 'pane' && props.accountTotalBytes !== null ? (
                <ItemGroup>
                    <StorageCapacityRow testID="storage:discussion:share" title={t('artifacts.browser.storageView.discussion.ofAccount')}
                        figure={{ strong: size ?? '',
                            rest: t('artifacts.browser.storageView.discussion.ofAccountFigure', { total: formatBytes(props.accountTotalBytes) }) }}
                        label={t('artifacts.browser.storageView.account.barLabel', { size: formatBytes(props.accountTotalBytes) })}
                        total={Math.max(1, props.accountTotalBytes)} barSegments={share} legendSegments={NO_SEGMENTS} formatValue={formatBytes} />
                </ItemGroup>
            ) : null}
            {/* The files are their own sheet, a section step under the sentence or the share, as in the Account's view. */}
            <ItemGroup>
                <FileCommandsContext.Provider value={commands}>
                    <CoreCollectionScope>
                        <Collection<DiscussionStorageFile> testID="storage:discussion:files" model={model} anatomy={anatomy}
                            useRowActions={useFileRowActions} accessibilityLabel={t('artifacts.browser.storageView.discussion.description')}
                            presentation="list" detail="none" scroll="page" minListWidth={0} minDetailWidth={0} preferredListRatio={1}
                            loading={props.totalBytes === null && props.files.length === 0 && !props.onRetry} loadingRows={LOADING_ROWS} />
                    </CoreCollectionScope>
                </FileCommandsContext.Provider>
                {props.onMore ? (
                    <View style={stylesheet.foot}>
                        <TextLinkButton testID="storage:discussion:more" tone="strong" label={t('artifacts.browser.storageView.items.showMore')}
                            onPress={props.onMore} disabled={props.loadingMore === true} />
                    </View>
                ) : null}
            </ItemGroup>
        </ItemList>
        </NavigationLargeTitleProvider>
    );
}

const NO_SEGMENTS: readonly CompositionSegment[] = [];
/** Rows reserved while the Discussion's files are first read (as the Account view reserves its own). */
const LOADING_ROWS = 6;
const PAGE_LIST_STYLE = { paddingTop: 0 } as const;

const stylesheet = StyleSheet.create((theme) => ({
    byline: {
        color: theme.colors.text.secondary,
    },
    // Under the pane's own bar the view opens a section step down, where the lab's sentence stands.
    paneList: {
        paddingTop: theme.space.s20,
    },
    // As the Account view's foot: the next page's link under the rows.
    foot: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingTop: theme.space.s10,
    },
}));

function noop(): void {}

function readFileKey(file: DiscussionStorageFile): string {
    return file.key;
}

/**
 * A file's "…" (lab scene 5 A): Show in the message and Download where the binding can do them, and Remove file only
 * where the server admits it.
 */
function useFileRowActions(file: DiscussionStorageFile): CollectionRowActions {
    const commands = React.useContext(FileCommandsContext);
    if (!commands) return {};
    return {
        busy: commands.busy,
        secondaryActions: [
            ...(commands.show ? [{ id: 'show', label: t('artifacts.browser.storageView.discussion.showInMessage') }] : []),
            ...(commands.download ? [{ id: 'download', label: t('artifacts.browser.storageView.discussion.download') }] : []),
            ...(file.canRemove ? [{ id: 'remove', label: t('artifacts.browser.storageView.discussion.removeFile'), destructive: true,
                disabled: commands.busy }] : []),
        ],
        onSecondaryAction: (id) => {
            if (id === 'show') commands.show?.(file);
            else if (id === 'download') commands.download?.(file);
            else if (id === 'remove') commands.remove(file);
        },
    };
}
