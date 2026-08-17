import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderPluginActionReferenceMarkdown } from '../src/actions/pluginActionReference.ts';

const scriptPath = fileURLToPath(import.meta.url);
const outputPath = resolve(
  fileURLToPath(new URL('../../', import.meta.url)),
  '../apps/docs/content/docs/plugins/api/host-actions.mdx',
);

function parseMode(arguments_: readonly string[]): 'check' | 'write' {
  if (arguments_.length !== 1 || (arguments_[0] !== '--check' && arguments_[0] !== '--write')) {
    throw new Error('Usage: generate-plugin-action-reference.ts --check|--write');
  }
  return arguments_[0] === '--write' ? 'write' : 'check';
}

export async function generatePluginActionReference(
  mode: 'check' | 'write',
  targetPath = outputPath,
): Promise<void> {
  const generated = renderPluginActionReferenceMarkdown();
  if (mode === 'write') {
    await writeFile(targetPath, generated, 'utf8');
    return;
  }

  const current = await readFile(targetPath, 'utf8');
  if (current !== generated) {
    throw new Error(
      `Plugin Action reference is out of date: ${targetPath}. Run node --import tsx packages/protocol/scripts/generate-plugin-action-reference.ts --write.`,
    );
  }
}

async function main(): Promise<void> {
  await generatePluginActionReference(parseMode(process.argv.slice(2)));
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
