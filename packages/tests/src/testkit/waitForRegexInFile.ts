import { readFile } from 'node:fs/promises';

import { waitFor } from './timing';

export async function waitForRegexInFile(params: Readonly<{
  path: string;
  regex: RegExp;
  timeoutMs?: number;
  pollMs?: number;
  context?: string;
}>): Promise<RegExpMatchArray> {
  const timeoutMs = params.timeoutMs ?? 60_000;
  const pollMs = params.pollMs ?? 100;

  let lastText = '';
  let lastMatch: RegExpMatchArray | null = null;
  const regex = new RegExp(params.regex.source, params.regex.flags.replace('g', ''));

  await waitFor(
    async () => {
      lastText = await readFile(params.path, 'utf8').catch(() => '');
      lastMatch = lastText.match(regex);
      return Boolean(lastMatch);
    },
    {
      timeoutMs,
      intervalMs: pollMs,
      context: params.context ?? `regex match in file ${params.path}`,
    },
  );

  if (!lastMatch) {
    const tail = lastText.slice(Math.max(0, lastText.length - 4_000));
    throw new Error(
      [
        'Timed out waiting for regex in file',
        `path=${params.path}`,
        `regex=/${params.regex.source}/${params.regex.flags}`,
        `tail=${JSON.stringify(tail)}`,
      ].join(' | '),
    );
  }

  return lastMatch;
}

