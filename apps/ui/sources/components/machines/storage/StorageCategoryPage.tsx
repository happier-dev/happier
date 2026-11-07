import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierSkeletonBlock } from '@happier-dev/plugin-ui/presentation';
import type { HappierStorageCategoryIdV1, MachineStorageCategoryListResultV1, MachineStoragePolicyV1, StorageCategoryGroupV1, StorageItemV1, TrashEntryV1 } from '@happier-dev/protocol/storage/storageV1';

import { formatMachineBytes } from '@/components/machines/vitals/machineVitalsPresentation';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useMachineResourcesPolicy } from '@/sync/domains/machines/resources/useMachineResourcesPolicy';
import { useMachineStorageCategory } from '@/sync/domains/machines/storage/useMachineStorageCategory';
import { useMachineStorageSummary } from '@/sync/domains/machines/storage/useMachineStorageSummary';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import { formatRelativeTime } from '@/utils/time/formatShortRelativeTime';

import { useMachineTabCompactLayout } from '@/components/machines/page/useMachineTabCompactLayout';
import { formatStorageDay } from './storageCategoryText';
import { describeStorageVerdict, storageCategoryTitle, storageEvidenceLabel } from './storageReasonPresentation';
import { StorageItemRow } from './StorageItemRow';
import { describeStorageFailure, type StorageCategory } from './storageViewModel';
import { useMachineTabFacts } from '@/components/machines/page/useMachineTabFacts';
import { useMachineStorageCleanup } from '@/sync/domains/machines/storage/useMachineStorageCleanup';
import { useStorageCollect, type StorageCollectController } from './StorageCollectToggle';
import { StoragePageHead, StorageSayLine } from './StoragePageHead';
import { StorageRestoreRecovery, useTrackedRestoreRefusals } from './StorageRestoreRecovery';
import { StoragePileDock } from './StoragePileDock';
import { StoragePolicyNotice } from './StoragePolicyNotice';
import { StorageReadNotice } from './StorageReadNotice';

/**
 * One kind's page (plan 40 STO-6, lab `rs` SUB): a back link, the kind's name, one sentence, one list
 * in the shared row anatomy — biggest first, each with why it stays or can go. Happier's Trash lists
 * what was moved there, hatched, with where it came from, with Put back and Empty now; other rows collect
 * into the pile.
 */
