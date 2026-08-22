import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { resolveWorkspaceBundlePublicationMode } from '../../../../scripts/workspaces/workspaceBundlePublication.mjs';
import { resolveCliPublicationBuildSteps } from '../buildPublication.mjs';

const packageJson = JSON.parse(
  readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
) as {
  scripts?: Record<string, string | undefined>;
  dependencies?: Record<string, string | undefined>;
  optionalDependencies?: Record<string, string | undefined>;
  happier?: {
    voiceInference?: {
      deferredRuntimePackages?: string[];
    };
  };
};

describe('apps/cli package scripts', () => {
  it('routes typecheck through the shared Node-safe TypeScript wrapper', () => {
    expect(String(packageJson.scripts?.typecheck ?? '')).toContain(
      '--script=typecheck:local',
    );
    expect(String(packageJson.scripts?.['typecheck:local'] ?? '')).toMatch(
      /scripts\/workspaces\/runTypeScriptCli\.mjs --noEmit\b/,
    );
    expect(String(packageJson.scripts?.['typecheck:local'] ?? '')).not.toMatch(/\btsc\b/);
    expect(packageJson.scripts?.['pretypecheck:local']).toBeUndefined();
    expect(String(packageJson.scripts?.['typecheck:local'] ?? '')).not.toMatch(
      /prepare:declarations|buildSharedDeps/,
    );
    expect(packageJson.scripts?.['prepare:declarations']).toBe('node scripts/buildSharedDeps.mjs --declarations');
  });

  it('runs source tests without publishing shared workspace output', () => {
    expect(packageJson.scripts?.pretest).toBeUndefined();
    expect(packageJson.scripts?.['vitest:local']).toBe('vitest');
    expect(packageJson.scripts?.['test:unit:local']).not.toMatch(/syncSharedDepsForDev|build:shared|buildSharedDeps/);
    expect(packageJson.scripts?.['test:integration']).not.toMatch(/syncSharedDepsForDev|build:shared|buildSharedDeps/);
    expect(packageJson.scripts?.['test:slow']).not.toMatch(/syncSharedDepsForDev|build:shared|buildSharedDeps/);
  });

  it('delegates build orchestration to the atomic CLI dist build owner', () => {
    expect(String(packageJson.scripts?.build ?? '')).toBe('node scripts/build.mjs');
    expect(String(packageJson.scripts?.build ?? '')).not.toMatch(/\btsc\b/);
  });

  it('publishes every prepack build step in artifact mode from its own arguments', () => {
    // A package manager overwrites `npm_lifecycle_event` for each nested script, so a
    // publication step that only inherits the `prepack` lifecycle resolves to `live` as
    // soon as it runs under another script. Live publication may retain a failing
    // plugin's last-green package, and the pack-time copier then ships those bytes.
    // Every publication step must therefore carry the mode in its own arguments.
    const prepack = String(packageJson.scripts?.prepack ?? '');
    const steps = prepack.split('&&').map((step) => step.trim()).filter(Boolean);
    expect(steps.length).toBeGreaterThan(0);

    // The publication build itself is owned by scripts/buildPublication.mjs, which every
    // producer of a CLI tarball runs. prepack delegates to that owner instead of restating
    // the sequence, so this guard expands the owner's steps and checks the whole chain.
    expect(steps[0]).toBe('node scripts/buildPublication.mjs');
    const ownedSteps = resolveCliPublicationBuildSteps({ packageRoot: process.cwd() });
    const publicationArgv = [
      ...ownedSteps.map((step) => step.args.map((arg) => String(arg))),
      ...steps.slice(1).map((step) => step.split(/\s+/u)),
    ];

    const publicationScripts = ['scripts/buildSharedDeps.mjs', 'scripts/bundleWorkspaceDeps.mjs'];
    for (const publicationScript of publicationScripts) {
      const matchingArgv = publicationArgv.filter((tokens) => tokens.some(
        (token) => token.replaceAll('\\', '/').endsWith(publicationScript),
      ));
      expect(matchingArgv).toHaveLength(1);
      const tokens = matchingArgv[0]!;
      const scriptIndex = tokens.findIndex(
        (token) => token.replaceAll('\\', '/').endsWith(publicationScript),
      );
      expect(resolveWorkspaceBundlePublicationMode({
        argv: tokens.slice(scriptIndex + 1),
        env: {},
      })).toBe('artifact');
    }

    // The CLI dist build inside prepack must not re-enter the shared build through a
    // package-manager lifecycle hook: that nested invocation carries no `--artifact`.
    for (const step of steps) {
      const runScriptMatch = /^yarn\s+(?:-s\s+)?([\w:.-]+)$/u.exec(step);
      if (!runScriptMatch) continue;
      const hookName = `pre${runScriptMatch[1]!}`;
      expect(String(packageJson.scripts?.[hookName] ?? '')).not.toMatch(
        /buildSharedDeps|build:shared/,
      );
    }
  });

  it('syncs bundled workspace deps before the source dev entrypoint', () => {
    expect(String(packageJson.scripts?.dev ?? '')).toBe('node scripts/syncSharedDepsForDev.mjs && tsx --tsconfig tsconfig.json src/index.ts');
  });

  it('pins the native Voice inference runtime used by installed CLI workers', () => {
    expect(packageJson.dependencies?.['sherpa-onnx-node']).toBe('1.12.38');
    const nativePackages = {
      'sherpa-onnx-darwin-arm64': '1.12.38',
      'sherpa-onnx-darwin-x64': '1.12.38',
      'sherpa-onnx-linux-arm64': '1.12.38',
      'sherpa-onnx-linux-x64': '1.12.38',
      'sherpa-onnx-win-x64': '1.12.38',
    };
    expect(packageJson.optionalDependencies).toMatchObject(nativePackages);
    expect(packageJson.happier?.voiceInference?.deferredRuntimePackages).toEqual(expect.arrayContaining([
      'sherpa-onnx-node',
      ...Object.keys(nativePackages),
    ]));
  });
});
