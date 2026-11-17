import { createRequire } from 'node:module';
import { safeBashSingleQuote } from '@happier-dev/cli-common/ssh';

/** Fake only the installed executable's unrelated commands; payload promotion stays real. */
export function guestCliExecutable(body: string): string {
  const installer = [
    'import { installVersionedPayload } from "@happier-dev/cli-common/firstPartyRuntime";',
    'const args = process.argv.slice(1); const value = flag => args[args.indexOf(flag) + 1];',
    'await installVersionedPayload({ componentId: value("--component"), channel: value("--channel"), versionId: value("--version"), payloadRoot: value("--payload-root"), processEnv: process.env, selectAsDefaultReleaseChannel: true });',
  ].join('\n');
  return `#!/bin/sh\nif [ "$1 $2" = "self __install-payload" ]; then exec ${safeBashSingleQuote(process.execPath)} --conditions=happier-source --import ${safeBashSingleQuote(createRequire(import.meta.url).resolve('tsx'))} --input-type=module -e ${safeBashSingleQuote(installer)} "$@"; fi\n${body}`;
}
