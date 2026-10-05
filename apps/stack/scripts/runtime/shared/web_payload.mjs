import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export async function assertWebArtifactPayload({ payloadDir, entrypoint }) {
  const html = await readFile(join(payloadDir, entrypoint), 'utf8');
  if (!html.trim()) throw new Error('[build] web export is incomplete: empty entrypoint.');
  const baseUrl = new URL(entrypoint.replaceAll('\\', '/'), 'https://artifact.invalid/');
  for (const [tag] of html.matchAll(/<(?:script|link|img|source|video|audio|iframe)\b[^>]*>/gi)) {
    const attributes = new Map([...tag.matchAll(/\b([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)]
      .map((match) => [match[1].toLowerCase(), match[2] ?? match[3] ?? match[4]]));
    const isLink = /^<link\b/i.test(tag);
    if (isLink && !/(?:^|\s)(?:stylesheet|preload|modulepreload|icon)(?:\s|$)/i.test(attributes.get('rel') ?? '')) continue;
    const reference = String(attributes.get(isLink ? 'href' : 'src') ?? '').trim().replaceAll('&amp;', '&');
    if (!reference || reference.startsWith('#') || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(reference)) continue;
    const url = new URL(reference, baseUrl);
    const path = resolve(payloadDir, `.${decodeURIComponent(url.pathname)}`);
    const relativePath = relative(resolve(payloadDir), path);
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath) || !(await stat(path)).isFile()) {
      throw new Error(`[build] web export is incomplete: invalid asset ${reference}.`);
    }
  }
}
