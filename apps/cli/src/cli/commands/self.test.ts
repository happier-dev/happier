import { describe, expect, it } from 'vitest';

import { computeSelfUpdateSpec, packageJsonPathForNodeModules, parseSelfChannel } from './self';

describe('self command helpers', () => {
  it('defaults to stable channel', () => {
    expect(parseSelfChannel([])).toBe('stable');
  });

  it.each([
    { args: ['--preview'], expected: 'preview' },
    { args: ['--channel=preview'], expected: 'preview' },
    { args: ['--channel', 'preview'], expected: 'preview' },
    { args: ['--channel=stable'], expected: 'stable' },
    { args: ['--channel', 'stable'], expected: 'stable' },
    { args: ['--channel=unknown'], expected: 'stable' },
    { args: ['--channel'], expected: 'stable' },
    { args: ['--preview', '--channel=stable'], expected: 'preview' },
  ])('parses channel flags: $args -> $expected', ({ args, expected }) => {
    expect(parseSelfChannel(args)).toBe(expected);
  });

  it('builds npm spec from channel and override', () => {
    expect(computeSelfUpdateSpec({ packageName: '@happier-dev/cli', channel: 'stable', to: '' })).toBe('@happier-dev/cli@latest');
    expect(computeSelfUpdateSpec({ packageName: '@happier-dev/cli', channel: 'preview', to: '' })).toBe('@happier-dev/cli@next');
    expect(computeSelfUpdateSpec({ packageName: '@happier-dev/cli', channel: 'preview', to: '1.2.3' })).toBe('@happier-dev/cli@1.2.3');
    expect(computeSelfUpdateSpec({ packageName: '@happier-dev/cli', channel: 'stable', to: '  latest  ' })).toBe('@happier-dev/cli@latest');
  });

  it('rejects unsafe override specs', () => {
    expect(() =>
      computeSelfUpdateSpec({ packageName: '@happier-dev/cli', channel: 'stable', to: '1.2.3 || rm -rf /' }),
    ).toThrow(/invalid --to value/i);
  });

  it('builds node_modules package.json path for valid package names', () => {
    expect(packageJsonPathForNodeModules({ rootDir: '/tmp/root', packageName: '@happier-dev/cli' }))
      .toBe('/tmp/root/node_modules/@happier-dev/cli/package.json');
    expect(packageJsonPathForNodeModules({ rootDir: '/tmp/root', packageName: 'chalk' }))
      .toBe('/tmp/root/node_modules/chalk/package.json');
  });

  it('rejects traversal-like package names when building node_modules paths', () => {
    expect(packageJsonPathForNodeModules({ rootDir: '/tmp/root', packageName: '../evil' })).toBeNull();
    expect(packageJsonPathForNodeModules({ rootDir: '/tmp/root', packageName: '@happier-dev/../evil' })).toBeNull();
    expect(packageJsonPathForNodeModules({ rootDir: '/tmp/root', packageName: './evil' })).toBeNull();
    expect(packageJsonPathForNodeModules({ rootDir: '/tmp/root', packageName: 'pkg/../../evil' })).toBeNull();
  });
});
