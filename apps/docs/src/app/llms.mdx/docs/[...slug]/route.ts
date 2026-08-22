import { getLLMText, source } from '@/lib/source';
import { notFound } from 'next/navigation';

export const revalidate = false;
/** `output: 'export'` emits this as a file only if it is marked static. */
export const dynamic = 'force-static';

const EXT = '.mdx';

/**
 * The Markdown source of a docs page, as a real file on disk.
 *
 * THE LAST SLUG SEGMENT CARRIES `.mdx`, AND IT HAS TO. A static export writes
 * one file per rendered route, so `/llms.mdx/docs/agents` becomes the FILE
 * `out/llms.mdx/docs/agents` — while `/llms.mdx/docs/agents/claude` needs
 * `agents` to be a DIRECTORY. No filesystem holds both, and the export dies
 * with EISDIR at the copy step. Sixteen sections here are both a page and a
 * parent, so this is structural rather than a case or two to special-case.
 *
 * Appending the extension separates the two namespaces completely:
 * `agents.mdx` is a file, `agents/` is a directory, and nothing collides at
 * any depth.
 *
 * It also makes the on-disk name match the public URL. Readers and agents
 * reach this through the `*.mdx` rewrite in worker/index.ts — `/agents.mdx` —
 * so the Worker now maps that straight onto `/llms.mdx/docs/agents.mdx`
 * without having to add or strip anything.
 */
export async function GET(_req: Request, { params }: RouteContext<'/llms.mdx/docs/[...slug]'>) {
  const { slug } = await params;

  // Undo what generateStaticParams added, so the lookup sees the real slug.
  const lookup = [...slug];
  const last = lookup.at(-1);
  if (last?.endsWith(EXT)) lookup[lookup.length - 1] = last.slice(0, -EXT.length);

  const page = source.getPage(lookup);
  if (!page) notFound();

  return new Response(await getLLMText(page), {
    headers: {
      'Content-Type': 'text/markdown',
    },
  });
}

/**
 * REQUIRED catch-all, not optional, and that too is an export constraint.
 *
 * As `[[...slug]]` this route also rendered the empty-slug case,
 * `/llms.mdx/docs`, which collides with the directory holding every real page
 * for exactly the reason described above. Nothing is lost by dropping it: the
 * empty slug corresponds to the URL `/.mdx`, which nobody requests.
 */
export function generateStaticParams() {
  return source
    .generateParams()
    .filter((entry) => (entry.slug?.length ?? 0) > 0)
    .map((entry) => ({
      ...entry,
      slug: entry.slug.map((seg, i) => (i === entry.slug.length - 1 ? `${seg}${EXT}` : seg)),
    }));
}
