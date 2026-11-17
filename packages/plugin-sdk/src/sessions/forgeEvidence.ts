import {
    renderSessionInputContextPromptV1 as canonicalRender,
    readSessionInputForgeEvidenceV1 as canonicalRead,
    SessionInputForgeEvidenceV1Schema as canonicalEvidenceSchema,
} from '@happier-dev/protocol/sessions/messages/sessionInputPromptContextV1';
import type { ProtocolComposableSchema } from '../protocol/protocolFacade.js';
import type { PluginActionInputById } from '../actions/actionTypeMap.generated.js';
import {
    SessionInputForgeEvidenceAttachmentValueV1Schema as canonicalAttachmentSchema,
    readSessionInputForgeEvidenceAttachmentV1 as canonicalReadAttachment,
} from '@happier-dev/protocol/sessions/messages/sessionInputForgeEvidenceV1';
import { buildSessionInputForgeEvidenceAttachmentValueV1 as canonicalBuildAttachment }
    from '@happier-dev/protocol/sessions/messages/sessionInputForgeEvidenceAttachmentV1';
import type { ComposerAttachmentAuthorValueV1 } from '../ui/publicContract.js';
export { SESSION_INPUT_FORGE_EVIDENCE_ATTACHMENT_IDENTITY_V1 }
    from '@happier-dev/protocol/sessions/messages/sessionInputForgeEvidenceAttachmentV1';

/** Source labels describe evidence; neither text nor identity grants authority. */
export type SessionInputForgeEvidenceV1 = NonNullable<Extract<PluginActionInputById['session.message.send'], { message: string }>['forgeEvidence']>;

/** The same Protocol parser and composable projection; no SDK-owned grammar. */
export const SessionInputForgeEvidenceV1Schema: ProtocolComposableSchema<SessionInputForgeEvidenceV1> = canonicalEvidenceSchema;

export const SessionInputForgeEvidenceAttachmentValueV1Schema: ProtocolComposableSchema<{
    v: 1; forgeEvidence: SessionInputForgeEvidenceV1;
}> = canonicalAttachmentSchema;
export const readSessionInputForgeEvidenceAttachmentV1: (value: unknown) => SessionInputForgeEvidenceV1 | null = canonicalReadAttachment;
export const buildSessionInputForgeEvidenceAttachmentValueV1: (evidence: SessionInputForgeEvidenceV1) => ComposerAttachmentAuthorValueV1 = canonicalBuildAttachment;

/** Reads the same strict descriptive metadata without parsing prompt text. */
export const readSessionInputForgeEvidenceV1: (meta: unknown) => SessionInputForgeEvidenceV1 | null = canonicalRead;

/** Trusted requested work stays outside the one Protocol-owned evidence fence. */
export const renderSessionInputContextPromptV1: (input: Readonly<{
    transformedUserText: string;
    forgeEvidence?: SessionInputForgeEvidenceV1;
}>) => string = canonicalRender;
