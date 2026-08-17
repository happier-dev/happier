import { readFileSync } from 'node:fs';

import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import {
  TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
  TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
  TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
  TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
} from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import {
  PLUGIN_MANIFEST,
  TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1,
} from './manifest.js';

describe('Triage plugin manifest', () => {
  it('keeps Protocol available only to test support', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as Readonly<{
      dependencies?: Readonly<Record<string, string>>;
      devDependencies?: Readonly<Record<string, string>>;
    }>;

    expect(packageJson.dependencies?.['@happier-dev/protocol']).toBeUndefined();
    expect(packageJson.devDependencies?.['@happier-dev/protocol']).toBe('0.0.0');
  });

  it('is admitted by the canonical public manifest parser', () => {
    const parsed = parsePluginManifest(PLUGIN_MANIFEST);
    expect(parsed.ok ? null : parsed.diagnostics).toBe(null);
  });

  it('declares the persisted identity that source contributions target', () => {
    // The plugin id is the persisted connected-account, contribution and
    // Collection-row key, so it is asserted as an exact literal rather than
    // read back from the manifest. It must also equal the protocol-published
    // target id: a mismatch aims every source contribution at no plugin.
    expect(PLUGIN_MANIFEST.id).toBe('happier.triage');
    expect(PLUGIN_MANIFEST.id).toBe(TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1);
  });

  it('declares the one target-owned V1 source contribution point', () => {
    const expectedPoint = {
      id: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
      maxContributionsPerContributor: 1,
      protocols: [{
        id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
        version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
      }],
    };

    expect(PLUGIN_MANIFEST.contributes?.pluginContributionPoints).toHaveLength(1);
    expect(PLUGIN_MANIFEST.contributes?.pluginContributionPoints?.[0]).toMatchObject(expectedPoint);
    expect(TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1).toEqual({
      targetPluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
      id: expectedPoint.id,
      protocol: expectedPoint.protocols[0],
    });
  });

  it('names the product, not the program, everywhere a user can read it', () => {
    expect(PLUGIN_MANIFEST.displayName).toBe('PRs & Issues');
    expect(`${PLUGIN_MANIFEST.displayName} ${PLUGIN_MANIFEST.description}`).not.toMatch(/triage/iu);
  });

  it('carries the daemon entrypoint the bundled activation source resolves', () => {
    expect(PLUGIN_MANIFEST.entrypoints.daemon).toBe('./dist/index.js');
  });
});
