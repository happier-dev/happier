import type { PromptStackEntryV1 } from '@happier-dev/protocol';

import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { t } from '@/text';

/** Where an entry's text goes, in the words every Context list uses. */
export function promptStackPlacementLabel(placement: PromptStackEntryV1['placement']): string {
    return placement === 'skill_instructions' ? t('promptLibrary.stackPlacementSkill')
        : placement === 'composer_insert' ? t('promptLibrary.stackPlacementComposer') : t('promptLibrary.stackPlacementSystem');
}

export function promptStackEntryTitle(entry: PromptStackEntryV1, artifactsById: ReadonlyMap<string, DecryptedArtifact>): string {
    const artifact = artifactsById.get(entry.ref.artifactId);
    const title = typeof artifact?.header?.title === 'string' ? artifact.header.title : artifact?.title;
    return title || t('promptLibrary.untitledPrompt');
}

/** A context entry is memory when its document is a `memory_doc.v1` Artifact (never by entry id). */
export function isMemoryStackEntry(entry: PromptStackEntryV1, artifactsById: ReadonlyMap<string, DecryptedArtifact>): boolean {
    return entry.ref.kind === 'doc' && artifactsById.get(entry.ref.artifactId)?.header?.kind === 'memory_doc.v1';
}

/** The library editor of an entry's document. */
export function promptStackEntryHref(entry: PromptStackEntryV1): string {
    return entry.ref.kind === 'bundle'
        ? `/settings/prompts/skills/${encodeURIComponent(entry.ref.artifactId)}`
        : `/settings/prompts/docs/${encodeURIComponent(entry.ref.artifactId)}`;
}

/**
 * "How much to load" is offered in words and stored as the entry's `maxChars`. Six characters a word
 * (five letters and the space after them, the usual English average); nothing else in the product
 * converts words to characters, so this is the one place the ratio lives.
 */
export const CONTEXT_LOAD_CHARS_PER_WORD = 6;
export const CONTEXT_LOAD_WORD_OPTIONS = [500, 1500, 4000] as const;
