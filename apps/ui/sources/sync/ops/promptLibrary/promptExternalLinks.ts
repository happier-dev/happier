import type { PromptExternalLinkEntryV1, PromptExternalLinksV1 } from '@happier-dev/protocol';

export function findPromptExternalLink(
  links: PromptExternalLinksV1 | null | undefined,
  params: Readonly<{
    artifactId: string;
    assetTypeId: string;
    machineId: string;
    scope: 'user' | 'project';
    workspacePath?: string | null;
  }>,
): PromptExternalLinkEntryV1 | null {
  const workspacePath = params.workspacePath ?? null;
  const matchingLinks = (links?.links ?? []).filter((entry) => (
    entry.artifactId === params.artifactId
    && entry.assetTypeId === params.assetTypeId
    && entry.machineId === params.machineId
    && entry.scope === params.scope
    && (entry.workspacePath ?? null) === workspacePath
  ));
  return matchingLinks.at(-1) ?? null;
}

export function upsertPromptExternalLink(
  links: PromptExternalLinksV1 | null | undefined,
  nextLink: PromptExternalLinkEntryV1,
): PromptExternalLinksV1 {
  const currentLinks = links?.links ?? [];
  const nextLinks = currentLinks.filter((entry) => !(
    entry.id === nextLink.id
    || (
      entry.artifactId === nextLink.artifactId
      && entry.assetTypeId === nextLink.assetTypeId
      && entry.machineId === nextLink.machineId
      && entry.scope === nextLink.scope
      && (entry.workspacePath ?? null) === (nextLink.workspacePath ?? null)
    )
  ));
  nextLinks.push(nextLink);
  return { v: 1, links: nextLinks };
}

export function removePromptExternalLink(
  links: PromptExternalLinksV1 | null | undefined,
  linkId: string,
): PromptExternalLinksV1 {
  return {
    v: 1,
    links: (links?.links ?? []).filter((entry) => entry.id !== linkId),
  };
}
