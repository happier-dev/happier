// Entry for `hstack stack qa-bed`: seed one fresh QA bed Account on a running server.
// Usage: node scripts/runTsxEntrypoint.mjs src/testkit/qaBed/seedQaBedMain.ts \
//   --server-url <url> --profile <profile> --key-file <path>
// The recovery key goes only to --key-file (mode 0600). Stdout carries one JSON
// line with counts and Session ids; it never contains a key or token.
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { isQaBedProfileName, QA_BED_PROFILES, QaBedSeedError, seedQaBedAccount } from './seedQaBedAccount';

async function main() {
  const { values } = parseArgs({
    options: {
      'server-url': { type: 'string' },
      profile: { type: 'string', default: 'small' },
      'key-file': { type: 'string' },
    },
  });
  const serverUrl = values['server-url'];
  const keyFile = values['key-file'];
  const profile = values.profile ?? 'small';
  if (!serverUrl || !keyFile || !isQaBedProfileName(profile)) {
    process.stderr.write(`Usage: seedQaBedMain.ts --server-url <url> --profile <${Object.keys(QA_BED_PROFILES).join('|')}> --key-file <path>\n`);
    process.exitCode = 2;
    return;
  }

  try {
    const startedAt = Date.now();
    const seeded = await seedQaBedAccount({ baseUrl: serverUrl.replace(/\/+$/, ''), profile });
    await mkdir(dirname(keyFile), { recursive: true, mode: 0o700 });
    await writeFile(keyFile, `${seeded.recoveryKey}\n`, { mode: 0o600 });
    await chmod(keyFile, 0o600);
    process.stdout.write(`${JSON.stringify({ kind: 'qa_bed_seed', ok: true, durationMs: Date.now() - startedAt, ...seeded.summary })}\n`);
  } catch (error) {
    const failure = error instanceof QaBedSeedError ? { phase: error.phase, httpStatus: error.httpStatus } : { phase: 'seed' };
    process.stdout.write(`${JSON.stringify({ kind: 'qa_bed_seed', ok: false, ...failure })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
