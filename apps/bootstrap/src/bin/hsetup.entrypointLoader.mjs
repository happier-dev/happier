import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (!url.endsWith('/src/bin/hsetup.ts')) return loaded;

  const sourcePath = join(tmpdir(), 'hsetup source.ts');
  const embedded = process.env.HSETUP_ENTRYPOINT_TEST_KIND === 'embedded';
  // Model only runtime entrypoint metadata; task dispatch and execution remain real.
  return {
    ...loaded,
    source: `Object.defineProperties(import.meta, {
      main: { value: ${embedded} },
      url: { value: ${JSON.stringify(embedded ? 'file:///B:/~BUN/root/hsetup.exe' : pathToFileURL(sourcePath).href)} },
    });\n${embedded ? '' : `process.argv[1] = ${JSON.stringify(sourcePath)};\n`}${loaded.source}`,
  };
}
