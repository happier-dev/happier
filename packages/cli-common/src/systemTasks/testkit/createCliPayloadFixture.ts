import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeBashSingleQuote } from '../../ssh/shellQuote.js';

/** Executable process boundary; installation beneath it uses the real owner. */
export async function createCliPayloadFixture(): Promise<Readonly<{
  payloadRoot: string;
  cleanup: () => Promise<void>;
}>> {
  const rootDir = await mkdtemp(join(tmpdir(), 'happier-remote-first-party-fixture-'));
  const payloadRoot = join(rootDir, 'payload-root');
  await mkdir(payloadRoot, { recursive: true });
  const installer = [
    `import { installVersionedPayload } from ${JSON.stringify(new URL('../../firstPartyRuntime/installVersionedPayload.ts', import.meta.url).href)};`,
    'const args = process.argv.slice(1);',
    'const value = (flag) => args[args.indexOf(flag) + 1];',
    'await installVersionedPayload({ componentId: value("--component"), channel: value("--channel"), versionId: value("--version"), payloadRoot: value("--payload-root"), processEnv: process.env, selectAsDefaultReleaseChannel: true });',
  ].join('\n');
  const loader = fileURLToPath(new URL('../../../../../node_modules/tsx/dist/loader.mjs', import.meta.url));
  await writeFile(join(payloadRoot, 'happier'), `#!/bin/sh\nif [ "$#" -eq 0 ]; then exit 0; fi\nexec ${safeBashSingleQuote(process.execPath)} --conditions=happier-source --import ${safeBashSingleQuote(loader)} --input-type=module -e ${safeBashSingleQuote(installer)} "$@"\n`, 'utf8');
  return { payloadRoot, cleanup: async () => { await rm(rootDir, { recursive: true, force: true }); } };
}
