/**
 * Compatibility entrypoint for the historical migration command.
 *
 * The canonical bundled-plugin publisher lives with the CLI build owner so
 * pack sandboxes can retain one producer without copying this migration tree.
 */
import { pathToFileURL } from 'node:url';
import { main } from '../../../apps/cli/scripts/build-owned/generateBundledPluginEntries.ts';

export { main };

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
