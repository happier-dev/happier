import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const HOSTING_PROVIDER_PLUGIN_PACKAGES = new Set([
  '@happier-dev/plugins-scm-azure-devops',
  '@happier-dev/plugins-scm-bitbucket',
  '@happier-dev/plugins-scm-github',
  '@happier-dev/plugins-scm-gitlab',
]);

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function collectProductionSourceFiles(dir: string): readonly string[] {
  return readdirSync(dir)
    .flatMap((entry) => {
      const path = join(dir, entry);
      const stat = statSync(path);
      if (stat.isDirectory()) return [...collectProductionSourceFiles(path)];
      if (extname(path) !== '.ts' || path.endsWith('.test.ts')) return [];
      return [path];
    })
    .sort();
}

describe('SCM Git hosting-provider ownership', () => {
  it('does not aggregate or depend on first-party hosting provider plugins', () => {
    const packagePath = new URL('../../package.json', import.meta.url);
    const packageJson = readJsonFile(packagePath.pathname) as {
      dependencies?: Record<string, string>;
    };
    const dependencyOffenders = Object.keys(packageJson.dependencies ?? {})
      .filter((dependencyName) => HOSTING_PROVIDER_PLUGIN_PACKAGES.has(dependencyName));

    const sourceRoot = new URL('../', import.meta.url).pathname;
    const sourceOffenders = collectProductionSourceFiles(sourceRoot)
      .flatMap((sourcePath) => {
        const source = readFileSync(sourcePath, 'utf8');
        const matchedPackages = [...HOSTING_PROVIDER_PLUGIN_PACKAGES]
          .filter((packageName) => source.includes(packageName));
        return matchedPackages.map((packageName) => ({
          packageName,
          sourcePath: relative(sourceRoot, sourcePath),
        }));
      });

    expect({
      dependencyOffenders,
      sourceOffenders,
    }).toEqual({
      dependencyOffenders: [],
      sourceOffenders: [],
    });
  });

  it('does not hardcode first-party auth materializer maps in generic runtime services', () => {
    const hostingRoot = new URL('./', import.meta.url).pathname;
    const runtimeServicesSource = readFileSync(join(hostingRoot, 'runtimeServices.ts'), 'utf8');
    const productionSources = collectProductionSourceFiles(hostingRoot)
      .map((sourcePath) => [relative(hostingRoot, sourcePath), readFileSync(sourcePath, 'utf8')] as const);
    const hardcodedMaterializerOffenders = productionSources
      .flatMap(([sourcePath, source]) => [
        ...(
          source.includes('connectedServices.materialization.githubScmHostingToken')
            ? [{ sourcePath, token: 'connectedServices.materialization.githubScmHostingToken' }]
            : []
        ),
        ...(
          source.includes('connectedServices.materialization.bitbucketScmHostingBasicAuth')
            ? [{ sourcePath, token: 'connectedServices.materialization.bitbucketScmHostingBasicAuth' }]
            : []
        ),
        ...(
          /new\s+Map\s*<[^>]*ResolvedPluginHookHandler[^>]*>\s*\(/.test(source)
            ? [{ sourcePath, token: 'ResolvedPluginHookHandler map' }]
            : []
        ),
      ]);

    expect(runtimeServicesSource).not.toMatch(/bundledFirstPartyHosting/);
    expect(runtimeServicesSource).not.toMatch(/createBundledFirstPartyScmHostingAuthMaterializationRegistry/);
    expect(hardcodedMaterializerOffenders).toEqual([]);
  });
});
