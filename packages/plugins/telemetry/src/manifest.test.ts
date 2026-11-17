import { readFile } from 'node:fs/promises';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { assertTriageSourceContributionV1 } from '@happier-dev/triage-protocol/testing/v1';
import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';

describe('Telemetry plugin manifest', () => {
  it('passes the host manifest parser', () => {
    const parsed = parsePluginManifest(PLUGIN_MANIFEST);
    expect(
      parsed.ok
        ? []
        : parsed.diagnostics.map((diagnostic) => diagnostic.message),
    ).toEqual([]);
  });

  it('registers the Happier exceptions source with a detail renderer whose artifact the package exports', async () => {
    expect(() =>
      assertTriageSourceContributionV1(PLUGIN_MANIFEST),
    ).not.toThrow();
    const [contribution] =
      PLUGIN_MANIFEST.contributes.targetedPluginContributions;
    const detail = contribution?.surfaces?.detail;
    expect(detail?.renderer).toBeDefined();
    const renderer = PLUGIN_MANIFEST.contributes.ui.renderers.find(
      (candidate) => candidate.id === detail?.renderer,
    );
    expect(renderer?.kind).toBe('reactNative');
    const artifact =
      renderer?.kind === 'reactNative' ? renderer.artifact : undefined;
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as Readonly<{ exports: Readonly<Record<string, unknown>> }>;
    expect(packageJson.exports[`./happier-plugin-ui/${String(artifact)}`]).toBe(
      './src/ui/exceptionDetail.tsx',
    );
  });
});
