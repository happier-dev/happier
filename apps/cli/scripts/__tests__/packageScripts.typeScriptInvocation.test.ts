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

  it('routes the build typecheck pass through the shared Node-safe TypeScript wrapper', () => {
    expect(String(packageJson.scripts?.build ?? '')).toMatch(
      /scripts\/workspaces\/runTypeScriptCli\.mjs --noEmit\b/,
    );
    expect(String(packageJson.scripts?.build ?? '')).not.toMatch(/\btsc\b/);
  });
});
