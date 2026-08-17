import type { PromptExternalLinksV1 } from '@happier-dev/protocol';

export { findPromptExternalLink, upsertPromptExternalLink } from '@happier-dev/protocol';

export function removePromptExternalLink(
  links: PromptExternalLinksV1 | null | undefined,
  linkId: string,
): PromptExternalLinksV1 {
  return {
    v: 1,
    links: (links?.links ?? []).filter((entry) => entry.id !== linkId),
  };
}
