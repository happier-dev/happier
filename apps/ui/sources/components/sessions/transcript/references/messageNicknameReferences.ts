import { buildMentionRefV1 } from '@happier-dev/protocol/runtime/input/mentionRefV1';
import { formatInlineReferenceTokenV1, scanInlineReferenceTokensV1 } from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';
import { parseMarkdownSyntax } from '@/components/markdown/streaming/splitMarkdownIntoBlockSources';

export type InlineSessionReferenceTarget =
    | Readonly<{ kind: 'session'; sessionId: string }>
    | Readonly<{ kind: 'nativeChild'; parentSessionId: string; toolMessageRouteId: string; agentId: string }>;

export type NicknameCandidate = Readonly<{
    id: string;
    parentId: string | null;
    nickname: string | null;
    target: InlineSessionReferenceTarget;
}>;

export function selectNicknameTargets(input: Readonly<{
    currentId: string;
    candidates: readonly NicknameCandidate[];
    mentionedSessionIds: ReadonlySet<string>;
}>): ReadonlyMap<string, InlineSessionReferenceTarget> {
    const parentId = input.candidates.find(candidate => candidate.id === input.currentId)?.parentId;
    const unique = new Map<string, InlineSessionReferenceTarget>();
    const ambiguous = new Set<string>();
    for (const { id, parentId: coordinator, nickname, target } of input.candidates) {
        if (!nickname || id === input.currentId || ambiguous.has(nickname)) continue;
        const isFamily = id === parentId || coordinator === input.currentId || (parentId != null && coordinator === parentId);
        const wasMentioned = target.kind === 'session' && input.mentionedSessionIds.has(target.sessionId);
        if (!isFamily && !wasMentioned) continue;
        if (unique.has(nickname)) {
            unique.delete(nickname);
            ambiguous.add(nickname);
        } else {
            unique.set(nickname, target);
        }
    }
    return unique;
}

const excludedNodes = new Set([
    'InlineCode', 'FencedCode', 'CodeBlock', 'Link', 'Image', 'Autolink', 'URL', 'LinkReference',
    'HTMLBlock', 'HTMLTag', 'Escape',
]);

/** The generated references bind to this message's display source only. */
export function projectMessageNicknameReferences(text: string, targets: ReadonlyMap<string, InlineSessionReferenceTarget>) {
    if (targets.size === 0) return [];
    const alternatives = [...targets.keys()].sort((left, right) => right.length - left.length)
        .map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}\\p{M}_])(?:${alternatives})(?![\\p{L}\\p{N}\\p{M}_])`, 'gu');
    const matches = Array.from(text.matchAll(pattern));
    if (matches.length === 0) return [];

    const authoredTokens = scanInlineReferenceTokensV1(text);
    const excluded = authoredTokens.map(({ start, end }) => ({ start, end }));
    parseMarkdownSyntax(text).iterate({ enter(node) {
        if (!excludedNodes.has(node.name)) return;
        excluded.push({ start: node.from, end: node.to });
        return false;
    } });
    excluded.sort((left, right) => left.start - right.start);
    const existingRefs = new Set(authoredTokens.map(token => token.ref));
    const tokens = new Map<string, { ref: string; token: string }>();
    let exclusionIndex = 0;
    let nextRef = 0;
    return matches.flatMap(match => {
        const label = match[0];
        const start = match.index;
        const end = start + label.length;
        while (exclusionIndex < excluded.length && excluded[exclusionIndex]!.end <= start) exclusionIndex++;
        if (excluded[exclusionIndex] && excluded[exclusionIndex]!.start < end) return [];
        const target = targets.get(label);
        if (!target) return [];
        let entry = tokens.get(label);
        if (!entry) {
            let ref: string;
            do { ref = buildMentionRefV1('nickname', String(++nextRef)); } while (existingRefs.has(ref));
            entry = { ref, token: formatInlineReferenceTokenV1({ label, ref }) };
            tokens.set(label, entry);
        }
        return [{ ...entry, label, start, end, target }];
    });
}
