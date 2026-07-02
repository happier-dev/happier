import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

import type { MemoryStatusV1 } from '@happier-dev/protocol';
import { readMemoryStatusTelemetry } from '@/sync/domains/memory/memoryStatusTelemetry';

function count(value: number | null | undefined): number {
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

export const MemorySettingsIndexTelemetrySection = React.memo(function MemorySettingsIndexTelemetrySection(props: Readonly<{
    memoryStatus: MemoryStatusV1 | null;
}>) {
    const { theme } = useUnistyles();
    if (!props.memoryStatus) return null;

    const telemetry = readMemoryStatusTelemetry(props.memoryStatus);
    const indexContent = telemetry.indexContent;
    const queue = telemetry.queue;
    const lastRun = telemetry.lastRun;
    const worker = telemetry.worker;

    return (
        <>
            {indexContent ? (
                <ItemGroup title={t('memorySearchSettings.indexContents.groupTitle')}>
                    <Item
                        title={t('memorySearchSettings.indexContents.title')}
                        subtitle={t('memorySearchSettings.indexContents.subtitle', {
                            sessions: count(indexContent.searchableSessionCount),
                            lightShards: count(indexContent.lightShardCount),
                            deepChunks: count(indexContent.deepChunkCount),
                        })}
                        icon={<Ionicons name="albums-outline" size={29} color={theme.colors.accent.blue} />}
                        showChevron={false}
                    />
                </ItemGroup>
            ) : null}

            {queue ? (
                <ItemGroup
                    title={t('memorySearchSettings.queue.groupTitle')}
                    footer={worker?.currentPhase ? t('memorySearchSettings.queue.workerPhase', { phase: worker.currentPhase }) : undefined}
                >
                    <Item
                        title={t('memorySearchSettings.queue.title')}
                        subtitle={t('memorySearchSettings.queue.subtitle', {
                            selected: count(queue.selectedSessionCount),
                            queued: count(queue.queuedSessionCount),
                            indexing: count(queue.indexingSessionCount),
                            indexed: count(queue.indexedSessionCount),
                            empty: count(queue.emptySessionCount),
                            failed: count(queue.failedSessionCount),
                            waiting: count(queue.waitingSessionCount),
                        })}
                        icon={<Ionicons name="file-tray-stacked-outline" size={29} color={theme.colors.accent.orange} />}
                        showChevron={false}
                    />
                </ItemGroup>
            ) : null}

            {lastRun ? (
                <ItemGroup title={t('memorySearchSettings.lastRun.groupTitle')}>
                    <Item
                        title={t('memorySearchSettings.lastRun.title')}
                        subtitle={t('memorySearchSettings.lastRun.subtitle', {
                            considered: count(lastRun.sessionsConsidered),
                            processed: count(lastRun.sessionsProcessed),
                            semanticRows: count(lastRun.semanticRowsFound),
                            failures: count(lastRun.failures),
                        })}
                        icon={<Ionicons name="pulse-outline" size={29} color={theme.colors.accent.purple} />}
                        showChevron={false}
                    />
                </ItemGroup>
            ) : null}
        </>
    );
});
