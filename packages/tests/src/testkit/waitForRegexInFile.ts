import { readFile } from 'node:fs/promises';

import { waitFor } from './timing';

export async function waitForRegexInFile(params: Readonly<{
  path: string;
  regex: RegExp;
  timeoutMs?: number;
  pollMs?: number;
  context?: string;
  producer?: Readonly<{
    isFinished: () => boolean;
    missingMatch: () => Promise<Error>;
  }>;
}>): Promise<RegExpMatchArray> {
  const timeoutMs = params.timeoutMs ?? 60_000;
  const pollMs = params.pollMs ?? 100;

  let lastText = '';
  let lastMatch: RegExpMatchArray | null = null;
  const regex = new RegExp(params.regex.source, params.regex.flags.replace('g', ''));

  await waitFor(
    async () => {
      // Read after observing producer completion so its final write can still match.
      const finishedProducer = params.producer?.isFinished() ? params.producer : undefined;
      lastText = await readFile(params.path, 'utf8').catch(() => '');
      lastMatch = lastText.match(regex);
      if (!lastMatch && finishedProducer) throw await finishedProducer.missingMatch();
      return Boolean(lastMatch);
    },
    {
      timeoutMs,
      intervalMs: pollMs,
      failFast: Boolean(params.producer),
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

