import type { DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';

export type DirectTranscriptPageV1 = Readonly<{
  items: readonly DirectTranscriptRawMessageV1[];
  nextCursor: string | null;
  hasMore: boolean;
  truncated?: boolean;
}>;

export async function importDirectSessionTranscript(params: Readonly<{
  loadPage: (cursor: string | null) => Promise<DirectTranscriptPageV1>;
  onItem: (item: DirectTranscriptRawMessageV1) => Promise<void> | void;
  maxPages?: number;
}>): Promise<Readonly<{ importedCount: number; truncated: boolean }>> {
  const maxPages = Math.max(1, Math.trunc(params.maxPages ?? 10_000));
  let importedCount = 0;
  let truncated = false;
  let cursor: string | null = null;

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const page = await params.loadPage(cursor);
    truncated = truncated || page.truncated === true;

    for (const item of page.items) {
      await params.onItem(item);
      importedCount += 1;
    }

    if (!page.hasMore || !page.nextCursor) break;
    cursor = page.nextCursor;
  }

  return { importedCount, truncated };
}