export const StorageCategoryPage = React.memo(function StorageCategoryPage(props: Readonly<{
    serverId: string;
    machineId: string;
    machineName: string;
    categoryId: HappierStorageCategoryIdV1;
    onBack: () => void;
}>) {
    const { homeDir } = useMachineTabFacts(props.serverId, props.machineId);
    const summary = useMachineStorageSummary({ machineId: props.machineId, serverId: props.serverId });
    const offline = summary.offline;
    const collect = useStorageCollect({ serverId: props.serverId, machineId: props.machineId, readOnly: offline });
    const cleanup = useMachineStorageCleanup({ machineId: props.machineId, serverId: props.serverId });
    const rowActions = React.useMemo((): CategoryRowActions => ({ collect: offline ? null : collect,
        putBack: offline ? null : (entryId: string) => { void cleanup.restore({ entryIds: [entryId] }); } }), [cleanup, collect, offline]);
    const layout = useMachineTabCompactLayout();
    const first = useMachineStorageCategory({ machineId: props.machineId, serverId: props.serverId, categoryId: props.categoryId });
    const refusals = useTrackedRestoreRefusals(cleanup.restoreOutcomes, { entries: first.page?.trashEntries ?? [] });
    const policy = useMachineResourcesPolicy({ serverId: props.serverId, machineId: props.machineId }).policy?.storage ?? null;
    const trashEmptiesAt = summary.summary?.trash.emptiesNextAt ?? null;
    const title = storageCategoryTitle(props.categoryId);
    // Later pages are their own reads (one cursor each), appended as the person asks for more.
    const [cursors, setCursors] = React.useState<readonly string[]>([]);
    React.useEffect(() => setCursors([]), [props.categoryId]);
    const largest = React.useMemo(() => readPageLargest(first.page), [first.page]);

    return (
        <View testID={`machine-storage-page-${props.categoryId}`} onLayout={layout.onLayout}>
            <StoragePageHead title={title} onBack={props.onBack}>
                {first.category ? <CategorySentence category={first.category} policy={policy} trashEmptiesAt={trashEmptiesAt} /> : null}
            </StoragePageHead>
            <StorageReadNotice issues={first.page?.incomplete} onRetry={first.retry} />
            {/* The machine groups a whole list in one answer; a paged list keeps its one biggest-first run. */}
            {first.page?.groups?.length && !first.page.nextCursor && props.categoryId !== 'trash' ? (
                <CategoryPageGroups page={first.page} largest={largest} homeDir={homeDir} compact={layout.compact} actions={rowActions} />
            ) : first.page ? (
                <ItemGroup
                    action={props.categoryId === 'trash' && !offline && (first.page.trashEntries?.length ?? 0) > 0
                        // The page is the Trash: its one Empty now, and the last move's Undo while it can still be undone
                        // (the dock leaves the Trash summary to this page).
                        ? <View style={styles.trashActions}>
                            {cleanup.receipt?.kind === 'applied' && cleanup.receipt.result.mode === 'trash' ? (
                                <TextLinkButton testID="machine-storage-trash-undo" label={t('machineStorage.pile.undoLastMove')}
                                    onPress={() => cleanup.undo()} />
                            ) : null}
                            <TextLinkButton testID="machine-storage-trash-empty-all" label={t('machineStorage.pile.emptyNow')} tone="strong"
                                onPress={async () => {
                                const entries = first.page?.trashEntries ?? [];
                                await cleanup.empty({ entryIds: entries.map(entry => entry.entryId) });
                            }} />
                        </View>
                        : undefined}>
                    {props.categoryId === 'trash' && refusals.ids.length > 0 ? (
                        <StorageRestoreRecovery placement="list" ids={refusals.ids} entries={refusals.entries} outcomes={cleanup.restoreOutcomes}
                            homeDir={homeDir} compact={layout.compact} onPutBackBeside={offline ? null : cleanup.putBackBeside} onDone={refusals.dismiss} />
                    ) : null}
                    <CategoryPageRows page={first.page} largest={largest} homeDir={homeDir} compact={layout.compact} last={cursors.length === 0} actions={rowActions} />
                    {cursors.map((cursor, index) => (
                        <CategoryPageChunk key={cursor} serverId={props.serverId} machineId={props.machineId} categoryId={props.categoryId}
                            cursor={cursor} largest={largest} homeDir={homeDir} compact={layout.compact} last={index === cursors.length - 1} actions={rowActions}
                            onMore={next => setCursors(current => current.includes(next) ? current : [...current, next])} />
                    ))}
                    {cursors.length === 0 && first.page.nextCursor ? (
                        <MoreRow onPress={() => setCursors([first.page!.nextCursor!])} />
                    ) : null}
                    {first.page.items.length === 0 && (first.page.trashEntries?.length ?? 0) === 0 ? (
                        <SurfaceStateCard testID="machine-storage-page-empty" kind="empty" size="line" title={t('machineStorage.page.empty')} />
                    ) : null}
                </ItemGroup>
            ) : first.offline ? (
                // Offline wins over a failed or unreported read: the machine is away, nothing to retry yet.
                <ItemGroup>
                    <SurfaceStateCard testID="machine-storage-page-offline" kind="unavailable" size="line"
                        title={t('machineStorage.states.offlineTitle', { machine: props.machineName })}
              reason={t('machineStorage.states.offlineReason')} />
                </ItemGroup>
            ) : first.status === 'policy_unavailable' ? (
                <StoragePolicyNotice onRetry={first.retry} />
            ) : first.status === 'error' || first.status === 'not_reported' ? (
                <ItemGroup>
                    <SurfaceStateCard testID="machine-storage-page-error" kind={first.status === 'error' ? 'error' : 'unavailable'} size="line"
                        title={first.status === 'error' ? t('machineStorage.page.error') : t('machineStorage.states.notReported', { machine: props.machineName })}
                        {...describeStorageFailure(first.failure)}
                        action={first.status === 'error' && !first.offline ? { label: t('machineStorage.tryAgain'), onPress: first.retry, testID: 'machine-storage-page-retry' } : undefined} />
                </ItemGroup>
            ) : (
                <CategoryPageLoading />
            )}
            {summary.summary && summary.status !== 'policy_unavailable' ? (
                <StoragePileDock serverId={props.serverId} machineId={props.machineId} machineName={props.machineName}
                    summary={summary.summary} compact={layout.compact} readOnly={offline}
                    omitTrashReceipt={props.categoryId === 'trash'} />
            ) : null}
        </View>
    );
});

type CategoryRowActions = Readonly<{ collect: StorageCollectController | null; putBack: ((entryId: string) => void) | null }>;

