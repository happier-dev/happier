import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const packageJson = JSON.parse(
  readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
) as {
  scripts?: Record<string, string | undefined>;
};

describe('apps/cli package scripts', () => {
  it('routes typecheck through the shared Node-safe TypeScript wrapper', () => {
    expect(String(packageJson.scripts?.typecheck ?? '')).toMatch(
      /scripts\/workspaces\/runTypeScriptCli\.mjs --noEmit\b/,
    );
    expect(String(packageJson.scripts?.typecheck ?? '')).not.toMatch(/\btsc\b/);
  });

  it('delegates build orchestration to the atomic CLI dist build owner', () => {
    expect(String(packageJson.scripts?.build ?? '')).toBe('node scripts/build.mjs');
    expect(String(packageJson.scripts?.build ?? '')).not.toMatch(/\btsc\b/);
  });

  it('syncs bundled workspace deps before the source dev entrypoint', () => {
    expect(String(packageJson.scripts?.dev ?? '')).toBe('node scripts/syncSharedDepsForDev.mjs && tsx --tsconfig tsconfig.json src/index.ts');
  });
});
