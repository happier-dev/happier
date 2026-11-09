import type { PromptStackEntryV1 } from '@happier-dev/protocol/prompts/library/promptStacksV1';

import type { PromptStackEntryPresentations } from '@/components/settings/prompts/stacks/promptStackEntryPresentation';

export type ProjectContextLayer = 'shared' | 'personal';
export type ProjectMemoryAttachmentStatus = 'loading' | 'ready' | 'unavailable';

/**
 * The Project's memory document follows the Action's owner: a Source-bound Project uses the Source's,
 * even before it has memory or while it cannot be read; other Projects use the viewer's own row.
 * Project › Context and Project › Memory both read it here.
 */
export function selectProjectMemoryEntry(input: Readonly<{
  hasSource: boolean;
  sharedEntries: readonly PromptStackEntryV1[];
  personalEntries: readonly PromptStackEntryV1[];
  presentations: PromptStackEntryPresentations;
}>): Readonly<{
  entry: PromptStackEntryV1 | null;
  layer: ProjectContextLayer;
  resolved: boolean;
  attachmentStatus: ProjectMemoryAttachmentStatus;
}> {
  const layer: ProjectContextLayer = input.hasSource ? 'shared' : 'personal';
  const entries = input.hasSource ? input.sharedEntries : input.personalEntries;
  let attachmentStatus: ProjectMemoryAttachmentStatus = 'ready';
  for (const entry of entries) {
    const kind = input.presentations(entry).kind;
    if (kind === 'memory') return { entry, layer, resolved: true, attachmentStatus: 'ready' };
    if (kind !== 'unknown') continue;
    const status = input.presentations.status(entry);
    if (status === 'unavailable') attachmentStatus = 'unavailable';
    else if (attachmentStatus === 'ready') attachmentStatus = 'loading';
  }
  return { entry: null, layer, resolved: attachmentStatus === 'ready', attachmentStatus };
}
