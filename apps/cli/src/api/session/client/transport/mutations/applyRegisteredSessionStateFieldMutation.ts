import {
    clearSessionStateFieldFromMetadata,
    writeSessionStateFieldToMetadata,
} from '@happier-dev/agents/session/state/metadataWriters';
import {
    SessionStateUsageLimitRecoveryValueSchema,
    SessionStateWorkStateValueSchema,
} from '@happier-dev/protocol';

import type { Metadata } from '@/api/types';
import type { RegisteredSessionStateFieldMutationV1 } from './sessionClientDurableMutationTypes';

export function applyRegisteredSessionStateFieldMutationToMetadata(
    metadata: Metadata,
    mutation: RegisteredSessionStateFieldMutationV1,
): Metadata {
    if (mutation.op.kind === 'clear') {
        return clearSessionStateFieldFromMetadata(metadata, mutation.fieldId) as Metadata;
    }

    if (mutation.fieldId === 'runtime.workState') {
        const parsed = SessionStateWorkStateValueSchema.parse(mutation.op.value);
        return writeSessionStateFieldToMetadata(metadata, 'runtime.workState', parsed) as Metadata;
    }

    if (mutation.fieldId === 'runtime.usageLimitRecovery') {
        const parsed = SessionStateUsageLimitRecoveryValueSchema.parse(mutation.op.value);
        return writeSessionStateFieldToMetadata(metadata, 'runtime.usageLimitRecovery', parsed) as Metadata;
    }

    return metadata;
}
