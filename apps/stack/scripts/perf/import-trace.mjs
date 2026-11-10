// Optional diagnostics for the entry-load owner. Record resolution edges only;
// module contents and diagnostics never enter this file.
import { registerHooks } from 'node:module';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, sep } from 'node:path';

const destination = process.env.HAPPIER_ENTRY_IMPORT_TRACE;
const repoDir = process.env.HAPPIER_STACK_REPO_DIR;
const edges = new Set();
function isSource(url) {
  const path = fileURLToPath(url);
  return repoDir && (path.startsWith(`${join(repoDir, 'apps')}${sep}`) || path.startsWith(`${join(repoDir, 'packages')}${sep}`))
    && !/[\\/](?:node_modules|dist|generated|build)[\\/]/.test(path);
}
if (destination) {
  process.once('exit', () => {
    if (edges.size) appendFileSync(destination, `${[...edges].join('\n')}\n`);
  });
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      if (context.parentURL?.startsWith('file:') && result.url.startsWith('file:')
        && isSource(context.parentURL) && isSource(result.url)) {
        edges.add(JSON.stringify([
          fileURLToPath(context.parentURL), fileURLToPath(result.url),
        ]));
      }
      return result;
    },
  });
}