/** "17.6 GB of caches. Tools download or rebuild all of it when they need it. 17.0 GB can go." */
function CategorySentence(props: Readonly<{ category: StorageCategory; policy: MachineStoragePolicyV1 | null; trashEmptiesAt: number | null }>) {
    const { category, policy } = props;
    const size = formatMachineBytes(category.size.allocatedBytes, 'storage');
    const lead = t(`machineStorage.page.lead.${category.categoryId}`, { size, count: category.count });
    const about = ((): string => {
        switch (category.categoryId) {
            case 'logs': {
                const days = policy?.logRetentionDays;
                return days === null ? t('machineStorage.page.about.logsKeptForever') : t('machineStorage.page.about.logsKeptDays', { days: days ?? 30 });
            }
            case 'trash':
                return props.trashEmptiesAt !== null ? t('machineStorage.page.about.trashOn', { date: formatStorageDay(props.trashEmptiesAt) })
                    : policy?.trashEmptyAfterDays === null ? t('machineStorage.page.about.trashNever')
                        : t('machineStorage.page.about.trashAfter', { days: policy?.trashEmptyAfterDays ?? 7 });
            default:
                return t(`machineStorage.page.about.${category.categoryId}`);
        }
    })();
    const canGo = category.categoryId !== 'trash' && category.canGoBytes > 0
        ? t('machineStorage.page.canGo', { amount: formatMachineBytes(category.canGoBytes, 'storage') }) : null;
    return (
        <StorageSayLine testID="machine-storage-page-sentence" lead={lead} text={[about, canGo].filter(Boolean).join(' ')} />
    );
}

function readPageLargest(page: MachineStorageCategoryListResultV1 | null): number {
    if (!page) return 0;
    let largest = 0;
    for (const item of page.items) largest = Math.max(largest, item.size.allocatedBytes);
    for (const entry of page.trashEntries ?? []) largest = Math.max(largest, entry.size.allocatedBytes);
    return largest;
}

function describeItemEvidence(item: StorageItemV1, homeDir: string | undefined): string {
    const parts = item.evidence.length > 0 ? item.evidence.map(storageEvidenceLabel) : [formatPathRelativeToHome(item.path, homeDir)];
    if (item.lastUsedAt !== undefined) parts.push(t('machineStorage.page.used', { when: formatRelativeTime(item.lastUsedAt) }));
    else if (item.lastChangedAt !== undefined) parts.push(t('machineStorage.page.changed', { when: formatRelativeTime(item.lastChangedAt) }));
    return parts.join(' · ');
}

function describeTrashEvidence(entry: TrashEntryV1, homeDir: string | undefined): string {
    return formatPathRelativeToHome(entry.originalPath, homeDir);
}

/** One read's rows, biggest first (the daemon pages in its own order; a page is sorted where it lands). */
function CategoryPageRows(props: Readonly<{
    page: MachineStorageCategoryListResultV1;
    largest: number;
    homeDir: string | undefined;
    compact: boolean;
    last: boolean;
    actions: CategoryRowActions;
}>) {
    const { collect, putBack } = props.actions;
    const entries = React.useMemo(() => (props.page.trashEntries ?? []).slice().sort((a, b) => b.size.allocatedBytes - a.size.allocatedBytes), [props.page.trashEntries]);
    const items = React.useMemo(() => props.page.items.slice().sort((a, b) => b.size.allocatedBytes - a.size.allocatedBytes), [props.page.items]);
    // Happier's Trash lists what was moved there; its catalogue items are the same bytes.
    const showEntries = props.page.categoryId === 'trash' && entries.length > 0;
    const count = showEntries ? entries.length : items.length;
    return (
        <>
            {showEntries ? entries.map((entry, index) => (
                <StorageItemRow key={entry.entryId} testID={`machine-storage-trash-${entry.entryId}`} title={entry.title}
                    evidence={describeTrashEvidence(entry, props.homeDir)} bytes={entry.size.allocatedBytes} atLeast={entry.size.atLeast}
                    largest={props.largest} hatched chip={null} compact={props.compact} showDivider={!props.last || index < count - 1}
                    trailing={putBack && entry.restorable ? <TextLinkButton testID={`machine-storage-trash-${entry.entryId}-put-back`} label={t('machineStorage.page.putBack')}
                        tone="strong" onPress={() => putBack(entry.entryId)} /> : undefined} />
            )) : items.map((item, index) => (
                <StorageItemRow key={item.itemId} testID={`machine-storage-item-${item.itemId}`} title={item.title}
                    evidence={describeItemEvidence(item, props.homeDir)} bytes={item.size.allocatedBytes} atLeast={item.size.atLeast}
                    largest={props.largest} hatched={props.page.categoryId === 'trash'} chip={describeStorageVerdict(item)}
                    compact={props.compact} showDivider={!props.last || index < count - 1}
                    freesBytes={item.size.freesBytes}
                    collect={collect && props.page.categoryId !== 'trash' ? collect.rowProps(item, items) : undefined} />
            ))}
        </>
    );
}

function storageCategoryGroupTitle(group: StorageCategoryGroupV1): string {
    switch (group.id) {
        case 'stopped': return group.olderThanDays ? t('machineStorage.page.groups.stopped', { days: group.olderThanDays }) : t('machineStorage.page.groups.stoppedAny');
        case 'old': return group.olderThanDays ? t('machineStorage.page.groups.old', { days: group.olderThanDays }) : t('machineStorage.page.groups.oldAny');
        case 'recent': return t('machineStorage.page.groups.recent');
    }
}

