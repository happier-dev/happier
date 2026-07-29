import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const forbiddenImportPattern = /apps\/ui|@\/components|@\/sync|@\/theme/u;
const forbiddenPublicAuthoringPattern =
  /\bdefine(?:SurfaceContribution|PluginUiSurface)\b|@happier-dev\/plugin-ui\/descriptor|\bpublic authoring\b|\bauthoring imports\b|\bauthoring APIs\b/u;
const forbiddenPublicExportSubpaths = ['./descriptor', './targets'] as const;

function collectSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(entryPath);
    if (/\.(?:ts|tsx)$/u.test(entry.name) && !/\.(?:test|spec)\.tsx?$/u.test(entry.name)) {
      return [entryPath];
    }
    return [];
  });
}

describe('package import boundary', () => {
  it('does not import app-private UI modules', () => {
    const sourceRoot = new URL('.', import.meta.url).pathname;
    const offenders = collectSourceFiles(sourceRoot).filter((filePath) =>
      forbiddenImportPattern.test(readFileSync(filePath, 'utf8')),
    );

    expect(offenders.map((filePath) => relative(sourceRoot, filePath))).toEqual([]);
  });

  it('does not present plugin-ui as a public surface-authoring package', () => {
    const sourceRoot = new URL('.', import.meta.url).pathname;
    const packageRoot = join(sourceRoot, '..');
    const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      description?: string;
      exports?: Record<string, unknown>;
      private?: boolean;
      happier?: {
        publicSdkRelease?: {
          posture?: string;
          supportPolicy?: string;
          externalPublicationRequiresApproval?: boolean;
        };
      };
    };
    const publicFiles = [
      join(packageRoot, 'README.md'),
      join(packageRoot, 'package.json'),
      join(sourceRoot, 'index.ts'),
    ];
    const offenders = publicFiles.filter((filePath) =>
      forbiddenPublicAuthoringPattern.test(readFileSync(filePath, 'utf8')),
    );

    expect(offenders.map((filePath) => relative(packageRoot, filePath))).toEqual([]);
    expect(packageJson.description).not.toMatch(/\bauthoring\b/u);
    expect(packageJson.private).toBe(true);
    expect(packageJson.happier?.publicSdkRelease).toEqual({
      posture: 'prepublish_hold',
      supportPolicy: 'README.md#plugin-ui-release-posture',
      externalPublicationRequiresApproval: true,
    });
    for (const subpath of forbiddenPublicExportSubpaths) {
      expect(packageJson.exports).not.toHaveProperty(subpath);
    }
  });
});
