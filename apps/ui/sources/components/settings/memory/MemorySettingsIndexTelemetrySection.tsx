import * as React from 'react';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

import type { MemoryStatusV1 } from '@happier-dev/protocol/memory/memoryStatus';
import { readMemoryStatusTelemetry } from '@/sync/domains/memory/memoryStatusTelemetry';

function count(value: number | null | undefined): number {
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

export const MemorySettingsIndexTelemetrySection = React.memo(function MemorySettingsIndexTelemetrySection(props: Readonly<{
    memoryStatus: MemoryStatusV1 | null;
}>) {
    if (!props.memoryStatus) return null;

    const telemetry = readMemoryStatusTelemetry(props.memoryStatus);
    const indexContent = telemetry.indexContent;
    const queue = telemetry.queue;
    const lastRun = telemetry.lastRun;
    const worker = telemetry.worker;

    if (!indexContent && !queue && !lastRun) return null;

    // One section for what the index holds and what it is doing; each fact appears once it is reported.
    return (
        <ItemGroup
            title={t('memorySearchSettings.indexContents.groupTitle')}
            description={queue && worker?.currentPhase ? t('memorySearchSettings.queue.workerPhase', { phase: worker.currentPhase }) : undefined}
        >
            {indexContent ? (
                <Item
                    title={t('memorySearchSettings.indexContents.title')}
                    subtitle={t('memorySearchSettings.indexContents.subtitle', {
                        sessions: count(indexContent.searchableSessionCount),
                        lightShards: count(indexContent.lightShardCount),
                        deepChunks: count(indexContent.deepChunkCount),
                    })}
                    subtitleLines={0}
                    showChevron={false}
                />
            ) : null}
            {queue ? (
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
                    subtitleLines={0}
                    showChevron={false}
                />
            ) : null}
            {lastRun ? (
                <Item
                    title={t('memorySearchSettings.lastRun.title')}
                    subtitle={t('memorySearchSettings.lastRun.subtitle', {
                        considered: count(lastRun.sessionsConsidered),
                        processed: count(lastRun.sessionsProcessed),
                        semanticRows: count(lastRun.semanticRowsFound),
                        failures: count(lastRun.failures),
                    })}
                    subtitleLines={0}
                    showChevron={false}
                />
            ) : null}
        </ItemGroup>
    );
});
