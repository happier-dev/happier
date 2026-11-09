import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { resolveVitestWorkers } from '../../../scripts/testing/vitestWorkers';
import { createWorkspacePackageSourcesPlugin } from '../../../scripts/testing/vitestWorkspacePackageResolution';

export default defineConfig({
  plugins: [createWorkspacePackageSourcesPlugin(['plugin-sdk', 'protocol', 'agents', 'cli-common', 'channels-protocol', 'triage-protocol', 'triage-sources']
    .map(name => ({ packageName: `@happier-dev/${name}`, packageSourceRoot: fileURLToPath(new URL(`../../${name}/src`, import.meta.url)) })))],
  test: { ...resolveVitestWorkers(), environment: 'node' },
});
