import type {
    AgentExternalSessionTranscriptRawRecord as ProtocolAgentExternalSessionTranscriptRawRecord,
    ExternalSessionUserProjection as ProtocolExternalSessionUserProjection,
} from '@happier-dev/protocol';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
    AgentExternalSessionTranscriptRawRecord,
    AgentExternalSessionsInvocationBounds,
    AgentExternalSessionUserProjection,
} from './sessions/external/index.js';
import {
    AgentExternalSessionTranscriptRawRecordSchema,
    compareExternalSessionCandidatePrecedence,
    createAgentExternalSessionsProducerOverflowFailure,
    getAgentExternalSessionsInvocationFailure,
    HAPPIER_BASE_SYSTEM_PROMPT_ATTACHMENTS_V1,
    HAPPIER_BASE_SYSTEM_PROMPT_LINKED_WORKSPACE_FILES_V1,
    HAPPIER_BASE_SYSTEM_PROMPT_OPTIONS_V1,
    HAPPIER_BASE_SYSTEM_PROMPT_SESSION_TITLE_INITIAL_V1,
    isAgentExternalSessionsResultWithinByteBudget,
    resolveExternalSessionCandidateIdentityKey,
} from './sessions/external/index.js';
import * as externalSessions from './sessions/external/index.js';
import {
    compareExternalSessionCandidatePrecedence as compareCanonicalExternalSessionCandidatePrecedence,
    resolveExternalSessionCandidateIdentityKey as resolveCanonicalExternalSessionCandidateIdentityKey,
} from './sessions/external/candidatePrecedence.js';
import {
    AgentExternalSessionTranscriptRawRecordSchema as ProtocolAgentExternalSessionTranscriptRawRecordSchema,
    HAPPIER_BASE_SYSTEM_PROMPT_ATTACHMENTS_V1 as ProtocolHappierBaseSystemPromptAttachmentsV1,
    HAPPIER_BASE_SYSTEM_PROMPT_LINKED_WORKSPACE_FILES_V1 as ProtocolHappierBaseSystemPromptLinkedWorkspaceFilesV1,
    HAPPIER_BASE_SYSTEM_PROMPT_OPTIONS_V1 as ProtocolHappierBaseSystemPromptOptionsV1,
    HAPPIER_BASE_SYSTEM_PROMPT_SESSION_TITLE_INITIAL_V1 as ProtocolHappierBaseSystemPromptSessionTitleInitialV1,
} from '@happier-dev/protocol';

describe('External Sessions public producer projections', () => {
    it('publishes one terminal and producer-overflow classifier for bounded contribution calls', () => {
        const liveInvocation = (overrides: Partial<AgentExternalSessionsInvocationBounds> = {}) => ({
            signal: new AbortController().signal,
            deadlineAtMs: Date.now() + 1_000,
            maxSerializedBytes: 1_024,
            ...overrides,
        });
        const cancelled = new AbortController();
        cancelled.abort();

        expect(getAgentExternalSessionsInvocationFailure(liveInvocation({
            signal: cancelled.signal,
            deadlineAtMs: 0,
            maxSerializedBytes: 0,
        }))).toMatchObject({ ok: false, code: 'cancelled' });
        expect(getAgentExternalSessionsInvocationFailure(liveInvocation({
            deadlineAtMs: 0,
            maxSerializedBytes: 0,
        }))).toMatchObject({ ok: false, code: 'timeout', retryable: true });
        expect(getAgentExternalSessionsInvocationFailure(liveInvocation({
            maxSerializedBytes: 0,
        }))).toMatchObject({ ok: false, code: 'invalid_request' });
        expect(getAgentExternalSessionsInvocationFailure(liveInvocation({
            maxSerializedBytes: Number.NaN,
        }))).toMatchObject({ ok: false, code: 'invalid_request' });
        expect(getAgentExternalSessionsInvocationFailure(liveInvocation())).toBeNull();

        const result = { ok: true as const, value: { text: 'é' } };
        const exactBytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
        expect(isAgentExternalSessionsResultWithinByteBudget(result, exactBytes)).toBe(true);
        expect(isAgentExternalSessionsResultWithinByteBudget(result, exactBytes - 1)).toBe(false);
        expect(createAgentExternalSessionsProducerOverflowFailure('one item cannot fit')).toEqual({
            ok: false,
            code: 'agent_error',
            message: 'one item cannot fit',
            retryable: false,
        });
    });

    it('preserves the strict canonical Protocol raw-record identity', () => {
        expectTypeOf<AgentExternalSessionTranscriptRawRecord>()
            .toEqualTypeOf<ProtocolAgentExternalSessionTranscriptRawRecord>();
        expect(AgentExternalSessionTranscriptRawRecordSchema)
            .toBe(ProtocolAgentExternalSessionTranscriptRawRecordSchema);
    });

    it('projects the canonical user-projection type without publishing a schema facade', () => {
        expectTypeOf<AgentExternalSessionUserProjection>()
            .toEqualTypeOf<ProtocolExternalSessionUserProjection>();
        expect(externalSessions).not.toHaveProperty('AgentExternalSessionUserProjectionSchema');
    });

    it('publishes the exact candidate-precedence values without a second implementation', () => {
        expect(resolveExternalSessionCandidateIdentityKey)
            .toBe(resolveCanonicalExternalSessionCandidateIdentityKey);
        expect(compareExternalSessionCandidatePrecedence)
            .toBe(compareCanonicalExternalSessionCandidatePrecedence);
    });

    it('projects only the exact base-system-prompt sentinels external-session title readers need', () => {
        expect(HAPPIER_BASE_SYSTEM_PROMPT_SESSION_TITLE_INITIAL_V1)
            .toBe(ProtocolHappierBaseSystemPromptSessionTitleInitialV1);
        expect(HAPPIER_BASE_SYSTEM_PROMPT_OPTIONS_V1)
            .toBe(ProtocolHappierBaseSystemPromptOptionsV1);
        expect(HAPPIER_BASE_SYSTEM_PROMPT_ATTACHMENTS_V1)
            .toBe(ProtocolHappierBaseSystemPromptAttachmentsV1);
        expect(HAPPIER_BASE_SYSTEM_PROMPT_LINKED_WORKSPACE_FILES_V1)
            .toBe(ProtocolHappierBaseSystemPromptLinkedWorkspaceFilesV1);
        expect(externalSessions).not.toHaveProperty('HAPPIER_BASE_SYSTEM_PROMPT_V1');
        expect(externalSessions).not.toHaveProperty('buildHappierBaseSystemPromptV1');
    });
});
