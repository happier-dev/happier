import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
    expect(packageJson.scripts?.['pretypecheck:local']).toBe('yarn -s prepare:declarations');
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
