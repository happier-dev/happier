import {
    clearSessionStateFieldFromMetadata,
    writeSessionStateFieldToMetadata,
} from '@happier-dev/agents/session/state/metadataWriters';
import {
    SessionRunnerRuntimeStateV1Schema,
    SessionStateUsageLimitRecoveryValueSchema,
    SessionStateWorkStateValueSchema,
} from '@happier-dev/protocol';
import { SessionRuntimeActivityProjectionV1Schema } from '@happier-dev/protocol/sessions';

import type { Metadata } from '@/api/types';
import type { RegisteredSessionStateFieldMutationV1 } from './sessionClientDurableMutationTypes';

export function applyRegisteredSessionStateFieldMutationToMetadata(
    metadata: Metadata,
    mutation: RegisteredSessionStateFieldMutationV1,
): Metadata {
    if (mutation.op.kind === 'clear') {
        return clearSessionStateFieldFromMetadata(metadata, mutation.fieldId) as Metadata;
    }

    let value = mutation.op.value;

    if (mutation.fieldId === 'runtime.workState') {
        value = SessionStateWorkStateValueSchema.parse(value);
    }

    if (mutation.fieldId === 'runtime.activity') {
        value = SessionRuntimeActivityProjectionV1Schema.parse(value);
    }

    if (mutation.fieldId === 'runtime.usageLimitRecovery') {
        value = SessionStateUsageLimitRecoveryValueSchema.parse(value);
    }

    if (mutation.fieldId === 'runtime.sessionRunner') {
        value = SessionRunnerRuntimeStateV1Schema.parse(value);
    }

    return writeSessionStateFieldToMetadata(metadata, mutation.fieldId, value as never) as Metadata;
}
