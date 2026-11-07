import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as runtime from '@happier-dev/forge-ci/runtime';

describe('Forge CI public Developer Preview package', () => {
  it('publishes only its explicit runtime, UI and translations domains', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(manifest.private).toBe(false);
    expect(manifest.version).toBe('0.0.0');
    expect(manifest.happier.publicSdkRelease).toEqual({ posture: 'developer_preview', supportPolicy: 'README.md#evolving-the-abi', externalPublicationRequiresApproval: true });
    expect(Object.keys(manifest.exports).sort()).toEqual(['./runtime', './translations', './ui']);
    for (const entry of ['runtime', 'ui', 'translations']) {
      expect(manifest.exports[`./${entry}`]).toEqual({ 'happier-source': `./src/${entry}.ts`, types: `./dist/${entry}.d.ts`, default: `./dist/${entry}.js` });
    }
    expect(manifest.files).toEqual(['dist', 'README.md', 'package.json']);
    expect(manifest.files).not.toContain('src');
  });

  it('declares its public runtime closure and is delivered to the actual author and forge consumers', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(manifest.dependencies).toEqual({
      '@happier-dev/plugin-sdk': '0.0.0',
      '@happier-dev/plugin-ui': '0.0.0',
      '@happier-dev/triage-protocol': '0.0.0',
      '@happier-dev/triage-sources': '0.0.0',
    });
    expect(manifest.peerDependencies).toEqual({ react: '19.2.0' });
    const cli = JSON.parse(readFileSync(new URL('../../../apps/cli/package.json', import.meta.url), 'utf8'));
    expect(cli.dependencies['@happier-dev/forge-ci']).toBe('0.0.0');
    expect(cli.bundledDependencies).toContain('@happier-dev/forge-ci');
    const github = JSON.parse(readFileSync(new URL('../../plugins/scm-github/package.json', import.meta.url), 'utf8'));
    expect(github.dependencies['@happier-dev/forge-ci']).toBe('0.0.0');
  });

  it('loads the public pure runtime without a DOM or native renderer', () => {
    expect(typeof runtime.createForgeCiAdapterV1).toBe('function');
    expect(typeof runtime.createForgeCiReadsV1).toBe('function');
    expect(typeof runtime.createForgeCiBranchCountsV1).toBe('function');
    expect(typeof runtime.buildForgeCiFailureSummaryV1).toBe('function');
  });
});
