import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const roots = [
  'apps/bootstrap/src',
  'packages/cli-common/src/process',
  'packages/cli-common/src/service',
  'packages/cli-common/src/relayHost',
  'packages/cli-common/src/firstPartyRuntime',
  'packages/cli-common/src/systemTasks',
  'apps/cli/src/daemon/service',
];
const leaves = [
  'apps/cli/src/integrations/tmux/TmuxUtilities.ts',
  'apps/cli/src/utils/spawnHappyCLI.ts',
  'apps/cli/src/daemon/doctor.ts',
  'apps/cli/src/daemon/runtime/spawnDetachedDaemonStartSync.ts',
  'apps/cli/src/daemon/sessions/stopSession.ts',
];

async function productionSources(directory: string): Promise<string[]> {
  const files = await Promise.all((await readdir(directory, { withFileTypes: true })).map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return await productionSources(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts') ? [path] : [];
  }));
  return files.flat();
}

/** Retained boundaries with platform or terminal contracts that do not create background Windows consoles. */
function exception(file: string, command: string | null): string | null {
  if (file === 'apps/cli/src/daemon/service/readBackgroundServiceHealth.ts' && ['launchctl', 'systemctl', 'journalctl'].includes(command ?? '')) return 'health probes run only on macOS/Linux';
  if (file === 'apps/cli/src/daemon/service/resolveLinuxSystemUserPaths.ts' && command === 'getent') return 'Linux system-user lookup';
  if (file === 'apps/cli/src/daemon/service/cli.ts' && command === 'tail') return 'explicit user-invoked service logs follow in the inherited terminal';
  if (file === 'apps/cli/src/daemon/doctor.ts' && command === 'ps') return 'POSIX process inspection; Windows has separate hidden PowerShell probes';
  if (file === 'apps/cli/src/daemon/runtime/spawnDetachedDaemonStartSync.ts' && command === null) return 'POSIX detached spawn after the Windows hidden-launcher branch returns';
  return null;
}

describe('desktop background console invariant guard', () => {
  it('rejects new raw process launches without hidden-console policy in the desktop setup and inspection corridor', async () => {
    const files = [...(await Promise.all(roots.map((path) => productionSources(join(root, path))))).flat(), ...leaves.map((path) => join(root, path))];
    const failures: string[] = [];
    for (const file of files) {
      const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const path = relative(root, file).replaceAll('\\', '/');
      const calls = new Set<string>();
      const namespaces = new Set<string>();
      for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !['child_process', 'node:child_process'].includes(statement.moduleSpecifier.text)) continue;
        const bindings = statement.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const binding of bindings.elements) if (['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync'].includes((binding.propertyName ?? binding.name).text)) calls.add(binding.name.text);
        } else if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
      }
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const direct = ts.isIdentifier(node.expression) && calls.has(node.expression.text);
          const namespaced = ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && namespaces.has(node.expression.expression.text);
          if (direct || namespaced) {
            const argument = node.arguments[0];
            const command = argument && ts.isStringLiteral(argument) ? argument.text : null;
            const options = node.arguments[2];
            const hide = options && ts.isObjectLiteralExpression(options)
              ? options.properties.find((property): property is ts.PropertyAssignment => ts.isPropertyAssignment(property) && property.name.getText(source) === 'windowsHide')
              : undefined;
            // The async capture owner permits an explicit user-terminal opt-out. Bootstrap may
            // not request it: every taskRuntime invocation is a captured background command.
            const captureOwner = path === 'packages/cli-common/src/process/runCommandStreaming.ts';
            const cliOwner = path === 'apps/cli/src/utils/spawnHappyCLI.ts';
            if (!exception(path, command) && !(hide && (hide.initializer.kind === ts.SyntaxKind.TrueKeyword || captureOwner || cliOwner))) {
              failures.push(`${path}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: process launch must use the background owner or hide its console`);
            }
          }
        }
        if (path.startsWith('apps/bootstrap/') && ts.isPropertyAssignment(node) && node.name.getText(source) === 'windowsHide' && node.initializer.kind === ts.SyntaxKind.FalseKeyword) {
          failures.push(`${path}: bootstrap must retain the process owner's hidden-console default`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });
});
