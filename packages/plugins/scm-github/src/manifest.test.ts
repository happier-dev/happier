import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as tar from 'tar';
import { PluginActionContributionV2Schema } from '@happier-dev/protocol';
import { assertTriageSourceContributionV1 } from '@happier-dev/triage-protocol/testing/v1';
import { describe, expect, it } from 'vitest';

import { resolveWindowsCommandInvocation } from '../../../../scripts/pipeline/lib/windows/resolveWindowsCommandInvocation.mjs';
import {
  GITHUB_BRAND_RESOURCE_ID,
  GITHUB_TRIAGE_ACTION_IDS_V1,
  GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1,
  GITHUB_TRIAGE_DETAIL_RENDERER_ID_V1,
  PLUGIN_MANIFEST,
} from './manifest.js';
import { GITHUB_CONNECTED_ACCOUNT_PURPOSE } from './observations/githubProviderContracts.js';

// Records the selection basis; it does not make the external source or terms immutable.
const GITHUB_BRAND_ASSET_PROVENANCE = {
  source: {
    publisher: 'GitHub',
    document: 'GitHub Logos',
    asset: 'GitHub Logos/PNG/GitHub_Invertocat_Black_Clearspace.png',
    url: 'https://github.com/logos',
  },
  termsUrl: 'https://github.com/logos',
  sha256: '581c35d9f3c3a10bba201f63a43ac59173e7b89b0bd2ff9070179205e2ffc26f',
} as const;

const BRAND_ASSET_ARCHIVE_PATH = 'assets/brand.png';
const NPM_PACK_TIMEOUT_MS = 60_000;

async function readPackedGitHubBrandAsset(): Promise<Buffer> {
  const destination = await mkdtemp(join(tmpdir(), 'happier-github-brand-pack-'));
  try {
    const invocation = resolveWindowsCommandInvocation({
      command: 'npm',
      args: ['pack', '--ignore-scripts', '--json', '--pack-destination', destination],
    });
    const result = spawnSync(invocation.command, invocation.args, {
      cwd: new URL('../', import.meta.url),
      encoding: 'utf8',
      timeout: NPM_PACK_TIMEOUT_MS,
      ...(invocation.windowsVerbatimArguments === true ? { windowsVerbatimArguments: true } : {}),
    });
    if (result.error) {
      throw new Error(`npm pack could not start: ${result.error.message}`);
    }
    if (result.signal) {
      throw new Error(`npm pack was terminated by ${result.signal}`);
    }
    if (result.status !== 0) {
      throw new Error(`npm pack exited ${result.status}: ${result.stderr || result.stdout}`);
    }

    const packResults: unknown = JSON.parse(result.stdout);
    const archiveName = Array.isArray(packResults) && typeof packResults[0]?.filename === 'string'
      ? packResults[0].filename
      : null;
    expect(archiveName).not.toBeNull();

    const extractionDirectory = join(destination, 'extracted');
    await mkdir(extractionDirectory);
    await tar.x({ file: join(destination, archiveName!), cwd: extractionDirectory, strict: true });
    return await readFile(join(extractionDirectory, 'package', BRAND_ASSET_ARCHIVE_PATH));
  } finally {
    await rm(destination, { recursive: true, force: true });
  }
}

