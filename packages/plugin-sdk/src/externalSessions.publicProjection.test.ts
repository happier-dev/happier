import type {
    AgentExternalSessionTranscriptRawRecord as ProtocolAgentExternalSessionTranscriptRawRecord,
    ExternalSessionUserProjection as ProtocolExternalSessionUserProjection,
} from '@happier-dev/protocol';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
    AgentExternalSessionTranscriptRawRecord,
    AgentExternalSessionUserProjection,
} from './sessions/external/index.js';
import {
    AgentExternalSessionTranscriptRawRecordSchema,
    compareExternalSessionCandidatePrecedence,
    HAPPIER_BASE_SYSTEM_PROMPT_ATTACHMENTS_V1,
    HAPPIER_BASE_SYSTEM_PROMPT_LINKED_WORKSPACE_FILES_V1,
    HAPPIER_BASE_SYSTEM_PROMPT_OPTIONS_V1,
    HAPPIER_BASE_SYSTEM_PROMPT_SESSION_TITLE_INITIAL_V1,
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
