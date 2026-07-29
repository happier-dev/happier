import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const require_ = createRequire(import.meta.url);

function resolveReactNativeRoot(): string {
  const packageJsonPath = require_.resolve('react-native/package.json');
  return dirname(packageJsonPath);
}

function readScrollViewComponentView(sourceRoot: string): string {
  return readFileSync(
    join(
      sourceRoot,
      'React/Fabric/Mounting/ComponentViews/ScrollView/RCTScrollViewComponentView.mm',
    ),
    'utf8',
  );
}

describe('React Native Fabric MVCP stale-state patch', () => {
  it('keeps a patch-package artifact for the installed React Native version', () => {
    const reactNativeRoot = resolveReactNativeRoot();
    const pkg = JSON.parse(readFileSync(join(reactNativeRoot, 'package.json'), 'utf8')) as {
      version: string;
    };
    const patchPath = resolve(
      __dirname,
      '../../../../../patches',
      `react-native+${pkg.version}.patch`,
    );

    expect(existsSync(patchPath), `expected patch file at ${patchPath}`).toBe(true);
    expect(readFileSync(patchPath, 'utf8')).toContain('HAPPIER PATCH(react-native-mvcp-null-prop-clear)');
  });

  it('clears stale MVCP anchor state when the native prop is null', () => {
    const source = readScrollViewComponentView(resolveReactNativeRoot());

    expect(source).toContain('HAPPIER PATCH(react-native-mvcp-null-prop-clear)');
    expect(source).toMatch(/_firstVisibleView\s*=\s*nil;/);
    expect(source).toMatch(/_prevFirstVisibleFrame\s*=\s*CGRectZero;/);
  });
});