describe('GitHub SCM manifest', () => {
  it('declares one conforming Triage source contribution with GitHub vocabulary', () => {
    // Declaring the three Actions without their contribution is the loud
    // "registered but never declared" failure this assertion exists to catch.
    expect(() => assertTriageSourceContributionV1(PLUGIN_MANIFEST)).not.toThrow();

    const [contribution] = PLUGIN_MANIFEST.contributes.targetedPluginContributions;
    expect(contribution?.descriptor.kinds.map((kind) => kind.id))
      .toEqual(['pull-request', 'issue']);
    // Flattening another forge's word into GitHub's is the first step toward
    // flattening the rest of its vocabulary.
    expect(JSON.stringify(contribution?.descriptor)).not.toContain('merge-request');
    expect(contribution?.surfaces.detail.renderer).toBe(GITHUB_TRIAGE_DETAIL_RENDERER_ID_V1);
    expect(PLUGIN_MANIFEST.contributes.ui.renderers.map(({ id }) => id))
      .toContain(GITHUB_TRIAGE_DETAIL_RENDERER_ID_V1);
  });

  it('authorizes exact account materialization for every declared Triage read', () => {
    const actions = new Map(
      PLUGIN_MANIFEST.contributes.actions.map((action) => [action.id, action]),
    );
    for (const id of Object.values(GITHUB_TRIAGE_ACTION_IDS_V1)) {
      expect(actions.get(id)?.hostAccess)
        .toEqual(['github-api', GITHUB_CONNECTED_ACCOUNT_PURPOSE]);
    }
    // Both reads receive the configured instance, so both name the exact account
    // leaf the host binds and revalidates — `scan` through every arm of its
    // published two-arm input union. `listInstances` carries no account at all,
    // because producing account references is what it performs.
    const expectedAccountBindings = [
      { path: 'instance.binding.account', purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE },
    ];
    expect(actions.get(GITHUB_TRIAGE_ACTION_IDS_V1.get)?.connectedAccountPurposeBindings)
      .toEqual(expectedAccountBindings);
    expect(actions.get(GITHUB_TRIAGE_ACTION_IDS_V1.scan)?.connectedAccountPurposeBindings)
      .toEqual(expectedAccountBindings);
    expect(actions.get(GITHUB_TRIAGE_ACTION_IDS_V1.listInstances))
      .not.toHaveProperty('connectedAccountPurposeBindings');
  });

  it('declares the four source-native detail reads with the same account authority', () => {
    const actions = new Map(
      PLUGIN_MANIFEST.contributes.actions.map((action) => [action.id, action]),
    );
    const declared = Object.values(GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1);
    expect(declared).toHaveLength(4);

    for (const id of declared) {
      const action = actions.get(id);
      if (!action) throw new Error(`the detail read '${id}' must be declared`);
      // A mounted Plugin UI surface has no storage member and no transport, so an
      // Action is the only way this source's detail body reaches GitHub at all —
      // and it materializes the exact configured account through the same seam
      // every other Triage read uses.
      expect(action.hostAccess).toEqual(['github-api', GITHUB_CONNECTED_ACCOUNT_PURPOSE]);
      expect(action.connectedAccountPurposeBindings).toEqual([
        { path: 'instance.binding.account', purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE },
      ]);
      expect(action.dangerLevel).toBe('safe');
      // They carry no Triage operation role: the aggregate never invokes them.
      expect(action.surfaces).toEqual(['plugin']);
      expect(() => PluginActionContributionV2Schema.parse(action)).not.toThrow();
    }

    const roleBound = JSON.stringify(
      PLUGIN_MANIFEST.contributes.targetedPluginContributions,
    );
    for (const id of declared) {
      expect(roleBound).not.toContain(id);
    }
  });

  it('binds the scan account leaf under a declaration that can actually fail', () => {
    const actions = new Map(
      PLUGIN_MANIFEST.contributes.actions.map((action) => [action.id, action]),
    );
    const scan = actions.get(GITHUB_TRIAGE_ACTION_IDS_V1.scan);
    const get = actions.get(GITHUB_TRIAGE_ACTION_IDS_V1.get);
    const listInstances = actions.get(GITHUB_TRIAGE_ACTION_IDS_V1.listInstances);
    if (!scan || !get || !listInstances) {
      throw new Error('The three Triage reads must be declared before their bindings can be judged.');
    }

    // The published union is accepted only because both arms carry the same exact
    // credential-ref leaf at the bound path. `definePlugin` runs this same schema at
    // definition time, so an unproven path cannot reach a built manifest at all.
    expect(() => PluginActionContributionV2Schema.parse(scan)).not.toThrow();

    // A binding that cannot fail proves nothing, so the same declaration is
    // re-checked against a union whose second arm — `listInstances`' own published
    // input — never reaches the bound path. Only arm coverage differs: the leaf
    // shape in the reachable arm is the exact one the accepted declaration uses.
    expect(() => PluginActionContributionV2Schema.parse({
      ...scan,
      inputSchema: { anyOf: [get.inputSchema, listInstances.inputSchema] },
    })).toThrow(
      'Connected Account purpose bindings must target one exact qualified credential-ref input leaf in every declared input arm.',
    );

    // And a leaf only the initial page arm declares is rejected for the same reason.
    expect(() => PluginActionContributionV2Schema.parse({
      ...scan,
      connectedAccountPurposeBindings: [
        { path: 'page.limit', purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE },
      ],
    })).toThrow(
      'Connected Account purpose bindings must target one exact qualified credential-ref input leaf in every declared input arm.',
    );
  });

  it('declares and packages the official GitHub brand mark through the generic Resource owner', async () => {
    expect(PLUGIN_MANIFEST.brand).toEqual({ iconResourceId: GITHUB_BRAND_RESOURCE_ID });
    expect(PLUGIN_MANIFEST.contributes.resources).toEqual([{
      id: GITHUB_BRAND_RESOURCE_ID,
      kind: 'asset',
      path: 'assets/brand.png',
      contentType: 'image/png',
    }]);

    const asset = readFileSync(new URL('../assets/brand.png', import.meta.url));
    expect([...asset.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(asset.readUInt32BE(16)).toBe(384);
    expect(asset.readUInt32BE(20)).toBe(384);
    expect(asset.byteLength).toBeLessThanOrEqual(256 * 1024);
    expect(createHash('sha256').update(asset).digest('hex')).toBe(GITHUB_BRAND_ASSET_PROVENANCE.sha256);

    const packedAsset = await readPackedGitHubBrandAsset();
    expect(packedAsset).toEqual(asset);
  });
});
