import { computeNextMetadataStringOverrideV1, SESSION_MODE_OVERRIDE_KEY } from '@happier-dev/agents';

import { cloneStringKeyedRecordToNullProto } from '@/api/session/agentStateRecords';
import { updateMetadataBestEffort } from '@/api/session/sessionWritesBestEffort';
import type { Metadata } from '@/api/types';

export function clearClaudePlanModeMetadataBestEffort(
    client: Parameters<typeof updateMetadataBestEffort>[0],
    logPrefix: string,
): void {
    const updatedAt = Date.now();
    updateMetadataBestEffort(
        client,
        (metadata): Metadata => computeNextMetadataStringOverrideV1({
            metadata: cloneStringKeyedRecordToNullProto(metadata),
            overrideKey: SESSION_MODE_OVERRIDE_KEY,
            valueKey: 'modeId',
            value: '',
            updatedAt,
        }) as unknown as Metadata,
        logPrefix,
        'exit_plan_mode_clear_session_mode_override',
    );
}
