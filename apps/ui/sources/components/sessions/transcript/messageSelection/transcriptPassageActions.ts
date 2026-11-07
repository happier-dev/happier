import type { SessionMessageRefV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageRefV1';
import type { ComposerRefV1 } from '@happier-dev/protocol/plugins/ui/composerRef';
import { buildAskSelectionQuote } from '@/components/ui/code/selection/askSelectionModel';
import { captureActiveServerAccountScopeLifetime, selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { appendMountedComposerDraft } from '@/sync/ops/actions/appendMountedComposerDraft';
import { addMountedTranscriptAnnotation } from '@/sync/ops/actions/addMountedTranscriptAnnotation';

export type CapturedTranscriptPassage = Readonly<{
    quote: string;
    source: SessionMessageRefV1;
    destination: Extract<ComposerRefV1, { kind: 'session' }>;
    lifetime: ServerAccountScopeLifetime;
}>;

export function captureTranscriptPassage(quote: string, source: SessionMessageRefV1,
    destination: Extract<ComposerRefV1, { kind: 'session' }>): CapturedTranscriptPassage | null {
    const lifetime = captureActiveServerAccountScopeLifetime();
    return quote.trim() && lifetime && selectActiveServerAccountScopeForServer(lifetime.scope, source.session.serverId)
        ? { quote, source, destination, lifetime } : null;
}

export async function quoteTranscriptPassage(passage: CapturedTranscriptPassage): Promise<boolean> {
    if (!passage.lifetime.isCurrent()) return false;
    return appendMountedComposerDraft({ scope: passage.lifetime.scope,
        ref: passage.destination,
        text: buildAskSelectionQuote({ text: passage.quote }) });
}

export async function annotateTranscriptPassage(passage: CapturedTranscriptPassage, note: string): Promise<boolean> {
    if (!passage.lifetime.isCurrent()) return false;
    return addMountedTranscriptAnnotation({ scope: passage.lifetime.scope,
        ref: passage.destination,
        annotation: { quote: passage.quote, note, source: passage.source } });
}
