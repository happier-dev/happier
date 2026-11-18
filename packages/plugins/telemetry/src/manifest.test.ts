import { readFile } from 'node:fs/promises';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { assertTriageSourceContributionV1 } from '@happier-dev/triage-protocol/testing/v1';
import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';

describe('Telemetry plugin manifest', () => {
  it('offers a cold default-off Requests field on Services through the existing Resource', async () => {
    const { PluginManifestV2Schema } = await import('@happier-dev/protocol/plugins/manifest/v2');
    const { projectPluginPortableUiDeclarationsV1 } = await import('@happier-dev/protocol/plugins/contributions/ui/declarationProjection');
    const { TELEMETRY_REQUESTS_FIELD_ID_V1, TELEMETRY_REQUESTS_LIST_EXTENSION_ID_V1, DATABASE_CAPTURE_RESOURCE_ID_V1 } = await import('@happier-dev/database-protocol');
    const manifest = PluginManifestV2Schema.parse(PLUGIN_MANIFEST);
    expect(manifest.contributes.ui.listExtensions ?? []).toContainEqual({ id: TELEMETRY_REQUESTS_LIST_EXTENSION_ID_V1,
      entity: 'service', filterFields: [{ id: TELEMETRY_REQUESTS_FIELD_ID_V1, title: 'Requests',
        source: { resource: DATABASE_CAPTURE_RESOURCE_ID_V1 },
        value: { kind: 'number', unit: '{request}' },
        column: { title: 'Requests', qualifier: '24 h', width: 112, align: 'end', priority: 20, defaultHidden: true } }],
    });
    expect(projectPluginPortableUiDeclarationsV1(manifest)[`listExtension:happier.telemetry:${TELEMETRY_REQUESTS_LIST_EXTENSION_ID_V1}`])
      .toMatchObject({ listExtension: { entity: 'service' } });
  });

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

describe('Telemetry widgets (D36)', () => {
  it('offers App vitals, Metric and Slowest routes as installed App widgets the person adds, never auto-added', async () => {
    const { projectPluginPortableUiDeclarationsV1 } = await import('@happier-dev/protocol/plugins/contributions/ui/declarationProjection');
    const { PluginManifestV2Schema } = await import('@happier-dev/protocol/plugins/manifest/v2');
    const { DEPLOYMENT_TELEMETRY_ENVIRONMENTS_OPTIONS_SOURCE_ID_V1 } = await import('@happier-dev/protocol/inputs/deploymentTelemetryEnvironmentOptions');
    // The host's own normalizer, as the daemon runs it at load.
    const manifest = PluginManifestV2Schema.parse(PLUGIN_MANIFEST);
    const entries = projectPluginPortableUiDeclarationsV1(manifest);
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as Readonly<{ exports: Readonly<Record<string, unknown>> }>;
    for (const id of ['app-vitals', 'metric', 'slowest-routes']) {
      const placement = entries[`surfacePlacement:happier.telemetry:${id}`];
      expect(placement, id).toMatchObject({ target: { kind: 'app' } });
      const view = manifest.contributes.ui.views.find(candidate => candidate.id === id);
      expect(view).toMatchObject({ container: 'widget', home: { default: 'available' } });
      const environment = view && 'inputs' in view ? view.inputs?.fields.find(field => field.path === 'environment') : undefined;
      // The Environment picker is the host's option source, named by its owner's constant.
      expect(environment?.optionsSourceId).toBe(DEPLOYMENT_TELEMETRY_ENVIRONMENTS_OPTIONS_SOURCE_ID_V1);
      const renderer = manifest.contributes.ui.renderers.find(candidate => candidate.id === view?.renderer);
      const artifact = renderer?.kind === 'reactNative' ? renderer.artifact : undefined;
      expect(packageJson.exports[`./happier-plugin-ui/${String(artifact)}`], id).toMatch(/^\.\/src\/ui\/widgets\/.+Widget\.tsx$/);
    }
  });
});
