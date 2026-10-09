import type { PromptDocArtifactRefV1 } from '@happier-dev/protocol/prompts/library/promptArtifactRefsV1';

const MEMORY_ROOT = '/settings/prompts/memory';

/**
 * The one address of a memory document's pages: its index (every key fact, then its topics), or one
 * topic when `topic` is given. "Show all", a topic row and a memory search hit all land here.
 */
export function memoryDocumentHref(
  ref: Pick<PromptDocArtifactRefV1, 'artifactId' | 'serverId'>,
  options?: Readonly<{
    serverId?: string | null;
    topic?: string;
    factId?: string;
  }>,
): string {
  const query: string[] = [];
  const serverId = (ref.serverId ?? options?.serverId ?? '').trim();
  if (serverId) query.push(`serverId=${encodeURIComponent(serverId)}`);
  if (options?.topic) query.push(`topic=${encodeURIComponent(options.topic)}`);
  if (options?.factId) query.push(`fact=${encodeURIComponent(options.factId)}`);
  const destination = `${MEMORY_ROOT}/${encodeURIComponent(ref.artifactId)}`;
  return query.length > 0 ? `${destination}?${query.join('&')}` : destination;
}
