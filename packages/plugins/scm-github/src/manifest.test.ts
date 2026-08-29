import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as tar from 'tar';
import { ingestPluginManifestV2, PluginActionContributionV2Schema } from '@happier-dev/protocol';
import { assertTriageSourceContributionV1 } from '@happier-dev/triage-protocol/testing/v1';
import { describe, expect, it } from 'vitest';

import { resolveWindowsCommandInvocation } from '../../../../scripts/pipeline/lib/windows/resolveWindowsCommandInvocation.mjs';
import {
  GITHUB_BRAND_RESOURCE_ID,
  GITHUB_TRIAGE_ACTION_IDS_V1,
  GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1,
  GITHUB_TRIAGE_DETAIL_RENDERER_ID_V1,
  GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1,
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
/**
 * The package-wide per-test budget is the same 60s this one test already
 * permits `npm pack` alone, leaving nothing for the temp-directory, extraction
 * and read work around it. Its budget is therefore the subprocess cap it allows
 * plus the ordinary package budget for that surrounding local work.
 */
const PACKED_BRAND_ASSET_TEST_TIMEOUT_MS = NPM_PACK_TIMEOUT_MS + 60_000;

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
    // Declaring the role Actions without their contribution is the loud
    // "registered but never declared" failure this assertion exists to catch.
    expect(() => assertTriageSourceContributionV1(PLUGIN_MANIFEST)).not.toThrow();

    const [contribution] = PLUGIN_MANIFEST.contributes.targetedPluginContributions ?? [];
    const contributionKinds = (contribution?.descriptor as
      | Readonly<{ kinds?: readonly Readonly<{ id: string }>[] }>
      | undefined)?.kinds ?? [];
    expect(contributionKinds.map((kind) => kind.id))
      .toEqual(['pull-request', 'issue']);
    // Flattening another forge's word into GitHub's is the first step toward
    // flattening the rest of its vocabulary.
    expect(JSON.stringify(contribution?.descriptor)).not.toContain('merge-request');
    const contributionSurfaces = contribution?.surfaces as
      | Readonly<{ detail?: Readonly<{ renderer?: string }> }>
      | undefined;
    expect(contributionSurfaces?.detail?.renderer).toBe(GITHUB_TRIAGE_DETAIL_RENDERER_ID_V1);
    expect((PLUGIN_MANIFEST.contributes.ui?.renderers ?? []).map(({ id }) => id))
      .toContain(GITHUB_TRIAGE_DETAIL_RENDERER_ID_V1);
  });

  it('authorizes exact account materialization for every declared Triage operation that needs it', () => {
    const actions = new Map(
      (PLUGIN_MANIFEST.contributes.actions ?? []).map((action) => [action.id, action]),
    );
    for (const id of Object.values(GITHUB_TRIAGE_ACTION_IDS_V1)) {
      expect(actions.get(id)?.hostAccess)
        .toEqual(['github-api', GITHUB_CONNECTED_ACCOUNT_PURPOSE]);
    }
    // Every operation after discovery receives the configured instance, so each
    // names the exact account leaf the host binds and revalidates — `scan` through every arm of its
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

    // Preparation remains a source-owned credential reread followed by the one
    // generic SCM local-write Action. It needs the same exact account binding,
    // but its declared Triage role must preserve the local-write danger level.
    const prepare = actions.get('triage/prepare-github-review-workspace');
    expect(prepare?.hostAccess).toEqual(['github-api', GITHUB_CONNECTED_ACCOUNT_PURPOSE]);
    expect(prepare?.connectedAccountPurposeBindings).toEqual(expectedAccountBindings);
    expect(prepare?.dangerLevel).toBe('writesLocal');
    const verify = actions.get('triage/verify-github-review-workspace');
    expect(verify?.connectedAccountPurposeBindings).toEqual(expectedAccountBindings);
    expect(verify?.dangerLevel).toBe('safe');
  });

  it('declares every source-native detail read with the same account authority', () => {
    const actions = new Map(
      (PLUGIN_MANIFEST.contributes.actions ?? []).map((action) => [action.id, action]),
    );
    const declared = Object.values(GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1);
    expect(new Set(declared).size).toBe(declared.length);

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
      // Only this source's own mounted detail body reaches them, through the
      // mounted Plugin UI host — present-user authority — so `ui` is the only
      // declared surface and direct plugin code is refused.
      expect(action.surfaces).toEqual(['ui']);
      // The explicit empty list is the canonical mounted-only placement
      // decision: global placement discovery reads no destination from it.
      expect(action.placementBindings).toEqual([]);
      expect(() => PluginActionContributionV2Schema.parse(action)).not.toThrow();
    }

    const roleBound = JSON.stringify(
      PLUGIN_MANIFEST.contributes.targetedPluginContributions,
    );
    for (const id of declared) {
      expect(roleBound).not.toContain(id);
    }
  });

  it('declares the exact mounted-only placement for its seven UI-reachable reads', () => {
    const actions = new Map(
      (PLUGIN_MANIFEST.contributes.actions ?? []).map((action) => [action.id, action]),
    );

    // Discovery and the authoritative read keep their Protocol-owned `plugin`
    // + `ui` surfaces — the Triage daemon consumes `plugin` — while the five
    // source-native detail reads stay `ui`-only. All seven declare the same
    // mounted-only placement: the explicit empty list withdraws them from
    // global placement discovery without disabling any invocation surface.
    const mountedOnly = [
      GITHUB_TRIAGE_ACTION_IDS_V1.listInstances,
      GITHUB_TRIAGE_ACTION_IDS_V1.get,
      ...Object.values(GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1),
    ];
    for (const id of mountedOnly) {
      expect(actions.get(id)?.placementBindings, id).toEqual([]);
    }
    expect(
      (PLUGIN_MANIFEST.contributes.actions ?? [])
        .filter((action) => Array.isArray(action.placementBindings)
          && action.placementBindings.length === 0)
        .map((action) => action.id)
        .sort(),
    ).toEqual([...mountedOnly].sort());
  });

  it('binds the scan account leaf under a declaration that can actually fail', () => {
    const actions = new Map(
      (PLUGIN_MANIFEST.contributes.actions ?? []).map((action) => [action.id, action]),
    );
    const scan = actions.get(GITHUB_TRIAGE_ACTION_IDS_V1.scan);
    const get = actions.get(GITHUB_TRIAGE_ACTION_IDS_V1.get);
    const listInstances = actions.get(GITHUB_TRIAGE_ACTION_IDS_V1.listInstances);
    if (!scan || !get || !listInstances) {
      throw new Error('The three Triage reads must be declared before their bindings can be judged.');
    }

    const ingestWithScan = (replacement: typeof scan) => ingestPluginManifestV2({
      ...PLUGIN_MANIFEST,
      contributes: {
        ...PLUGIN_MANIFEST.contributes,
        actions: (PLUGIN_MANIFEST.contributes.actions ?? []).map((action) => (
          action.id === scan.id ? replacement : action
        )),
      },
    });

    // The canonical whole-manifest admission owner accepts the published union
    // only because both arms carry the same exact credential-ref leaf.
    expect(ingestWithScan(scan)).toMatchObject({ ok: true });

    // A binding that cannot fail proves nothing, so the same declaration is
    // re-checked against a union whose second arm — `listInstances`' own published
    // input — never reaches the bound path. Only arm coverage differs: the leaf
    // shape in the reachable arm is the exact one the accepted declaration uses.
    expect(ingestWithScan({
      ...scan,
      inputSchema: { anyOf: [get.inputSchema ?? {}, listInstances.inputSchema ?? {}] },
    })).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([expect.objectContaining({
        message: 'Connected Account purpose bindings must target one exact qualified credential-ref input leaf in every declared input arm.',
      })]),
    });

    // And a leaf only the initial page arm declares is rejected for the same reason.
    expect(ingestWithScan({
      ...scan,
      connectedAccountPurposeBindings: [
        { path: 'page.limit', purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE },
      ],
    })).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([expect.objectContaining({
        message: 'Connected Account purpose bindings must target one exact qualified credential-ref input leaf in every declared input arm.',
      })]),
    });
  });

  it('declares the pull-request mutations as confirmation-gated UI-only writes', () => {
    const actions = new Map(
      (PLUGIN_MANIFEST.contributes.actions ?? []).map((action) => [action.id, action]),
    );
    const declared = Object.values(GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1);
    expect(new Set(Object.values(GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1)).size)
      .toBe(Object.values(GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1).length);

    for (const id of declared) {
      const action = actions.get(id);
      if (!action) throw new Error(`the mutation '${id}' must be declared`);

      // The human gate is the ABSENCE of `agent` and `mcp`: the write is not
      // agent-reachable at all — no prompt to bypass, no tool, no exposure. A
      // `danger` level with `agent: true` would only FLOOR the action to an
      // approval prompt, which is a different and weaker guarantee. That
      // absence is asserted directly, so the intent survives any future
      // addition to this array.
      expect(action.surfaces).not.toContain('agent');
      expect(action.surfaces).not.toContain('mcp');
      // `ui` is the write's whole product reach. The daemon derives the
      // invoking surface from the authenticated mounted-UI provenance, so a
      // mounted Plugin UI press is admitted as UI authority while direct
      // plugin code — ActionsService — checks only the `plugin` surface and
      // is refused here. Host confirmation is unaffected because it keys off
      // the same invoking surface.
      expect(action.surfaces).toEqual(['ui']);
      // The one placement is the details panel the write lives in; global
      // placement discovery is offered no other destination.
      expect(action.placementBindings).toEqual(['detailsPanel']);
      expect(action.dangerLevel).not.toBe('safe');
      // Non-safe + a non-`plugin` surface is exactly the condition the manifest
      // grammar uses to require host confirmation presentation.
      expect(action.confirmation).toBeDefined();
      // Every write declares the network resource AND the connected-account
      // resource, and rebinds the exact account the configured instance names.
      expect(action.hostAccess).toEqual(['github-api', GITHUB_CONNECTED_ACCOUNT_PURPOSE]);
      expect(action.connectedAccountPurposeBindings).toEqual([
        { path: 'instance.binding.account', purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE },
      ]);
      expect(() => PluginActionContributionV2Schema.parse(action)).not.toThrow();
    }

    expect(actions.get(GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestMerge)?.dangerLevel)
      .toBe('destructive');
    expect(actions.get(GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestClose)?.dangerLevel)
      .toBe('writesRemote');
    expect(actions.get(GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestReopen)?.dangerLevel)
      .toBe('writesRemote');
    // Draft -> ready and a reviewer request are `externalSideEffect` because the
    // effect users feel IS the notification fan-out, not the state field.
    expect(actions.get(GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestMarkReady)?.dangerLevel)
      .toBe('externalSideEffect');
    expect(actions.get(GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestAddReviewers)?.dangerLevel)
      .toBe('externalSideEffect');
    expect(actions.get(GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestSubmitReview)?.dangerLevel)
      .toBe('externalSideEffect');
    expect(actions.get(GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestUpdateBranch)?.dangerLevel)
      .toBe('writesRemote');
    expect(actions.get(GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestRemoveReviewers)?.dangerLevel)
      .toBe('writesRemote');
    // Every issue write moves remote state and summons nobody. None is
    // `destructive`: an issue transition and an exact delta are both reversible
    // through the Action that undoes them.
    for (const id of [
      GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.issueClose,
      GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.issueReopen,
      GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.issueAssigneeAdd,
      GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.issueAssigneeRemove,
      GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.issueLabelAdd,
      GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.issueLabelRemove,
    ]) expect(actions.get(id)?.dangerLevel, id).toBe('writesRemote');

    // They bind to no Triage operation role: the aggregate never invokes a write.
    const roleBound = JSON.stringify(PLUGIN_MANIFEST.contributes.targetedPluginContributions);
    for (const id of declared) expect(roleBound).not.toContain(id);

    // And the details-panel list is exact: these eighteen and nothing else.
    expect(
      (PLUGIN_MANIFEST.contributes.actions ?? [])
        .filter((action) => Array.isArray(action.placementBindings)
          && action.placementBindings.includes('detailsPanel'))
        .map((action) => action.id)
        .sort(),
    ).toEqual([...declared].sort());
  });

  it('admits exactly the verbs the declared Actions consume on the one github-api grant', () => {
    const grants = (PLUGIN_MANIFEST.hostAccess?.required ?? [])
      .filter((request) => request.id === 'github-api');
    // One grant, widened in place. A second network scope for writes would be the
    // split-brain this assertion exists to prevent.
    expect(grants).toHaveLength(1);
    const scope = grants[0]?.scope as { methods?: readonly string[] } | undefined;
    // PUT is merge and update-branch; PATCH is close/reopen; POST is the reviewer
    // request; DELETE is the reviewer withdrawal, which is the ONLY declared
    // Action that consumes it. No verb is granted "for symmetry".
    expect([...(scope?.methods ?? [])].sort())
      .toEqual(['DELETE', 'GET', 'PATCH', 'POST', 'PUT']);
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
  }, PACKED_BRAND_ASSET_TEST_TIMEOUT_MS);
});
