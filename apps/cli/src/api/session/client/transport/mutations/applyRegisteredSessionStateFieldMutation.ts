import {
    clearSessionStateFieldFromMetadata,
    writeSessionStateFieldToMetadata,
} from '@happier-dev/agents/session/state/metadataWriters';
import { SessionRoleIdV1Schema, SessionRoleConfigurationV1Schema } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';
import { SessionRunnerRuntimeStateV1Schema } from '@happier-dev/protocol/sessions/control/sessionRunnerRuntimeV1';
import { SessionStateUsageLimitRecoveryValueSchema } from '@happier-dev/protocol/sessions/state/valueSchemas/usageLimitRecovery';
import { SessionWorkStateV1Schema as SessionStateWorkStateValueSchema } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateV1';
import { SessionRuntimeActivitySnapshotSchema } from '@happier-dev/protocol/sessions/runtime/activity/sessionRuntimeActivity';
import { SessionContextIntentV1Schema, migrateRetainedSessionWorkContextV1 } from '@happier-dev/protocol/sessions/context/sessionContextV1';
import { SessionVoicePreferenceV1Schema } from '@happier-dev/protocol/sessions/instructions/sessionVoicePreferenceV1';
import { z } from 'zod';

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
    if (mutation.fieldId === 'intent.context') value = SessionContextIntentV1Schema.parse(value);
    if (mutation.fieldId === 'intent.memoryEnabled') value = z.boolean().parse(value);
    if (mutation.fieldId === 'intent.voicePreference') value = SessionVoicePreferenceV1Schema.nullable().parse(value);

    if (mutation.fieldId === 'intent.role') {
        value = SessionRoleIdV1Schema.parse(value);
    }
    if (mutation.fieldId === 'intent.sessionRoles') {
        value = SessionRoleConfigurationV1Schema.parse(value);
        if (mutation.retainedSessionContextEntry) {
            const roles = metadata.work?.sessionRolesV1 ?? { overrides: {}, sessionRoles: {}, notes: '' };
            metadata = { ...metadata, work: migrateRetainedSessionWorkContextV1({ ...metadata.work,
                sessionRolesV1: { ...roles, memoryDocRef: mutation.retainedSessionContextEntry.ref },
            }) };
        }
    }

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
