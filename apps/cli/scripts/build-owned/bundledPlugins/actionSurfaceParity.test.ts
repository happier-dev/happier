import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { PluginManifestV2Schema } from '@happier-dev/protocol';
import { pluginPackageNameToPackageId, readBundledPluginPackageNames } from '../bundledPluginMembership';

describe('bundled Action surface parity', () => {
  it('publishes UI Actions for agents unless explicitly person-only, and exposes UI and agent Actions to plugins', () => {
    const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
    const directory = new URL('../../../assets/bundled-plugin-manifests/', import.meta.url);
    const findings: string[] = [];
    for (const packageName of readBundledPluginPackageNames(repoRoot)) {
      const asset = new URL(`${pluginPackageNameToPackageId(packageName)}.json`, directory);
      const manifest = PluginManifestV2Schema.parse(JSON.parse(readFileSync(asset, 'utf8')));
      for (const { id, surfaces, personOnly } of manifest.contributes.actions ?? []) {
        const ui = surfaces.includes('ui');
        const agent = surfaces.includes('agent');
        const action = `${manifest.id}:${id}`;
        if (ui && !agent && personOnly !== true) findings.push(`${action} lacks agent access`);
        if ((ui || agent) && !surfaces.includes('plugin')) findings.push(`${action} lacks plugin access`);
        if (personOnly === true && (!ui || agent)) findings.push(`${action} has a conflicting person-only declaration`);
      }
    }
    expect(findings).toEqual([]);
  });
});
