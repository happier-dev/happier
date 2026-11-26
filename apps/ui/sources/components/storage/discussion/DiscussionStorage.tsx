import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation';
import type { StorageInventoryInputV1, StorageInventoryItemV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';

import { useLocalSearchParams, useRouter, type Href } from '@/components/appShell/workspace/destinationRoute';
import { useStorageInventoryRead, type StorageInventoryRead } from '@/components/artifacts/artifactActionsClient';
import { buildDiscussionRouteHref } from '@/components/discussions/discussionRoutes';
import { useRemoveDiscussionFile } from '@/components/storage/useRemoveDiscussionFile';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { readRegisteredDiscussionRepository } from '@/sync/ops/discussions/discussionRepositoryRegistry';
import type { DiscussionRepository } from '@/sync/ops/discussions/discussionRepository';
import { useDiscussionComposerSnapshot } from '@/sync/ops/discussions/useDiscussionRepositorySnapshot';
import { t } from '@/text';

import { DiscussionStorageView, type DiscussionStorageFile } from './DiscussionStorageView';
import {
    discussionStorageMessageKey,
    readDiscussionAttachmentName,
    useDiscussionStorageAuthorLabel,
    useDiscussionStorageExactMessages,
    type DiscussionStorageExactMessages,
    type DiscussionStorageMessage,
} from './discussionStorageMessages';

/**
 * The open Discussion as its Details tab (or the phone page) knows it: names come from its loaded messages, and the
 * page's exact message read names files on messages it does not hold. `messages` is `null` when this device has not
 * loaded the Discussion.
 */
export type DiscussionStorageSource = Readonly<{
    scope: ServerAccountScope;
    discussionId: string;
    ownerAccountId: string | null;
    title: string | null;
    messages: readonly DiscussionStorageMessage[] | null;
    authorLabel: (message: DiscussionStorageMessage) => string;
}>;

const formatBytes = (bytes: number) => formatHappierDataBytes(bytes, { kind: 'storage' });

/** The Discussion's scoped storage read (`storage.inventory.read`, scope `discussion`): one Action read per page. */
export function useDiscussionStorageRead(
    scope: ServerAccountScope, discussionId: string, view: 'items' | 'summary' = 'items',
): StorageInventoryRead {
    const selection = React.useMemo(() => ({
        home: scope, followStorageRevision: false,
        scope: { kind: 'discussion', discussionId } satisfies NonNullable<StorageInventoryInputV1['scope']>,
        kinds: view === 'summary' ? [] : undefined,
    }), [discussionId, scope, view]);
    return useStorageInventoryRead(selection);
}

/**
 * The read owner's files, in its order, each named by the message its triple points at (a folder's file by its path in
 * the folder): the Discussion's loaded message, or the page's exact read of it. A file whose message is still being
 * read shimmers; one the Home left out keeps the kind's own label and says it is not available to the viewer; one whose
 * read failed keeps the kind's label while the view offers Retry. Size, date and admission are always the server's.
 */
export function projectDiscussionStorageFiles(items: readonly StorageInventoryItemV1[], messages: readonly DiscussionStorageMessage[] | null,
    authorLabel: DiscussionStorageSource['authorLabel'], exact: DiscussionStorageExactMessages): readonly DiscussionStorageFile[] {
    const byId = new Map((messages ?? []).map((message) => [message.id, message]));
    return items.flatMap((item) => {
        if (item.location.kind !== 'discussion') return [];
        const key = discussionStorageMessageKey(item.location.discussionId, item.location.messageId);
        const message = byId.get(item.location.messageId) ?? exact.messages.get(key)?.message;
        const blobId = item.location.attachmentId ?? item.id;
        return [{
            key: item.id,
            name: (message ? readDiscussionAttachmentName(message, blobId) : null) ?? t('artifacts.browser.storageView.items.titles.discussionAttachments'),
            pending: message === undefined && exact.reading && !exact.messages.has(key) && !exact.failed.has(key),
            unavailable: message === undefined && exact.messages.get(key) === null,
            author: message ? authorLabel(message) : null,
            at: item.createdAt,
            bytes: item.storedSizeBytes,
            canRemove: item.viewerMayRemove === true,
        }];
    });
}

/** Details' "Storage · 86.4 MB" row (lab scene 5 A): the scoped read's own total, never a sum of its files. */
export function DiscussionStorageRow(props: Readonly<{ read: StorageInventoryRead; onPress: () => void }>): React.ReactElement {
    const { theme } = useUnistyles();
    const total = props.read.inventory?.totalBytes;
    return (
        <ItemGroup>
            <Item testID="discussion-details-storage"
                title={total === undefined ? t('artifacts.browser.storageView.title')
                    : t('artifacts.browser.storageView.discussion.row', { size: formatBytes(total) })}
                icon={<Icon name="hard-drives" color={theme.colors.text.secondary} />}
                onPress={props.onPress} />
        </ItemGroup>
    );
}

/** The Discussion's Storage in the Details pane: its scoped read (shared with the row) and the Account's total for the share. */
export function DiscussionStoragePane(props: Readonly<{ source: DiscussionStorageSource; read: StorageInventoryRead }>): React.ReactElement {
    if (props.source.ownerAccountId !== props.source.scope.accountId) {
        // A participant sees only the files on messages they can read; their pane says whose total it is.
        return <DiscussionStorage source={props.source} read={props.read} presentation="pane" participant
            accountTotalBytes={null} onChanged={props.read.retry} />;
    }
    return <OwnedDiscussionStoragePane {...props} />;
}

function OwnedDiscussionStoragePane(props: Readonly<{ source: DiscussionStorageSource; read: StorageInventoryRead }>): React.ReactElement {
    const accountSelection = React.useMemo(() => ({ home: props.source.scope, followStorageRevision: false, kinds: [] }), [props.source.scope]);
    const account = useStorageInventoryRead(accountSelection);
    const retryAccount = account.retry;
    const retryScope = props.read.retry;
    const changed = React.useCallback(() => { retryScope(); retryAccount(); }, [retryAccount, retryScope]);
    return <DiscussionStorage source={props.source} read={props.read} presentation="pane"
        accountTotalBytes={account.inventory?.totalBytes ?? null} onChanged={changed} />;
}

/** The view bound to the Discussion: its files named from loaded messages, Show in the message, and Remove where admitted. */
function DiscussionStorage(props: Readonly<{
    source: DiscussionStorageSource;
    read: StorageInventoryRead;
    presentation: 'pane' | 'page';
    participant?: boolean;
    accountTotalBytes: number | null;
    onChanged: () => void;
}>): React.ReactElement {
    const router = useRouter();
    const { source, read } = props;
    // The loaded thread names the files on its messages; one exact read per page names the rest (older messages
    // outside its window, or every file when this device has not loaded the Discussion).
    const held = React.useMemo(() => new Set((source.messages ?? []).map((message) =>
        discussionStorageMessageKey(source.discussionId, message.id))), [source.discussionId, source.messages]);
    const exact = useDiscussionStorageExactMessages(source.scope, read.items, held);
    const files = React.useMemo(() => projectDiscussionStorageFiles(read.items, source.messages, source.authorLabel, exact),
        [exact, read.items, source.authorLabel, source.messages]);
    const title = source.title ?? readExactTitle(exact, source.discussionId);
    const removal = useRemoveDiscussionFile(source.scope, props.onChanged);
    const run = removal.run;
    const remove = React.useCallback((file: DiscussionStorageFile) => {
        const item = read.items.find((candidate) => candidate.id === file.key);
        if (!item || item.location.kind !== 'discussion' || !file.canRemove) return;
        const messageId = item.location.messageId;
        const author = (source.messages?.find((message) => message.id === messageId)
            ?? exact.messages.get(discussionStorageMessageKey(item.location.discussionId, messageId))?.message)?.authorAccountId;
        void run({ discussionId: item.location.discussionId, messageId, blobId: item.location.attachmentId ?? item.id,
            name: file.name, bytes: file.bytes ?? 0, discussionTitle: title, own: author === source.scope.accountId });
    }, [exact.messages, read.items, run, source.messages, source.scope.accountId, title]);
    const showInMessage = React.useCallback((file: DiscussionStorageFile) => {
        const item = read.items.find((candidate) => candidate.id === file.key);
        if (!item || item.location.kind !== 'discussion') return;
        router.push(buildDiscussionRouteHref({ target: { kind: 'discussion', address: { serverId: source.scope.serverId },
            discussionId: item.location.discussionId, messageId: item.location.messageId } }) as Href);
    }, [read.items, router, source.scope.serverId]);
    const failed = read.status === 'failed';
    return (
        <DiscussionStorageView totalBytes={read.inventory?.totalBytes ?? null} accountTotalBytes={props.accountTotalBytes}
            fileCount={read.inventory?.kinds?.discussionAttachments?.itemCount ?? null}
            files={files} presentation={props.presentation} discussionTitle={title} participant={props.participant === true} onRetry={failed ? read.retry : null} onMore={read.more}
            failure={read.failure} loadingMore={read.loadingMore} moreFailure={read.moreFailure} namesFailure={exact.failure} onRetryNames={exact.retry}
            busy={removal.busy} onShowInMessage={showInMessage} onRemove={remove} />
    );
}

/** The Discussion's title as the page's exact read opened it, for a Discussion this device has not loaded. */
function readExactTitle(exact: DiscussionStorageExactMessages, discussionId: string): string | null {
    for (const [key, entry] of exact.messages) {
        if (entry?.discussionTitle && key.startsWith(discussionStorageMessageKey(discussionId, ''))) return entry.discussionTitle;
    }
    return null;
}

function readParam(value: string | string[] | undefined): string | null {
    const first = Array.isArray(value) ? value[0] : value;
    return first ? first : null;
}

const NO_SERVER_IDS: readonly string[] = [];

/**
 * The phone's Storage page for one Discussion (lab scene 5 A, phone), pushed from the Discussion's "…" or its Details
 * surface: the same view, scoped by the route's Home and Discussion, one scoped read per page.
 */
export function DiscussionStorageRoute(): React.ReactElement {
    const params = useLocalSearchParams() as Record<string, string | string[] | undefined>;
    const serverId = readParam(params.serverId);
    const discussionId = readParam(params.discussionId);
    const serverIds = React.useMemo(() => serverId ? [serverId] : NO_SERVER_IDS, [serverId]);
    const bindings = useServerCredentialAccountScopeBindings(serverIds);
    const scope = [...bindings.values()][0]?.scope ?? null;
    if (!scope || !discussionId) {
        return <DiscussionStorageView presentation="page" totalBytes={null} accountTotalBytes={null} files={[]} onRemove={noop} />;
    }
    const repository = readRegisteredDiscussionRepository(scope, { serverId: scope.serverId });
    return repository
        ? <DiscussionStorageLoadedPage scope={scope} discussionId={discussionId} repository={repository} />
        : <DiscussionStoragePage scope={scope} discussionId={discussionId} title={null} messages={null} />;
}

/** A thread this device already holds names the files; a Discussion it has not loaded is named by the page's exact read. */
function DiscussionStorageLoadedPage(props: Readonly<{ scope: ServerAccountScope; discussionId: string; repository: DiscussionRepository }>) {
    const thread = useDiscussionComposerSnapshot(props.repository, props.discussionId).thread;
    return <DiscussionStoragePage scope={props.scope} discussionId={props.discussionId} title={thread?.summary?.title ?? null}
        messages={thread?.messages ?? null} />;
}

function DiscussionStoragePage(props: Readonly<{
    scope: ServerAccountScope;
    discussionId: string;
    title: string | null;
    messages: readonly DiscussionStorageMessage[] | null;
}>) {
    const read = useDiscussionStorageRead(props.scope, props.discussionId);
    const authorLabel = useDiscussionStorageAuthorLabel(props.scope);
    const source = React.useMemo((): DiscussionStorageSource => ({ scope: props.scope, discussionId: props.discussionId,
        ownerAccountId: null, title: props.title, messages: props.messages, authorLabel }),
    [authorLabel, props.discussionId, props.messages, props.scope, props.title]);
    return <DiscussionStorage source={source} read={read} presentation="page" accountTotalBytes={null} onChanged={read.retry} />;
}

function noop(): void {}
