import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import {
    EXTERNAL_SESSION_OPERATION_TIMELINES_V1,
    ExternalSessionOperationProgressV1Schema,
    ExternalSessionOperationSharedPresentationV1Schema,
    type ExternalSessionOperationProgressV1,
} from '@happier-dev/protocol/sessions/external/operationV1';

import { ExternalImportProgressCard } from '@/components/sessions/external/progress/ExternalImportProgressCard';
import { ExternalSessionOperationSharedCard } from '@/components/sessions/external/progress/ExternalSessionOperationSharedCard';
import { ItemList } from '@/components/ui/lists/ItemList';

const NO_FAILURES = { total: 0, record: 0, media: 0, conversion: 0, diagnosticsTruncated: false } as const;
const noop = async () => {};
const noopSync = () => {};

function progress(input: Readonly<{
    status: ExternalSessionOperationProgressV1['status'];
    phase: ExternalSessionOperationProgressV1['phase'];
    retryTargetPhase?: ExternalSessionOperationProgressV1['retryTargetPhase'];
    imported?: number;
    estimate?: number;
}>): ExternalSessionOperationProgressV1 {
    return ExternalSessionOperationProgressV1Schema.parse({
        v: 1, operationId: 'specimen-import', revision: 2,
        request: { plan: 'materialize', targetStorageMode: 'external-linked', targetRuntimeMode: null },
        status: input.status, phase: input.phase, timeline: EXTERNAL_SESSION_OPERATION_TIMELINES_V1.materialize,
        updatedAtMs: Date.UTC(2026, 10, 17, 21, 20), priorStableStorage: { state: 'machine_only' }, currentStorageState: 'machine_only',
        checkpoint: { sourcePagesRead: input.imported ? 3 : 0, stagedItemCount: input.imported ?? 0, importedItemCount: input.imported ?? 0,
            ...(input.estimate ? { totalItemEstimate: input.estimate } : {}), requiredItemFailures: NO_FAILURES },
        fence: { kind: 'none' },
        ...(input.retryTargetPhase ? { retryTargetPhase: input.retryTargetPhase } : {}),
    });
}

function shared(input: Readonly<{ status: 'completed' | 'cancelled' | 'failed' | 'discarded' | 'running'; phase: ExternalSessionOperationProgressV1['phase'] }>) {
    return ExternalSessionOperationSharedPresentationV1Schema.parse({
        v: 1, operationId: 'specimen-import', revision: 3, kind: 'materialize', status: input.status, phase: input.phase,
    });
}

/**
 * `?frame=awaiting|running|partial`: the progress card's live states (W6.05).
 * `?frame=complete|cancelled|failed|discarded|read-failed`: the shared card a session shows once only the pushed status is known.
 */
const FRAMES: Record<string, () => React.ReactElement> = {
    awaiting: () => <ProgressFrame progress={progress({ status: 'awaiting_user_resume', phase: 'staging', retryTargetPhase: 'staging' })} />,
    running: () => <ProgressFrame progress={progress({ status: 'running', phase: 'staging' })} />,
    partial: () => <ProgressFrame progress={progress({ status: 'awaiting_user_resume', phase: 'importing', retryTargetPhase: 'importing', imported: 96, estimate: 130 })} />,
    complete: () => <ExternalSessionOperationSharedCard presentation={shared({ status: 'completed', phase: 'publishing' })} onDismiss={noopSync} />,
    cancelled: () => <ExternalSessionOperationSharedCard presentation={shared({ status: 'cancelled', phase: 'importing' })} onDismiss={noopSync} />,
    failed: () => <ExternalSessionOperationSharedCard presentation={shared({ status: 'failed', phase: 'publishing' })} />,
    discarded: () => <ExternalSessionOperationSharedCard presentation={shared({ status: 'discarded', phase: 'importing' })} onDismiss={noopSync} />,
    'read-failed': () => <ExternalSessionOperationSharedCard presentation={shared({ status: 'running', phase: 'importing' })} onCheckAgain={noopSync} />,
};

function ProgressFrame(props: Readonly<{ progress: ExternalSessionOperationProgressV1 }>) {
    return (
        <ExternalImportProgressCard
            progress={props.progress}
            observationContext="hydrated"
            originAvailability="online"
            onResume={noop}
            onCancel={noop}
            onDismiss={noop}
        />
    );
}

/** Dev-only: an External Session import card in the states a live Home can't hold still. Never linked from product surfaces. */
export function ImportProgressSpecimen(props: Readonly<{ frame: string | null }>) {
    const frame = props.frame && FRAMES[props.frame] ? props.frame : 'awaiting';
    return (
        <View style={styles.page} testID={`import-progress-specimen-${frame}`}>
            <ItemList>{FRAMES[frame]!()}</ItemList>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    page: { flex: 1, backgroundColor: theme.colors.surface.base },
}));
