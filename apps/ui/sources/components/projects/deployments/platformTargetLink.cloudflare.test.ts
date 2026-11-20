import { expect, it } from 'vitest';
import {
  createPluginHttpFixture,
  createPluginTestkit,
} from '@happier-dev/plugin-sdk/testing';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import * as entry from '../../../../../../packages/plugins/deploy-cloudflare/src/index';
import { patchHappierActionInputPath } from '@happier-dev/plugin-ui/presentation';
import type { PluginPortableReleaseManifestV1 } from '@happier-dev/protocol/plugins/availability';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { resolveEffectiveActionInputFields } from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import {
  applyPlatformFieldPatch,
  buildPlatformTargetDraft,
  disclosePlatformFields,
  readDeploymentPlatformTargets,
  readPlatformInspectOutcome,
  readPlatformReviewNotice,
  readPlatformReviewRuntime,
} from './platformTargetLink';

const account = {
  service: { pluginId: entry.manifest.id, localId: 'cloudflare' },
  accountId: 'selected-token',
};
const repository = {
  kind: 'github',
  deployment: 'https://github.com',
  repository: 'octocat/octocat.github.io',
} as const;

function cloudflarePlatform(targetId: 'pages' | 'workers') {
  // The UI consumes this same plugin declaration through its portable projection.
  const platform = readDeploymentPlatformTargets([
    { manifest: entry.manifest as unknown as PluginPortableReleaseManifestV1 },
  ]).find((target) => target.targetId === targetId);
  if (!platform) throw new Error(`Missing Cloudflare platform ${targetId}`);
  return platform;
}

it('checks an existing Pages project from the sheet choices through the Pages inspect Action', async () => {
  const project = {
    id: 'pages-project-id',
    name: 'happier-auto-qa',
    production_branch: 'master',
    source: {
      type: 'github',
      config: {
        owner: 'octocat',
        repo_name: 'octocat.github.io',
        production_branch: 'master',
      },
    },
  };
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({
    async request(request) {
      requests.push(request);
      return {
        status: 200,
        headers: {},
        body: new TextEncoder().encode(
          JSON.stringify({ success: true, result: project }),
        ),
      };
    },
  });
  const kit = await createPluginTestkit({
    manifest: entry.manifest,
    module: entry,
    services: { http },
  });
  try {
    const platform = cloudflarePlatform('pages');
    // Use existing + Git integration, as the sheet draws it (AUTO-LIVE-PLATFORMS 2g: Check was refused
    // plugin_action_input_schema_invalid because the sheet wrote a partial providerIdentity).
    const choices: Record<string, unknown> = {
      providerAccountId: 'cf-account',
      providerEnvironment: { kind: 'production' },
      'preparedNative.projectName': project.name,
    };
    let values: Record<string, unknown> = {};
    for (const path of ['providerAccountId', 'preparedNative.projectName', 'providerEnvironment']) {
      const fields = disclosePlatformFields(resolveEffectiveActionInputFields({
        inputHints: { fields: [...platform.fields] },
      }, values), values);
      expect(fields.at(-1)?.path).toBe(path);
      expect(fields.filter(field => field.path === 'providerEnvironment')).toHaveLength(path === 'providerEnvironment' ? 1 : 0);
      values = applyPlatformFieldPatch(
        platform.fields,
        values,
        patchHappierActionInputPath(values, path, choices[path]),
      ).values;
    }
    const draft = buildPlatformTargetDraft({
      target: platform,
      ownerAccountId: 'owner',
      serverId: 'home',
      environment: {},
      account,
      repository,
      values,
      sourceMethod: 'gitIntegration',
    });
    const result = await kit.invokeAction(
      platform.inspectLocalId,
      draft as JsonValue,
    );
    // Inspect produces the comparison identity from the project it read.
    expect(
      readPlatformInspectOutcome({ ok: true, value: result }),
    ).toMatchObject({
      kind: expect.stringMatching(/^(ready|needsGitAccess)$/),
      provider: {
        providerIdentity: {
          providerAccountId: 'cf-account',
          providerResourceId: project.id,
          providerEnvironment: 'production',
        },
      },
    });
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      `/client/v4/accounts/cf-account/pages/projects/${project.name}`,
    ]);
  } finally {
    await kit.dispose();
  }
});

it('checks an existing Worker from its sheet choices and returns the selected script tag', async () => {
  const selected = { id: 'worker-app', tag: 'a'.repeat(32) };
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({
    async request(request) {
      requests.push(request);
      return {
        status: 200,
        headers: {},
        body: new TextEncoder().encode(
          JSON.stringify({ success: true, result: [{ id: 'other-worker', tag: 'b'.repeat(32) }, selected] }),
        ),
      };
    },
  });
  const kit = await createPluginTestkit({
    manifest: entry.manifest,
    module: entry,
    services: { http },
  });
  try {
    const platform = cloudflarePlatform('workers');
    const choices: Record<string, unknown> = {
      providerAccountId: 'cf-account',
      // These fields were emitted by the old product hints, reproducing the partial identity.
      'providerIdentity.providerAccountId': 'cf-account',
      'providerIdentity.providerResourceId': selected.tag,
      providerEnvironment: { kind: 'script', scriptName: selected.id },
    };
    let values: Record<string, unknown> = {};
    for (const field of platform.fields) {
      if (field.path in choices) {
        values = applyPlatformFieldPatch(
          platform.fields,
          values,
          patchHappierActionInputPath(values, field.path, choices[field.path]),
        ).values;
      }
    }
    const draft = buildPlatformTargetDraft({
      target: platform,
      ownerAccountId: 'owner',
      serverId: 'home',
      environment: {},
      account,
      repository,
      values,
      sourceMethod: 'upload',
    });
    const result = await kit.invokeAction(platform.inspectLocalId, draft as JsonValue);
    expect(readPlatformInspectOutcome({ ok: true, value: result })).toMatchObject({
      kind: 'ready',
      provider: {
        providerIdentity: {
          providerAccountId: 'cf-account',
          providerResourceId: selected.tag,
          providerEnvironment: `script:${selected.id}`,
        },
      },
    });
    expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
      ['GET', '/client/v4/accounts/cf-account/workers/scripts'],
    ]);
  } finally {
    await kit.dispose();
  }
});

it('reads the Pages upload runtime as versioned facts through the Pages inspect Action', async () => {
  const kit = await createPluginTestkit({
    manifest: entry.manifest,
    module: entry,
  });
  try {
    const platform = cloudflarePlatform('pages');
    // The sheet's create-notice read: no resource named, the draft's source method and provider environment only.
    const draft = buildPlatformTargetDraft({
      target: platform,
      ownerAccountId: 'owner',
      serverId: 'home',
      environment: {},
      account,
      repository: null,
      values: { providerEnvironment: { kind: 'production' } },
      sourceMethod: 'upload',
    });
    const result = await kit.invokeAction(
      platform.inspectLocalId,
      draft as JsonValue,
    );
    expect(readPlatformReviewNotice(result)).toContain('final at creation');
    expect(readPlatformReviewNotice(result)).not.toMatch(/controller|sha256:/);
    expect(readPlatformReviewRuntime(result)).toEqual({
      name: 'Node.js',
      version: '24.21.0',
      pin: 'sha256:3d27e5c11e57',
      tool: 'Wrangler',
      toolVersion: '4.156.0',
    });
  } finally {
    await kit.dispose();
  }
});
