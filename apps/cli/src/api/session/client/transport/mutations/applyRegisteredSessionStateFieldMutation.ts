import {
    clearSessionStateFieldFromMetadata,
    writeSessionStateFieldToMetadata,
} from '@happier-dev/agents/session/state/metadataWriters';
import {
    SessionRunnerRuntimeStateV1Schema,
    SessionStateUsageLimitRecoveryValueSchema,
    SessionStateWorkStateValueSchema,
} from '@happier-dev/protocol';
import { SessionRuntimeActivitySnapshotSchema } from '@happier-dev/protocol/sessions';

import type { Metadata } from '@/api/types';
import { mergeUsageLimitRecoveryFieldIntoMetadata } from '@/session/usageLimitRecoveryControls/mergeUsageLimitRecoveryFieldIntoMetadata';
import { deterministicStringify } from '@/utils/deterministicJson';
import type { RegisteredSessionStateFieldMutationV1 } from './sessionClientDurableMutationTypes';
import { hasSameUsageLimitRecoveryIdentity } from '@/session/usageLimitRecoveryControls/mergeUsageLimitRecoveryIntent';

export function resolveRegisteredSessionStateFieldMutationSettlement(
    metadata: Metadata,
    mutation: RegisteredSessionStateFieldMutationV1,
): 'applied' | 'superseded' {
    if (mutation.fieldId !== 'runtime.usageLimitRecovery' || mutation.op.kind !== 'set') return 'applied';
    const candidate = SessionStateUsageLimitRecoveryValueSchema.safeParse(mutation.op.value);
    const settled = SessionStateUsageLimitRecoveryValueSchema.safeParse(metadata.sessionUsageLimitRecoveryV1);
    return candidate.success
        && settled.success
        && hasSameUsageLimitRecoveryIdentity(candidate.data, settled.data)
        && candidate.data.status === settled.data.status
        ? 'applied'
        : 'superseded';
}

export function applyRegisteredSessionStateFieldMutationToMetadata(
    metadata: Metadata,
    mutation: RegisteredSessionStateFieldMutationV1,
): Metadata {
    if (mutation.op.kind === 'clear') {
        if (mutation.fieldId === 'runtime.usageLimitRecovery') {
            const current = metadata.sessionUsageLimitRecoveryV1;
            if (
                typeof mutation.op.previousFingerprint !== 'string'
                || deterministicStringify(current) !== mutation.op.previousFingerprint
            ) return metadata;
            return mergeUsageLimitRecoveryFieldIntoMetadata({
                latestMetadata: metadata,
                baseMetadata: metadata,
                candidateMetadata: { sessionUsageLimitRecoveryV1: null },
            }) as Metadata;
        }
        return clearSessionStateFieldFromMetadata(metadata, mutation.fieldId) as Metadata;
    }

    let value = mutation.op.value;

    if (mutation.fieldId === 'runtime.workState') {
        value = SessionStateWorkStateValueSchema.parse(value);
    }

    if (mutation.fieldId === 'runtime.activity') {
        value = SessionRuntimeActivitySnapshotSchema.parse(value);
    }

    if (mutation.fieldId === 'runtime.usageLimitRecovery') {
      value = SessionStateUsageLimitRecoveryValueSchema.parse(value);
      return mergeUsageLimitRecoveryFieldIntoMetadata({
        latestMetadata: metadata,
        baseMetadata: metadata,
        candidateMetadata: { sessionUsageLimitRecoveryV1: value },
      }) as Metadata;
    }

    if (mutation.fieldId === 'runtime.sessionRunner') {
        value = SessionRunnerRuntimeStateV1Schema.parse(value);
    }

    return writeSessionStateFieldToMetadata(metadata, mutation.fieldId, value as never) as Metadata;
}
