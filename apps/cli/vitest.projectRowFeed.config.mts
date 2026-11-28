import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkspacePackageSourcesPlugin, type WorkspacePackageSpec } from '../../scripts/testing/vitestWorkspacePackageResolution.ts';
import { createTestHomeEnvironment } from '../../scripts/testing/testHomeEnvironment.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cliRoot = resolve(root, 'apps/cli');
// This bounded source check uses the declared CLI dependency closure. The
// ordinary config's repository-wide inventory is blocked by an unrelated
// incomplete, untracked plugin scaffold. All imported owner code stays real.
const specs = new Map<string, WorkspacePackageSpec>();
const queue = [cliRoot];
for (let index = 0; index < queue.length; index += 1) {
    const manifest = JSON.parse(readFileSync(resolve(queue[index]!, 'package.json'), 'utf8'));
    for (const name of Object.keys(manifest.dependencies ?? {})) {
        if (!name.startsWith('@happier-dev/') || specs.has(name)) continue;
        const packageRoot = name.startsWith('@happier-dev/plugins-')
            ? resolve(root, 'packages/plugins', name.slice('@happier-dev/plugins-'.length))
            : resolve(root, 'packages', name.slice('@happier-dev/'.length));
        specs.set(name, { packageName: name, packageSourceRoot: resolve(packageRoot, 'src') });
        queue.push(packageRoot);
    }
}
export default {
    root: cliRoot,
    esbuild: { sourcemap: false },
    test: {
        environment: 'node', pool: 'forks', maxWorkers: 1,
        include: ['src/**/*.test.ts'],
        setupFiles: [resolve(root, 'scripts/testing/vitestAgentSetup.mjs'), resolve(cliRoot, 'src/vitestSetup.composed.testkit.ts')],
        sequence: { setupFiles: 'list' },
        env: createTestHomeEnvironment().env,
        globalSetup: [resolve(cliRoot, 'src/test-setup.unit.ts')],
        testTimeout: 60000, hookTimeout: 60000,
    },
    resolve: { alias: [{ find: '@', replacement: resolve(cliRoot, 'src') }] },
    optimizeDeps: { exclude: [...specs.keys()] },
    plugins: [createWorkspacePackageSourcesPlugin([...specs.values()], 'project-row-feed-source-check')],
};
