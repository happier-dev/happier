import { source } from '@/lib/source';

export const revalidate = false;
/** `output: 'export'` emits this as a file only if it is marked static. */
export const dynamic = 'force-static';

export async function GET() {
  const lines: string[] = [];
  lines.push('# Documentation');
  lines.push('');
  for (const page of source.getPages()) {
    lines.push(`- [${page.data.title}](${page.url}): ${page.data.description}`);
  }
  return new Response(lines.join('\n'));
}
