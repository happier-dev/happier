import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import {
    EXTERNAL_SESSION_OPERATION_TIMELINES_V1,
    ExternalSessionOperationProgressV1Schema,
    type ExternalSessionOperationProgressV1,
} from '@happier-dev/protocol/sessions/external/operationV1';

import { ExternalImportProgressCard } from '@/components/sessions/external/progress/ExternalImportProgressCard';
import { ItemList } from '@/components/ui/lists/ItemList';

const NO_FAILURES = { total: 0, record: 0, media: 0, conversion: 0, diagnosticsTruncated: false } as const;
const noop = async () => {};

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

/** `?frame=awaiting|running|partial`: the import card's live states (W6.05), through the real card. */
const FRAMES: Record<string, ExternalSessionOperationProgressV1> = {
    awaiting: progress({ status: 'awaiting_user_resume', phase: 'staging', retryTargetPhase: 'staging' }),
    running: progress({ status: 'running', phase: 'staging' }),
    partial: progress({ status: 'awaiting_user_resume', phase: 'importing', retryTargetPhase: 'importing', imported: 96, estimate: 130 }),
};

/** Dev-only: an External Session import card in the states a live Home can't hold still. Never linked from product surfaces. */
export function ImportProgressSpecimen(props: Readonly<{ frame: string | null }>) {
    const frame = props.frame && FRAMES[props.frame] ? props.frame : 'awaiting';
    return (
        <View style={styles.page} testID={`import-progress-specimen-${frame}`}>
            <ItemList>
                <ExternalImportProgressCard
                    progress={FRAMES[frame]!}
                    observationContext="hydrated"
                    originAvailability="online"
                    onResume={noop}
                    onCancel={noop}
                    onDismiss={noop}
                />
            </ItemList>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    page: { flex: 1, backgroundColor: theme.colors.surface.base },
}));
