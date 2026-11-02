import {
    renderSessionInputContextPromptV1 as canonicalRender,
    readSessionInputForgeEvidenceV1 as canonicalRead,
    SessionInputForgeEvidenceV1Schema as canonicalEvidenceSchema,
} from '@happier-dev/protocol/sessions/messages/sessionInputPromptContextV1';
import type { ProtocolComposableSchema } from '../protocol/protocolFacade.js';

/** Source labels describe evidence; neither text nor identity grants authority. */
export type SessionInputForgeEvidenceV1 = {
    v: 1;
    items: readonly {
        source: {
            kind: 'pullRequest' | 'hostedCi' | 'releaseNotes' | 'alert' | 'localTerminal' | 'entry';
            label: string;
            url?: string;
        };
        author: { kind: 'person' | 'bot' | 'process' | 'unknown'; label?: string };
        text: string;
    }[];
};

/** The same Protocol parser and composable projection; no SDK-owned grammar. */
export const SessionInputForgeEvidenceV1Schema: ProtocolComposableSchema<SessionInputForgeEvidenceV1> = canonicalEvidenceSchema;

/** Reads the same strict descriptive metadata without parsing prompt text. */
export const readSessionInputForgeEvidenceV1: (meta: unknown) => SessionInputForgeEvidenceV1 | null = canonicalRead;

/** Trusted requested work stays outside the one Protocol-owned evidence fence. */
export const renderSessionInputContextPromptV1: (input: Readonly<{
    transformedUserText: string;
    forgeEvidence?: SessionInputForgeEvidenceV1;
}>) => string = canonicalRender;
