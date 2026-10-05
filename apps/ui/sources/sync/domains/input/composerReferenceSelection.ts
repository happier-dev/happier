import {
    buildComposerReferenceMentionPayloadV1, buildMentionRefForKindV1, MENTION_KIND_V1,
    type ComposerReferenceCandidateV1, type PluginContributionIdentityV1,
} from '@happier-dev/protocol';
import { formatComposerSuggestionToken } from '@/components/autocomplete/composerSuggestionGrammar';
import { buildComposerSessionTokenSlug, type ComposerSessionSuggestionItem } from './suggestionSession';

/** Selection stores identity and its human-readable token; context stays send-time owned. */
export function buildComposerFileReferenceSelection(path: string, label: string) {
    return { token: formatComposerSuggestionToken('@', path), payload: {
        kind: MENTION_KIND_V1.file, ref: buildMentionRefForKindV1(MENTION_KIND_V1.file, path), label,
    } };
}

export function buildComposerSessionReferenceSelection(item: Pick<ComposerSessionSuggestionItem, 'id' | 'title'>) {
    return { token: formatComposerSuggestionToken('@', `session:${buildComposerSessionTokenSlug(item)}`), payload: {
        kind: MENTION_KIND_V1.session, ref: buildMentionRefForKindV1(MENTION_KIND_V1.session, item.id), label: item.title,
    } };
}

export function buildContributedComposerReferenceSelection(input: Readonly<{
    reference: PluginContributionIdentityV1; candidate: ComposerReferenceCandidateV1; trigger: '@' | '$' | '/';
}>) {
    return { token: formatComposerSuggestionToken(input.trigger, input.candidate.label),
        payload: buildComposerReferenceMentionPayloadV1(input) };
}
