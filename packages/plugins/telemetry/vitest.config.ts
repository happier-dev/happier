import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import { createWorkspacePackageSourcesPlugin } from '../../../scripts/testing/vitestWorkspacePackageResolution';
import { resolveVitestWorkers } from '../../../scripts/testing/vitestWorkers';
export default defineConfig({
 root: import.meta.dirname,
 plugins: [createWorkspacePackageSourcesPlugin(['plugin-sdk','protocol','database-protocol','databases','triage-protocol','triage-sources'].map(name => ({ packageName: `@happier-dev/${name}`, packageSourceRoot: resolve(import.meta.dirname, '../..', name, 'src') })))],
 test: { ...resolveVitestWorkers(), environment: 'node', include: ['src/**/*.test.ts'] },
});