/**
 * A kind's page grouped the way the machine groups it (lab SUB: "Stopped over 30 days ago" / "Recent or
 * running"), in the machine's order, each biggest first; anything the machine left ungrouped reads last.
 * Shift ranges stay inside one group.
 */
function CategoryPageGroups(props: Readonly<{
    page: MachineStorageCategoryListResultV1;
    largest: number;
    homeDir: string | undefined;
    compact: boolean;
    actions: CategoryRowActions;
}>) {
    const language = usePreferredLanguage();
    const sections = React.useMemo(() => {
        const byId = new Map(props.page.items.map(item => [item.itemId, item]));
        const grouped = new Set<string>();
        const bySize = (a: StorageItemV1, b: StorageItemV1) => b.size.allocatedBytes - a.size.allocatedBytes;
        const result = (props.page.groups ?? []).map((group): { key: string; title: string; items: StorageItemV1[] } => {
            const items = group.itemIds.flatMap(id => { const item = byId.get(id); if (item) grouped.add(id); return item ? [item] : []; }).sort(bySize);
            return { key: group.id, title: storageCategoryGroupTitle(group), items };
        });
        const rest = props.page.items.filter(item => !grouped.has(item.itemId)).sort(bySize);
        if (rest.length) result.push({ key: 'other', title: t('machineStorage.page.groups.other'), items: rest });
        return result.filter(section => section.items.length > 0);
    }, [language, props.page.groups, props.page.items]);
    const { collect } = props.actions;
    return (
        <>
            {sections.map(section => (
                <ItemGroup key={section.key} title={section.title}>
                    {section.items.map((item, index) => (
                        <StorageItemRow key={item.itemId} testID={`machine-storage-item-${item.itemId}`} title={item.title}
                            evidence={describeItemEvidence(item, props.homeDir)} bytes={item.size.allocatedBytes} atLeast={item.size.atLeast}
                            largest={props.largest} hatched={false} chip={describeStorageVerdict(item)} compact={props.compact}
                            showDivider={index < section.items.length - 1} freesBytes={item.size.freesBytes}
                            collect={collect ? collect.rowProps(item, section.items) : undefined} />
                    ))}
                </ItemGroup>
            ))}
        </>
    );
}

function CategoryPageChunk(props: Readonly<{
    serverId: string;
    machineId: string;
    categoryId: HappierStorageCategoryIdV1;
    cursor: string;
    largest: number;
    homeDir: string | undefined;
    compact: boolean;
    last: boolean;
    actions: CategoryRowActions;
    onMore: (cursor: string) => void;
}>) {
    const chunk = useMachineStorageCategory({ machineId: props.machineId, serverId: props.serverId, categoryId: props.categoryId, cursor: props.cursor });
    if (!chunk.page) {
        return chunk.status === 'error'
            ? <SurfaceStateCard kind="error" size="line" title={t('machineStorage.page.error')} {...describeStorageFailure(chunk.failure)} action={{ label: t('machineStorage.tryAgain'), onPress: chunk.retry }} />
            : <SurfaceStateCard kind="loading" size="line" title={t('machineStorage.page.loading')} />;
    }
    const next = chunk.page.nextCursor;
    return (
        <>
            <CategoryPageRows page={chunk.page} largest={props.largest} homeDir={props.homeDir} compact={props.compact} last={props.last} actions={props.actions} />
            {props.last && next ? <MoreRow onPress={() => props.onMore(next)} /> : null}
        </>
    );
}

function MoreRow(props: Readonly<{ onPress: () => void }>) {
    return (
        <View style={styles.more}>
            <TextLinkButton testID="machine-storage-page-more" label={t('machineStorage.page.more')} onPress={props.onPress} tone="strong" />
        </View>
    );
}

function CategoryPageLoading() {
    const { theme } = useUnistyles();
    const color = theme.colors.surface.skeleton;
    return (
        <ItemGroup>
            <View testID="machine-storage-page-loading" accessibilityLabel={t('machineStorage.page.loading')} accessibilityRole="progressbar">
                {Array.from({ length: 4 }, (_, index) => (
                    <View key={index} style={styles.skeletonRow}>
                        <HappierSkeletonBlock color={color} width="40%" height={14} />
                        <HappierSkeletonBlock color={color} width="60%" height={12} />
                    </View>
                ))}
            </View>
        </ItemGroup>
    );
}

const styles = StyleSheet.create(() => ({
    trashActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 16,
    },
    more: {
        paddingHorizontal: 16,
        paddingVertical: 12,
    },
    skeletonRow: {
        gap: 8,
        paddingHorizontal: 16,
        paddingVertical: 14,
    },
}));
