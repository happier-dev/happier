// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import type { JsonValue, PluginEphemeralSharedScope } from '@happier-dev/plugin-sdk';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { PluginClientActionHandler } from '@happier-dev/plugin-sdk/actions';
import type { PluginUiContextEnrichmentV1, PluginUiPageNavigationV1, RenderContext } from '@happier-dev/plugin-sdk/ui';
import type { FileDownloadResultV1 } from '@happier-dev/plugin-sdk/protocol';
import { ForgeReleaseActionInputSchemasV1, type ForgeReleaseAssetPageV1, type ForgeReleaseV1 } from '@happier-dev/triage-protocol/releases/v1';
import { createForgeReleaseV1Fixture } from '@happier-dev/triage-protocol/releases/testing/v1';
import {
  createPluginUiTestkit,
  createPluginUiActionControlTestHost,
  createPluginClientTestkit,
  createSurfaceContextFixture,
  type PluginUiTestkit,
  type PluginUiTestkitHostHandlers,
} from '@happier-dev/plugin-sdk/testing';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { GITHUB_PLUGIN_ID } from '../../observations/githubProviderContracts.js';
import { GITHUB_RELEASE_ACTION_IDS_V1, GITHUB_RELEASE_MOUNTED_ACTION_ID_V1 } from '../../releases/contracts.js';
import { activate, renderSurface } from '../forge/renderForgeSurface.js';
import { GithubReleasesPage, type ReleaseSessionHelpV1 } from './ReleasesPage.js';
import { GITHUB_RELEASES_PAGE_ID_V1 } from '../forge/surfaceIds.js';
import { GITHUB_OVERVIEW_TARGET_ACTION_ID } from '../../actions/overviewContracts.js';
import { GITHUB_CI_ACTION_IDS_V1 } from '../../actions/actionIds.js';
import { PLUGIN_MANIFEST } from '../../manifest.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const repository = {
  kind: 'github',
  deployment: 'https://github.com',
  repository: 'happier-dev/happier',
} as const;
const emptyPage = {
  rows: [],
  omittedRowCount: 0,
  projectionTruncated: false,
  continuation: null,
  incomplete: null,
};
function release(
  id: string,
  tagName: string,
  name: string,
  facts: Readonly<{ draft?: boolean; prerelease?: boolean; day: string }>,
) {
  return {
    repository,
    repositoryId: '4242',
    releaseId: id,
    tagName,
    targetCommitish: 'v0.3',
    name,
    body: `## Highlights\n\n- ${name}`,
    draft: facts.draft ?? false,
    prerelease: facts.prerelease ?? false,
    createdAt: facts.day,
    updatedAt: facts.day,
    publishedAt: facts.draft ? null : facts.day,
    webUrl: `https://github.com/happier-dev/happier/releases/tag/${tagName}`,
    author: 'Leeroy Brun',
    repositoryVisibility: 'public' as const,
    assets: {
      ...emptyPage,
      rows: [
        {
          assetId: `${id}1`,
          name: `happier-${tagName}-macos-arm64.dmg`,
          label: null,
          contentType: 'application/octet-stream',
          size: 148_200_000,
          state: 'uploaded',
          downloadCount: 1284,
        },
      ],
    },
  };
}
const DRAFT = release('905', 'v0.3.0-rc.5', 'Release candidate 5', {
  draft: true,
  prerelease: true,
  day: '2026-10-24T10:44:00Z',
});
const RC4 = release('904', 'v0.3.0-rc.4', 'Release candidate 4', {
  prerelease: true,
  day: '2026-10-19T09:00:00Z',
});
const STABLE = release('903', 'v0.2.14', 'Voice on Android', {
  day: '2026-10-02T09:00:00Z',
});

const mounted: PluginUiTestkit[] = [];
const mountedClients: Awaited<ReturnType<typeof createPluginClientTestkit>>[] = [];
afterEach(async () => {
  for (const fixture of mounted.splice(0)) await fixture.dispose();
  for (const fixture of mountedClients.splice(0)) await fixture.dispose();
});

async function mountReleases(
  options: Readonly<{
    rows: readonly unknown[];
    calls: string[];
    listResult?: JsonValue;
    listError?: PluginError;
    subPath?: string;
    downloadResult?: FileDownloadResultV1;
    downloadCalls?: unknown[];
    lostPublish?: boolean;
    mountId?: string;
    scope?: PluginEphemeralSharedScope;
    lifetime?: AbortController;
    publish?: (value: PluginUiContextEnrichmentV1 | null) => void;
    exact?: ForgeReleaseV1;
    latest?: ForgeReleaseV1;
    assetPages?: readonly ForgeReleaseAssetPageV1[];
    readAssetPage?: (page: number) => Promise<ForgeReleaseAssetPageV1>;
    overview?: boolean;
    active?: boolean;
    target?: RenderContext['surface']['target'];
    executeAction?: PluginUiTestkitHostHandlers['executeAction'];
    notify?: PluginUiTestkitHostHandlers['notify'];
    sessionHelp?: ReleaseSessionHelpV1;
    withoutSessionHelp?: boolean;
    links?: string[];
    /** The host's app details pane beside the page (desktop); omitted, details push inside the page (phones). */
    detailsPane?: Readonly<{ available: boolean }>;
    locations?: unknown[];
    navigation?: Array<PluginUiPageNavigationV1 | null>;
  }>,
): Promise<PluginUiTestkit & { controls: ReturnType<typeof createPluginUiActionControlTestHost> }> {
  let fixture!: PluginUiTestkit;
  let published = false;
  const dispatch: NonNullable<PluginUiTestkitHostHandlers['executeAction']> = async request => {
          const { action, input } = request;
          const localId = (action as { localId: string }).localId;
          options.calls.push(localId);
          if (options.executeAction) return options.executeAction(request);
          if (localId === GITHUB_OVERVIEW_TARGET_ACTION_ID) return {
            kind: 'unavailable', failure: { class: 'transient', code: 'default-ref-unavailable' },
          };
          if (localId === GITHUB_RELEASE_ACTION_IDS_V1.listReleases) {
            if (options.listError) throw options.listError;
            return options.listResult ?? {
              kind: 'value',
              value: { ...emptyPage, rows: options.rows },
            } as JsonValue;
          }
          // The provider's latest is its own answer: here the stable release, not the newer rc.
          if (localId === GITHUB_RELEASE_ACTION_IDS_V1.readLatestRelease)
            return { kind: 'value', value: options.latest ?? STABLE } as JsonValue;
          if (localId === GITHUB_RELEASE_ACTION_IDS_V1.readRelease)
            return { kind: 'value', value: published ? { ...DRAFT, draft: false, publishedAt: DRAFT.updatedAt } : options.exact ?? DRAFT } as JsonValue;
          if (localId === GITHUB_RELEASE_ACTION_IDS_V1.publishReleaseDraft && options.lostPublish) {
            published = true;
            return { kind: 'outcome_unknown', releaseId: DRAFT.releaseId, webUrl: DRAFT.webUrl };
          }
          if (localId === GITHUB_RELEASE_ACTION_IDS_V1.listAssets && options.assetPages) {
            const index = input && typeof input === 'object' && 'cursor' in input ? 1 : 0;
            return { kind: 'value', value: options.readAssetPage ? await options.readAssetPage(index) : options.assetPages[index] } as JsonValue;
          }
          return {
            kind: 'unavailable',
            failure: { class: 'transient', code: 'not-under-test' },
          } as JsonValue;
        };
  const controls = createPluginUiActionControlTestHost(async ({ action, input }) => {
    if (typeof action !== 'object') throw new Error('Expected a declared GitHub release Action');
    switch (action.localId) {
      case GITHUB_RELEASE_ACTION_IDS_V1.createReleaseDraft: ForgeReleaseActionInputSchemasV1.createReleaseDraft.parse(input); break;
      case GITHUB_RELEASE_ACTION_IDS_V1.editReleaseDraft: ForgeReleaseActionInputSchemasV1.editReleaseDraft.parse(input); break;
      case GITHUB_RELEASE_ACTION_IDS_V1.publishReleaseDraft: ForgeReleaseActionInputSchemasV1.publishReleaseDraft.parse(input); break;
      default: throw new Error('Unexpected release write');
    }
    return { ok: true, result: await dispatch({ requestId: 'host-release-write', action, input }) };
  });
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: {
        instanceId: options.mountId ?? 'fixture-releases',
        mountNonce: 'fixture-releases-mount',
      },
      authorPlugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
      surface: (context: RenderContext) => {
        const live = { ...context,
          ...(options.lifetime ? { signal: options.lifetime.signal } : {}),
          ...(options.active === undefined ? {} : { activity: { active: options.active } }),
        };
        // The assistance consumer is mounted by the logic owner; a test supplies the same seam directly.
        const body = options.sessionHelp || options.withoutSessionHelp
          ? defineUiSurface(inner => <GithubReleasesPage context={inner} sessionHelp={options.sessionHelp} />)(live)
          : renderSurface(live);
        if (body !== null && !React.isValidElement(body))
          throw new Error('Expected a React-native author surface');
        return body;
      },
      surfaceContext: createSurfaceContextFixture({
        mountId: options.mountId ?? 'fixture-releases',
        mount: options.overview ? { kind: 'embedded', role: 'widget', presentation: 'content' } : {
          kind: 'destination',
          destination: {
            pluginId: GITHUB_PLUGIN_ID,
            localId: GITHUB_RELEASES_PAGE_ID_V1,
          },
          container: 'appPage',
        },
        target: options.target ?? {
          kind: 'project',
          projectKey: 'project-happier',
          repository,
          branch: 'v0.3',
        },
      }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true, ephemeralSharedScope: options.scope,
        ...(options.detailsPane ? { detailsPane: options.detailsPane } : {}) }),
      ...(options.subPath === undefined ? {} : { subPath: options.subPath }),
      handlers: {
        ...(options.notify ? { notify: options.notify } : {}),
        setPageNavigation: ({ navigation }) => { options.navigation?.push(navigation); },
        // Overview's CI reader first establishes the host-owned credential authority watch.
        // The test controls that system boundary; the read owner and query lifecycle remain real.
        watchResource: async ({ resource }) => {
          if (!options.overview || typeof resource !== 'object' || !('readAuthority' in resource))
            throw new PluginError({ code: 'unavailable' });
          return {};
        },
        publishCurrentUiContext: ({ enrichment }) => options.publish?.(enrichment),
        openExternalLink: async ({ url }) => { options.links?.push(`external:${url}`); },
        writeClipboard: async ({ value }) => { options.links?.push(`clipboard:${value}`); },
        replacePageLocation: async (request) => {
          const { subPath } = request;
          options.locations?.push({ subPath, backLocation: request.backLocation });
          await fixture.updatePageLocation(subPath);
          return subPath;
        },
        downloadFile: async request => { options.downloadCalls?.push(request); return options.downloadResult ?? { success: false, status: 'cancelled', error: 'Picker dismissed' }; },
        actionControl: controls.handler,
        executeAction: request => {
          const localId = typeof request.action === 'object' ? request.action.localId : request.action;
          if (localId === GITHUB_RELEASE_ACTION_IDS_V1.createReleaseDraft || localId === GITHUB_RELEASE_ACTION_IDS_V1.editReleaseDraft
            || localId === GITHUB_RELEASE_ACTION_IDS_V1.publishReleaseDraft) throw new Error('Release write must use the host control');
          return dispatch(request);
        },
      },
    });
  });
  mounted.push(fixture);
  return { ...fixture, controls };
}

function releaseActionUi(page: PluginUiTestkit): Parameters<PluginClientActionHandler>[1]['ui'] {
  return { ...page.context.hostApi, context: async options => {
    const context = await page.context.hostApi.context(options);
    return { accountScope: context.accountScope, targetedContributions: context.targetedContributions ?? null };
  } };
}

it('shows an untagged draft by name and preserves its native tag in the editor', async () => {
  const draft = { ...DRAFT, tagName: 'untagged-da5eefdb1d43cfcbac6c' };
  const page = await mountReleases({ rows: [draft], calls: [], exact: draft });
  const card = document.querySelector('[data-testid="github-releases-draft-card"]');
  expect(card?.textContent).toContain(draft.name);
  expect(card?.textContent).not.toContain(draft.tagName);
  await act(async () => { await page.press(await page.getByRole('button', { name: 'Open draft' })); });
  await page.findByRole('textbox', { label: 'Release name', value: draft.name });
  await page.findByRole('textbox', { label: 'Tag', value: draft.tagName });
});

async function createReleaseActionHost() {
  // The host scope and executable loader are boundaries; activation and mounted handlers stay real.
  const entries = new Map<string, { value: unknown; refs: number; dispose(): void }>();
  const scope: PluginEphemeralSharedScope = { acquire<T>(key: string, create: () => { value: T; dispose(): void }) {
    let entry = entries.get(key);
    if (!entry) { entry = { ...create(), refs: 0 }; entries.set(key, entry); }
    entry.refs++;
    return { value: entry.value as T, release() { if (--entry!.refs === 0) { entry!.dispose(); entries.delete(key); } } };
  } };
  const client = await createPluginClientTestkit({ manifest: PLUGIN_MANIFEST,
    target: { artifactId: 'github-forge-native', exportName: 'activate', platform: 'web' }, activate });
  mountedClients.push(client);
  const handler = client.registration('actions', GITHUB_RELEASE_MOUNTED_ACTION_ID_V1)!;
  return { scope, handler, invoke: (page: PluginUiTestkit, mountId: string, operation: JsonValue, signal = new AbortController().signal) => handler({ mountId, operation }, {
    plugin: page.context.plugin, contribution: { id: GITHUB_RELEASE_MOUNTED_ACTION_ID_V1, qualifiedId: `${GITHUB_PLUGIN_ID}/${GITHUB_RELEASE_MOUNTED_ACTION_ID_V1}` },
    invocationSurface: 'agent', signal, ui: releaseActionUi(page), ephemeralSharedScope: scope,
  }) };
}

describe('the Releases Project page', () => {
  it('keeps the single-view release story without an artificial page tab catalog', async () => {
    const calls: string[] = [];
    const navigation: Array<PluginUiPageNavigationV1 | null> = [];
    const page = await mountReleases({ rows: [RC4], exact: RC4, calls, subPath: RC4.releaseId, navigation });
    expect(await page.getAllByRole('button', { name: `Download ${RC4.assets.rows[0]!.name}` })).not.toHaveLength(0);
    expect(await page.queryAllByRole('tab')).toHaveLength(0);
    expect(navigation).toEqual([]);
  });

  it('uses the surviving mount authority for a new exact read after the shared reader creator retires', async () => {
    const { scope } = await createReleaseActionHost();
    const creatorCalls: string[] = [];
    const survivorCalls: string[] = [];
    const creator = await mountReleases({ rows: [STABLE], calls: creatorCalls, scope, mountId: 'read-creator' });
    const survivor = await mountReleases({ rows: [STABLE], calls: survivorCalls, scope, mountId: 'read-survivor', exact: RC4 });
    await act(async () => { await creator.dispose(); });
    const creatorReadsBefore = creatorCalls.length;
    await act(async () => { await survivor.updatePageLocation(RC4.releaseId); });
    // The shared corpus is not authority to invoke a retired physical host.
    // The exact read must cross the surviving mount's real testkit boundary.
    expect(survivorCalls).toContain(GITHUB_RELEASE_ACTION_IDS_V1.readRelease);
    expect(creatorCalls).toHaveLength(creatorReadsBefore);
  });

  it.each([
    { listError: new PluginError({ code: 'unavailable', details: { layer: 'placement', phase: 'admission' },
      diagnostics: [{ code: 'plugin_action_origin_unavailable', severity: 'error' }] }),
      expected: 'plugin_action_origin_unavailable' },
    { listResult: { kind: 'unavailable', failure: { class: 'transient', code: 'github_server_error', detail: 'status=503', requestId: 'release-read-request' } },
      expected: 'github_server_error status=503 release-read-request' },
  ])('shows exact mounted refusal or provider details: $expected', async ({ expected, ...response }) => {
    const calls: string[] = [];
    const page = await mountReleases({ rows: [], calls, ...response });
    await act(async () => { await page.press(await page.getByRole('button', { name: 'Details' })); });
    await page.getByText(expected);
    expect(calls.filter(id => id === GITHUB_RELEASE_ACTION_IDS_V1.listReleases)).toHaveLength(1);
  });

  it('clears a lost publish after the real Check status control establishes the exact published target', async () => {
    const calls: string[] = [];
    const page = await mountReleases({ rows: [DRAFT, RC4], calls, subPath: DRAFT.releaseId, lostPublish: true,
      assetPages: [DRAFT.assets] });
    await act(async () => { await page.controls.press('Publish…'); });
    await page.getByText('Result unknown — check on GitHub');
    expect(calls.filter(id => id === GITHUB_RELEASE_ACTION_IDS_V1.publishReleaseDraft)).toHaveLength(1);
    await act(async () => { await page.press(await page.getByRole('button', { name: 'Check status' })); });
    expect(await page.queryByText('Result unknown — check on GitHub')).toBeUndefined();
    expect(calls.filter(id => id === GITHUB_RELEASE_ACTION_IDS_V1.publishReleaseDraft)).toHaveLength(1);
    // Establishment also invalidates the canonical latest consumer, not just hides the old banner.
    expect(calls.filter(id => id === GITHUB_RELEASE_ACTION_IDS_V1.readLatestRelease)).toHaveLength(2);
  });
  it('reaches Project Overview through its embedded artifact', async () => {
    const calls: string[] = [];
    await mountReleases({ rows: [DRAFT, RC4, STABLE], calls, overview: true });
    expect(calls.filter(id => id === GITHUB_OVERVIEW_TARGET_ACTION_ID)).toHaveLength(1);
  });

  it('withdraws the old repository CI demand while the next Overview default ref is pending', async () => {
    const nextRepository = { ...repository, repository: 'happier-dev/another-project' };
    const requests: Parameters<NonNullable<PluginUiTestkitHostHandlers['executeAction']>>[0][] = [];
    let settleDefault!: (value: JsonValue) => void;
    const pendingDefault = new Promise<JsonValue>(resolve => { settleDefault = resolve; });
    let settleRuns!: (value: JsonValue) => void;
    const pendingRuns = new Promise<JsonValue>(resolve => { settleRuns = resolve; });
    const page = await mountReleases({ rows: [], calls: [], overview: true, executeAction: async (request): Promise<JsonValue> => {
      requests.push(request);
      const localId = typeof request.action === 'object' ? request.action.localId : request.action;
      if (localId === GITHUB_OVERVIEW_TARGET_ACTION_ID) {
        const selected = request.input && typeof request.input === 'object' && 'repository' in request.input ? request.input.repository : null;
        if (selected && typeof selected === 'object' && 'repository' in selected && selected.repository === repository.repository)
          return { kind: 'value', value: { repository, branch: 'main', headSha: 'a'.repeat(40) } };
        return pendingDefault;
      }
      if (localId === GITHUB_CI_ACTION_IDS_V1.listRuns) return pendingRuns;
      return { kind: 'unavailable', failure: { class: 'transient', code: 'not-under-test' } };
    } });
    try {
      const runs = requests.filter(request => typeof request.action === 'object' && request.action.localId === GITHUB_CI_ACTION_IDS_V1.listRuns);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.signal.aborted).toBe(false);
      await act(async () => { await page.updateSurface({ ...page.context.surface,
        target: { kind: 'project', projectKey: 'project-happier', repository: { ...repository } } }); });
      expect(requests.filter(request => typeof request.action === 'object' && request.action.localId === GITHUB_OVERVIEW_TARGET_ACTION_ID)).toHaveLength(1);
      expect(runs[0]!.signal.aborted).toBe(false);
      await act(async () => { await page.updateSurface({ ...page.context.surface,
        target: { kind: 'project', projectKey: 'another-project', repository: nextRepository } }); });
      expect(runs[0]!.signal.aborted).toBe(true);
      expect(requests.filter(request => typeof request.action === 'object' && request.action.localId === GITHUB_CI_ACTION_IDS_V1.listRuns)).toHaveLength(1);
      await act(async () => { settleDefault({ kind: 'value', value: { repository: nextRepository, branch: 'next', headSha: 'b'.repeat(40) } }); });
      const nextRuns = requests.filter(request => typeof request.action === 'object' && request.action.localId === GITHUB_CI_ACTION_IDS_V1.listRuns);
      expect(nextRuns).toHaveLength(2);
      expect(nextRuns[1]!.input).toEqual({ repository: nextRepository, filters: { branch: 'next', headSha: 'b'.repeat(40) } });
    } finally {
      await act(async () => {
        settleDefault({ kind: 'unavailable', failure: { class: 'transient', code: 'not-under-test' } });
        settleRuns({ kind: 'unavailable', failure: { class: 'transient', code: 'not-under-test' } });
      });
    }
  });

  it('cancels an Overview default-ref read on renderer retirement without starting late CI reads', async () => {
    const lifetime = new AbortController();
    const calls: string[] = [];
    let signal: AbortSignal | undefined;
    let settle!: (value: JsonValue) => void;
    const pending = new Promise<JsonValue>(resolve => { settle = resolve; });
    await mountReleases({ rows: [], calls, overview: true, lifetime, executeAction: request => {
      const localId = typeof request.action === 'object' ? request.action.localId : request.action;
      if (localId === GITHUB_OVERVIEW_TARGET_ACTION_ID) { signal = request.signal; return pending; }
      return { kind: 'unavailable', failure: { class: 'transient', code: 'not-under-test' } };
    } });
    try {
      expect(signal?.aborted).toBe(false);
      await act(async () => { lifetime.abort(); });
      expect(signal?.aborted).toBe(true);
    } finally {
      await act(async () => { settle({ kind: 'value', value: { repository, branch: 'main', headSha: 'a'.repeat(40) } }); });
    }
    expect(calls).not.toContain(GITHUB_CI_ACTION_IDS_V1.listRuns);
  });

  it('reads latest for Project Overview without a draft or list lookup', async () => {
    const calls: string[] = [];
    await mountReleases({ rows: [DRAFT, RC4, STABLE], calls, overview: true });
    expect(calls.filter(id => id === GITHUB_RELEASE_ACTION_IDS_V1.readLatestRelease)).toHaveLength(1);
    expect(calls).not.toContain(GITHUB_RELEASE_ACTION_IDS_V1.listReleases);
    expect(calls).not.toContain(GITHUB_RELEASE_ACTION_IDS_V1.readRelease);
  });

  it.each(['empty', 'incomplete-empty', 'partial', 'unknown-downloads', 'complete'] as const)(
    'reports asset facts only when the release snapshot establishes them: %s', async (kind) => {
      const { downloadCount: _downloadCount, ...unknownDownloads } = STABLE.assets.rows[0]!;
      const assets: ForgeReleaseAssetPageV1 = kind === 'empty' ? emptyPage
        : kind === 'incomplete-empty' ? { ...emptyPage, incomplete: 'pagination' }
          : kind === 'partial' ? { ...STABLE.assets, incomplete: 'pagination' }
            : kind === 'unknown-downloads' ? { ...STABLE.assets, rows: [unknownDownloads] }
              : STABLE.assets;
      const release = createForgeReleaseV1Fixture({ ...STABLE, assets });
      const overview = await mountReleases({ rows: [], calls: [], overview: true, latest: release });
      await overview.getByText(release.tagName);
      const count = kind === 'empty' ? '0 assets' : kind === 'incomplete-empty' || kind === 'partial' ? null : '1 assets';
      if (count !== null) await overview.getByText(`Leeroy Brun · ${count}`);
      else {
        expect.soft(await overview.queryByText('Leeroy Brun · 0 assets')).toBeUndefined();
        expect.soft(await overview.queryByText('Leeroy Brun · 1 assets')).toBeUndefined();
      }
      const page = await mountReleases({ rows: [release], calls: [], latest: release });
      await page.getByText(release.name!);
      const story = document.querySelector('[data-testid="github-releases-newest"]')?.textContent;
      expect(story).toBeDefined();
      expect(story?.includes('No assets, only the source code archives GitHub adds.')).toBe(kind === 'empty');
      expect(story?.includes('plus source code · 1,284 downloads')).toBe(kind === 'complete');
    },
  );

  it.each([{ active: false }, { target: { kind: 'app' as const } }])('does not acquire release data for hidden or unqualified Overview demand: %o', async (state) => {
    const calls: string[] = [];
    await mountReleases({ rows: [DRAFT, RC4, STABLE], calls, overview: true, ...state });
    expect(calls).not.toContain(GITHUB_RELEASE_ACTION_IDS_V1.readLatestRelease);
    expect(calls).not.toContain(GITHUB_RELEASE_ACTION_IDS_V1.listReleases);
    expect(calls).not.toContain(GITHUB_RELEASE_ACTION_IDS_V1.readRelease);
  });

  it('binds the registered Action to the displayed editor and current-context command, isolating and retiring physical mounts', async () => {
    const { scope, handler, invoke: invokeAction } = await createReleaseActionHost();
    const calls: string[] = [];
    const published: { value: PluginUiContextEnrichmentV1 | null } = { value: null };
    const lifetime = new AbortController();
    const page = await mountReleases({ rows: [DRAFT, RC4, STABLE], calls, subPath: 'compose', mountId: 'release-one', scope, lifetime,
      publish: value => { published.value = value; } });
    const peer = await mountReleases({ rows: [DRAFT, RC4, STABLE], calls, subPath: 'compose', mountId: 'release-two', scope, exact: STABLE });
    const invoke = (mountId: string, operation: JsonValue) => invokeAction(page, mountId, operation);
    await act(async () => {
      await page.press(await page.getByRole('button', { name: 'Write my own' }));
      await peer.press(await peer.getByRole('button', { name: 'Write my own' }));
    });
    await page.findByRole('textbox', { label: 'Release notes' });
    const providerReads = calls.length;
    await act(async () => { expect(await invoke('release-one', { kind: 'setField', field: 'body', value: 'Agent-authored unsaved notes' })).toEqual({ status: 'applied' }); });
    await page.getByRole('textbox', { label: 'Release notes', value: 'Agent-authored unsaved notes' });
    await peer.getByRole('textbox', { label: 'Release notes', value: '## Highlights\n\n- ' });
    // Repeated local setters, including semantic no-ops, perform no provider reads or writes.
    await act(async () => { for (let i = 0; i < 30; i++) await invoke('release-one', { kind: 'setField', field: 'body', value: 'Agent-authored unsaved notes' }); });
    expect(calls.length).toBe(providerReads);
    expect(published.value?.detail).toMatchObject({ mountId: 'release-one', fields: { body: 'Agent-authored unsaved notes' }, preview: false, dirty: true });
    expect(await invoke('release-one', { kind: 'setField', field: 'body', value: 'refused', unexpected: true })).toEqual({ status: 'rejected' });
    const preview = published.value?.commands?.find(command => command.command.kind === 'executeAction'
      && command.command.action === GITHUB_RELEASE_MOUNTED_ACTION_ID_V1);
    expect(preview?.command.kind).toBe('executeAction');
    if (!preview || preview.command.kind !== 'executeAction') throw new Error('Missing current-context preview command');
    await act(async () => { expect(await handler(preview.command.input!, { plugin: page.context.plugin,
      contribution: { id: GITHUB_RELEASE_MOUNTED_ACTION_ID_V1, qualifiedId: `${GITHUB_PLUGIN_ID}/${GITHUB_RELEASE_MOUNTED_ACTION_ID_V1}` }, invocationSurface: 'agent',
      signal: new AbortController().signal, ui: releaseActionUi(page), ephemeralSharedScope: scope })).toEqual({ status: 'applied' }); });
    expect(await page.queryByRole('textbox', { label: 'Release notes' })).toBeUndefined();
    await page.getByText('Agent-authored unsaved notes');
    await act(async () => { lifetime.abort(); });
    expect(await invoke('release-one', { kind: 'setPreview', value: false })).toEqual({ status: 'unavailable' });
    expect(published.value).toBeNull();
    await act(async () => { expect(await invoke('release-two', { kind: 'setField', field: 'name', value: 'Peer only' })).toEqual({ status: 'applied' }); });
    await peer.getByRole('textbox', { label: 'Release name', value: 'Peer only' });
    expect(await invoke('release-two', { kind: 'selectRelease', releaseId: DRAFT.releaseId })).toEqual({ status: 'rejected' });
    await act(async () => { await peer.updatePageLocation(''); });
    expect(await peer.queryByRole('button', { name: `Download ${STABLE.assets.rows[0]!.name}` })).toBeUndefined();
    await act(async () => { expect(await invoke('release-two', { kind: 'setExpanded', releaseId: STABLE.releaseId, value: true })).toEqual({ status: 'applied' }); });
    await peer.getByRole('button', { name: `Download ${STABLE.assets.rows[0]!.name}` });
    // Collapsing returns the release to its pane; the operandless close leaves the list.
    await act(async () => { expect(await invoke('release-two', { kind: 'setExpanded', releaseId: STABLE.releaseId, value: false })).toEqual({ status: 'applied' }); });
    await peer.getByRole('button', { name: `Download ${STABLE.assets.rows[0]!.name}` });
    await act(async () => { expect(await invoke('release-two', { kind: 'command', command: 'close' })).toEqual({ status: 'applied' }); });
    expect(await peer.queryByRole('button', { name: `Download ${STABLE.assets.rows[0]!.name}` })).toBeUndefined();
    await act(async () => { expect(await invoke('release-two', { kind: 'setFilter', state: 'prereleases' })).toEqual({ status: 'applied' }); });
    expect(await peer.queryByRole('button', { name: 'v0.2.14 Voice on Android' })).toBeUndefined();
    await act(async () => { expect(await invoke('release-two', { kind: 'setFilter', state: 'all' })).toEqual({ status: 'applied' });
      expect(await invoke('release-two', { kind: 'setSearch', query: 'Release candidate 4' })).toEqual({ status: 'applied' }); });
    await peer.getByText('Release candidate 4');
    expect(await peer.queryByRole('button', { name: 'v0.2.14 Voice on Android' })).toBeUndefined();
    await act(async () => { await peer.dispose(); });
    expect(await invoke('release-two', { kind: 'setField', field: 'name', value: 'retired' })).toEqual({ status: 'unavailable' });
  });
  it.each(['invocation', 'renderer'] as const)('does not publish an awaited asset page after %s retirement', async (retirement) => {
    const { scope, invoke } = await createReleaseActionHost();
    const lifetime = new AbortController();
    const caller = new AbortController();
    const first = { ...emptyPage, rows: DRAFT.assets.rows, continuation: 'next' };
    const last = { ...emptyPage, rows: [{ ...DRAFT.assets.rows[0]!, assetId: '9999', name: 'retired-response.zip' }] };
    let settle!: (value: ForgeReleaseAssetPageV1) => void;
    const deferred = new Promise<ForgeReleaseAssetPageV1>(resolve => { settle = resolve; });
    let entered!: () => void;
    const requested = new Promise<void>(resolve => { entered = resolve; });
    const page = await mountReleases({ rows: [DRAFT], calls: [], mountId: 'asset-retirement', scope, lifetime,
      subPath: DRAFT.releaseId, exact: { ...DRAFT, assets: { ...emptyPage, incomplete: 'pagination' } },
      assetPages: [first, last], readAssetPage: async index => { if (index === 0) return first; entered(); return deferred; } });
    await page.findByRole('button', { name: 'Show all assets' });
    let pending!: ReturnType<typeof invoke>;
    await act(async () => { pending = invoke(page, 'asset-retirement', { kind: 'loadMore', resource: 'assets' }, caller.signal); await requested; });
    try {
      await act(async () => { (retirement === 'renderer' ? lifetime : caller).abort(); settle(last);
        expect(await pending).toEqual({ status: 'unavailable' }); });
      expect(await page.queryByRole('button', { name: 'Download retired-response.zip' })).toBeUndefined();
      if (retirement === 'invocation') {
        await act(async () => { expect(await invoke(page, 'asset-retirement', { kind: 'loadMore', resource: 'assets' })).toEqual({ status: 'applied' }); });
        await page.getByRole('button', { name: 'Download retired-response.zip' });
      }
    } finally { settle(last); await pending; }
  });
  it('opens an exact draft outside the loaded list without walking history', async () => {
    const exact = release('999', 'v9', 'Exact older draft', { draft: true, day: '2026-10-01T00:00:00Z' });
    const calls: string[] = [];
    const page = await mountReleases({ rows: [RC4], calls, subPath: exact.releaseId, exact });
    expect(calls).toContain(GITHUB_RELEASE_ACTION_IDS_V1.readRelease);
    await page.findByRole('textbox', { label: 'Release name', value: 'Exact older draft' });
    expect(calls.filter(id => id === GITHUB_RELEASE_ACTION_IDS_V1.listReleases)).toHaveLength(1);
    expect(calls).toContain(GITHUB_RELEASE_ACTION_IDS_V1.readRelease);
  });

  it.each([false, true])('opens a published exact desktop route independently of an empty list: %s', async empty => {
    const exact = release('999', 'v9', 'Exact published release', { day: '2026-10-01T00:00:00Z' });
    const calls: string[] = [];
    const page = await mountReleases({ rows: empty ? [] : [RC4], calls, subPath: `${exact.releaseId}/page`, exact });
    await page.getByText('Exact published release');
    await page.getByRole('button', { name: `Download ${exact.assets.rows[0]!.name}` });
    expect(await page.queryByRole('button', { name: 'Draft first release' })).toBeUndefined();
    expect(calls.filter(id => id === GITHUB_RELEASE_ACTION_IDS_V1.readRelease)).toHaveLength(1);
    expect(calls.filter(id => id === GITHUB_RELEASE_ACTION_IDS_V1.listReleases)).toHaveLength(1);
    await act(async () => { await page.updatePageLocation(''); });
    expect(await page.queryByRole('button', { name: `Download ${exact.assets.rows[0]!.name}` })).toBeUndefined();
  });

  it('gives the expanded release page a way back to its pane, a refresh that re-reads it, and links out', async () => {
    const exact = release('999', 'v9', 'Exact published release', { day: '2026-10-01T00:00:00Z' });
    const calls: string[] = [];
    const links: string[] = [];
    const locations: unknown[] = [];
    const page = await mountReleases({ rows: [RC4], calls, subPath: `${exact.releaseId}/page`, exact, links, locations, detailsPane: { available: true } });
    await page.getByRole('button', { name: `Download ${exact.assets.rows[0]!.name}` });
    await act(async () => { await page.press(await page.getByRole('button', { name: 'Refresh releases' })); });
    expect(calls.filter(id => id === GITHUB_RELEASE_ACTION_IDS_V1.readRelease)).toHaveLength(2);
    await act(async () => { await page.press(await page.getByRole('button', { name: 'More release actions' })); });
    await act(async () => { await page.press(await page.getByRole('menuitem', { name: 'Copy link' })); });
    expect(links).toEqual([`clipboard:${exact.webUrl}`]);
    await act(async () => { await page.press(await page.getByRole('button', { name: 'Releases' })); });
    expect(locations).toEqual([{ subPath: exact.releaseId, backLocation: '' }]);
    await page.getByText('Release candidate 4');
    await page.getByRole('button', { name: 'Open as page' });
    expect(await page.queryByRole('button', { name: 'Releases' })).toBeUndefined();
  });

  it('hydrates an untouched compose deep-link seed after the first release page arrives', async () => {
    let settle!: (value: JsonValue) => void;
    const pending = new Promise<JsonValue>(resolve => { settle = resolve; });
    const calls: string[] = [];
    const page = await mountReleases({ rows: [], calls, subPath: 'compose', executeAction: async (request): Promise<JsonValue> => {
      const id = (request.action as { localId: string }).localId;
      return id === GITHUB_RELEASE_ACTION_IDS_V1.listReleases ? pending : { kind: 'value', value: STABLE };
    } });
    await act(async () => { settle({ kind: 'value', value: { ...emptyPage, rows: [RC4] } }); await pending; });
    await page.findByRole('textbox', { label: 'Tag', value: 'v0.3.0-rc.5' });
    await page.findByRole('textbox', { label: 'Changes since', value: RC4.tagName });
    const generate = await page.getByRole('button', { name: 'Generate from changes' });
    await act(async () => { await page.press(generate); });
    expect(calls).toContain(GITHUB_RELEASE_ACTION_IDS_V1.generateReleaseNotes);
    expect(calls.filter(id => id === GITHUB_RELEASE_ACTION_IDS_V1.listReleases)).toHaveLength(1);
  });

  it.each(['draft', 'notes'] as const)('mounts the configured session-help consumer for %s without eager handoff reads', async kind => {
    const calls: string[] = [];
    const handoffs: JsonValue[] = [];
    const selection = { configuredActionId: 'release-review', sessionChoice: { kind: 'new' }, agentChoice: { kind: 'configured' }, delivery: 'compose' } as const;
    const page = await mountReleases({ rows: kind === 'draft' ? [RC4] : [DRAFT, RC4], calls,
      executeAction: async (request): Promise<JsonValue> => {
        const id = (request.action as { localId: string }).localId;
        if (id === GITHUB_RELEASE_ACTION_IDS_V1.listReleases) return { kind: 'value', value: { ...emptyPage, rows: kind === 'draft' ? [RC4] : [DRAFT, RC4] } };
        if (id === GITHUB_RELEASE_ACTION_IDS_V1.readLatestRelease) return { kind: 'value', value: STABLE };
        if (id === 'actions/read-v1') return { v: 1, kind: 'choices', defaultActionId: 'release-review', actions: [
          { label: 'Not the default', selection: { ...selection, configuredActionId: 'other' } }, { label: 'Release review', selection },
        ] };
        if (id === GITHUB_RELEASE_ACTION_IDS_V1.readNotesContext) {
          const input = request.input as { selector: JsonValue };
          return { kind: 'value', value: { kind: 'releaseNotes', repository, selector: input.selector, contextText: 'Selected facts' } };
        }
        if (id === 'sessions/run-configured-v1') {
          handoffs.push(request.input ?? null);
          return { v: 1, handoff: { kind: 'composed', destination: { kind: 'newSessionDraft' } } };
        }
        throw new Error(`Unexpected Action ${id}`);
      } });
    expect(calls).not.toContain('actions/read-v1');
    await act(async () => { await page.press(await page.getByRole('button', { name: kind === 'draft' ? 'Draft in a session' : 'Notes help in a session' })); });
    expect(calls.slice(-3)).toEqual(['actions/read-v1', GITHUB_RELEASE_ACTION_IDS_V1.readNotesContext, 'sessions/run-configured-v1']);
    expect(handoffs).toMatchObject([{ handoff: { ...selection, task: 'draftReleaseNotes', evidence: [{ selector: kind === 'draft'
      ? { kind: 'proposed', tagName: 'v0.3.0-rc.5', targetCommitish: 'v0.3', previousTagName: RC4.tagName }
      : { kind: 'existingDraft', releaseId: DRAFT.releaseId } }] } }]);
  });

  it('offers the session entry points only where a handoff is mounted, and hands over the intent', async () => {
    const without = await mountReleases({ rows: [RC4], calls: [], withoutSessionHelp: true });
    await without.findByRole('button', { name: 'Draft release' });
    expect(await without.queryByRole('button', { name: 'Draft in a session' })).toBeUndefined();

    const intents: unknown[] = [];
    const sessionHelp: ReleaseSessionHelpV1 = async intent => { intents.push(intent); };
    const next = await mountReleases({ rows: [RC4], calls: [], sessionHelp });
    await act(async () => { await next.press(await next.findByRole('button', { name: 'Draft in a session' })); });
    expect(intents).toEqual([{ kind: 'draft' }]);

    const draft = await mountReleases({ rows: [DRAFT, RC4], calls: [], sessionHelp });
    await act(async () => { await draft.press(await draft.findByRole('button', { name: 'Notes help in a session' })); });
    expect(intents.at(-1)).toEqual({ kind: 'notes', releaseId: DRAFT.releaseId });

    const editor = await mountReleases({ rows: [RC4], calls: [], subPath: 'compose', sessionHelp });
    await act(async () => { await editor.press(await editor.findByRole('button', { name: 'Notes help in a session' })); });
    expect(intents.at(-1)).toEqual({ kind: 'notes', releaseId: null });
  });

  it('retains an exact route reader failure instead of presenting the list', async () => {
    const calls: string[] = [];
    const page = await mountReleases({ rows: [RC4], calls, subPath: '999/page', executeAction: async (request): Promise<JsonValue> => {
      const id = (request.action as { localId: string }).localId;
      if (id === GITHUB_RELEASE_ACTION_IDS_V1.readRelease) return {
        kind: 'unavailable', failure: { class: 'transient', code: 'exact_release_read_refused' },
      };
      return id === GITHUB_RELEASE_ACTION_IDS_V1.listReleases
        ? { kind: 'value', value: { ...emptyPage, rows: [RC4] } } as JsonValue
        : { kind: 'value', value: STABLE } as JsonValue;
    } });
    await act(async () => { await page.press(await page.getByRole('button', { name: 'Details' })); });
    await page.getByText('exact_release_read_refused');
    expect(calls.filter(id => id === GITHUB_RELEASE_ACTION_IDS_V1.readRelease)).toHaveLength(1);
    // In the pane the same failure stays with the release, and the list beside it keeps working.
    await act(async () => { await page.updatePageLocation('999'); });
    await page.getByText('Couldn’t read this release');
    await page.getByText('Release candidate 4');
  });

  it('requests asset metadata only for the selected release and follows the selected continuation', async () => {
    const exact: ForgeReleaseV1 = { ...DRAFT, assets: { ...emptyPage, rows: [], incomplete: 'pagination' } };
    const first = { ...emptyPage, rows: DRAFT.assets.rows, continuation: 'next' };
    const last = { ...emptyPage, rows: [{ ...DRAFT.assets.rows[0]!, assetId: '9999', name: 'remaining-asset.zip' }] };
    const calls: string[] = [];
    const page = await mountReleases({ rows: [DRAFT, RC4], exact, calls, subPath: DRAFT.releaseId, assetPages: [first, last] });
    expect(calls).toContain(GITHUB_RELEASE_ACTION_IDS_V1.listAssets);
    await act(async () => { await page.press(await page.findByRole('button', { name: 'Show all assets' })); });
    await page.findByRole('button', { name: 'Download remaining-asset.zip' });
    expect(calls.filter(id => id === GITHUB_RELEASE_ACTION_IDS_V1.listAssets)).toHaveLength(2);
    expect(calls).not.toContain(GITHUB_RELEASE_ACTION_IDS_V1.downloadAsset);
  });

  it('keeps unsaved notes across external Back and return to compose', async () => {
    const page = await mountReleases({ rows: [RC4], calls: [], subPath: 'compose' });
    await page.getByText('New release');
    await act(async () => { await page.press(await page.getByRole('button', { name: 'Write my own' })); });
    const textarea = document.querySelector('textarea');
    if (!textarea) throw new Error('Expected the real notes field');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(textarea, 'My unsubmitted release notes');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.getByRole('textbox', { label: 'Release notes', value: 'My unsubmitted release notes' });
    await act(async () => { await page.updatePageLocation(''); });
    await act(async () => { await page.updatePageLocation('compose'); });
    await page.getByRole('textbox', { label: 'Release notes', value: 'My unsubmitted release notes' });
  });

  it.each(['page', 'editor'] as const)('retains a failed asset download visibly through the %s entry point', async (entry) => {
    const page = await mountReleases({ rows: [DRAFT, RC4, STABLE], calls: [],
      ...(entry === 'editor' ? { subPath: DRAFT.releaseId } : {}),
      downloadResult: { success: false, status: 'failed', error: 'The destination is read-only', errorCode: 'EACCES' } });
    const asset = (entry === 'editor' ? DRAFT : RC4).assets.rows[0]!;
    const button = await page.findByRole('button', { name: `Download ${asset.name}` });
    await act(async () => { await page.press(button); });
    await page.getByText('The destination is read-only');
  });

  it('opens a release in the Project details pane, expands it to a page and returns to the same pane on one exact read', async () => {
    const thin: ForgeReleaseV1 = { ...STABLE, assets: { ...emptyPage, rows: [], incomplete: 'pagination' } };
    const calls: string[] = [];
    const locations: unknown[] = [];
    const page = await mountReleases({ rows: [DRAFT, RC4, thin], calls, exact: STABLE, detailsPane: { available: true }, locations });
    await act(async () => { await page.press(await page.findByRole('button', { name: 'v0.2.14 Voice on Android' })); });
    expect(locations).toEqual([{ subPath: STABLE.releaseId, backLocation: '' }]);
    await page.findByRole('button', { name: `Download ${STABLE.assets.rows[0]!.name}` });
    // The list stays beside the pane: the next release is still there.
    await page.getByText('Release candidate 5');
    await act(async () => { await page.press(await page.getByRole('button', { name: 'Open as page' })); });
    expect(locations.at(-1)).toEqual({ subPath: `${STABLE.releaseId}/page`, backLocation: STABLE.releaseId });
    await page.getByRole('button', { name: `Download ${STABLE.assets.rows[0]!.name}` });
    expect(await page.queryByText('Release candidate 5')).toBeUndefined();
    await act(async () => { await page.press(await page.getByRole('button', { name: 'Releases' })); });
    expect(locations.at(-1)).toEqual({ subPath: STABLE.releaseId, backLocation: '' });
    await page.getByText('Release candidate 5');
    await page.getByRole('button', { name: `Download ${STABLE.assets.rows[0]!.name}` });
    // Pane, page and return share the one exact read.
    expect(calls.filter(id => id === GITHUB_RELEASE_ACTION_IDS_V1.readRelease)).toHaveLength(1);
    await act(async () => { await page.press(await page.getByRole('button', { name: 'Close details' })); });
    expect(locations.at(-1)).toEqual({ subPath: '', backLocation: '' });
    expect(await page.queryByRole('button', { name: `Download ${STABLE.assets.rows[0]!.name}` })).toBeUndefined();
  });

  it('pushes the release inside the page where no pane sits beside it, with its own way back', async () => {
    const thin: ForgeReleaseV1 = { ...STABLE, assets: { ...emptyPage, rows: [], incomplete: 'pagination' } };
    const calls: string[] = [];
    const locations: unknown[] = [];
    const page = await mountReleases({ rows: [DRAFT, RC4, thin], calls, exact: STABLE, locations });
    await act(async () => { await page.press(await page.findByRole('button', { name: 'v0.2.14 Voice on Android' })); });
    expect(locations).toEqual([{ subPath: STABLE.releaseId, backLocation: '' }]);
    await page.findByRole('button', { name: `Download ${STABLE.assets.rows[0]!.name}` });
    await act(async () => { await page.press(await page.getByRole('button', { name: 'Back' })); });
    expect(locations.at(-1)).toEqual({ subPath: '', backLocation: '' });
  });

  it('keeps local drafting after a denied refresh, says what GitHub requires, and shows the Save refusal', async () => {
    const calls: string[] = [];
    let lists = 0;
    const page = await mountReleases({ rows: [RC4], calls, executeAction: async ({ action }): Promise<JsonValue> => {
      const localId = (action as { localId: string }).localId;
      if (localId === GITHUB_RELEASE_ACTION_IDS_V1.listReleases) return ++lists === 1
        ? { kind: 'value', value: { ...emptyPage, rows: [RC4] } } as JsonValue
        : { kind: 'unavailable', failure: { class: 'permission', code: 'github_insufficient_scope', detail: 'contents=read' } };
      if (localId === GITHUB_RELEASE_ACTION_IDS_V1.readLatestRelease) return { kind: 'value', value: null };
      if (localId === GITHUB_RELEASE_ACTION_IDS_V1.createReleaseDraft) return { kind: 'rejected',
        failure: { class: 'permission', code: 'github_insufficient_scope', detail: 'contents=write' } };
      return { kind: 'unavailable', failure: { class: 'transient', code: 'not-under-test' } };
    } });
    await page.getByText('Release candidate 4');
    await act(async () => { await page.press(await page.getByRole('button', { name: 'Refresh releases' })); });
    await page.getByText('GitHub refused the latest read. It requires Contents: read.');
    // A denied read is not a write verdict: Draft release stays a working control.
    await act(async () => { await page.press(await page.getByRole('button', { name: 'Draft release' })); });
    await act(async () => { await page.press(await page.findByRole('button', { name: 'Write my own' })); });
    await act(async () => { await page.controls.press('Save draft'); });
    expect(calls.filter(id => id === GITHUB_RELEASE_ACTION_IDS_V1.createReleaseDraft)).toHaveLength(1);
    await page.getByText('GitHub requires Contents: write to save this release. Your notes stay here; nothing was saved.');
    await page.getByRole('textbox', { label: 'Release notes', value: '## Highlights\n\n- ' });
  });

  it('lets the person choose a configured session action when none is the default, and sends nothing on dismiss', async () => {
    const selection = (configuredActionId: string) => ({ configuredActionId, sessionChoice: { kind: 'new' }, agentChoice: { kind: 'configured' }, delivery: 'compose' });
    const calls: string[] = [];
    const handoffs: unknown[] = [];
    const page = await mountReleases({ rows: [RC4], calls, executeAction: async ({ action, input }): Promise<JsonValue> => {
      const localId = (action as { localId: string }).localId;
      if (localId === 'actions/read-v1') return { v: 1, kind: 'choices', defaultActionId: null,
        actions: [{ label: 'Release notes review', selection: selection('release-review') }, { label: 'Changelog writer', selection: selection('changelog') }] };
      if (localId === GITHUB_RELEASE_ACTION_IDS_V1.listReleases) return { kind: 'value', value: { ...emptyPage, rows: [RC4] } } as JsonValue;
      if (localId === GITHUB_RELEASE_ACTION_IDS_V1.readLatestRelease) return { kind: 'value', value: RC4 } as JsonValue;
      if (localId === GITHUB_RELEASE_ACTION_IDS_V1.readNotesContext) return { kind: 'value', value: {
        kind: 'releaseNotes', repository, selector: { kind: 'proposed', tagName: 'v0.3.0-rc.5', targetCommitish: 'v0.3' }, contextText: 'Selected facts' } };
      if (localId === 'sessions/run-configured-v1') { handoffs.push(input); return { v: 1, handoff: { kind: 'composed', destination: { kind: 'newSessionDraft' } } }; }
      return { kind: 'unavailable', failure: { class: 'transient', code: 'not-under-test' } };
    } });
    await act(async () => { await page.press(await page.findByRole('button', { name: 'Draft in a session' })); });
    // No default: the configured actions are offered, and none is taken on the person's behalf.
    await page.findByRole('menuitem', { name: 'Changelog writer' });
    expect(handoffs).toEqual([]);
    await act(async () => { await page.press(await page.getByRole('menuitem', { name: 'Changelog writer' })); });
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]).toMatchObject({ handoff: { configuredActionId: 'changelog', task: 'draftReleaseNotes' } });
    expect(await page.queryByRole('menuitem', { name: 'Release notes review' })).toBeUndefined();
    await act(async () => { await page.press(await page.getByRole('button', { name: 'Draft in a session' })); });
    await page.findByRole('menuitem', { name: 'Release notes review' });
    expect(handoffs).toHaveLength(1);
  });

  it('drives the editor’s guard, conflict, uncertain-result and generated-proposal transitions through the mounted Action', async () => {
    const { scope, invoke } = await createReleaseActionHost();
    const calls: string[] = [];
    const locations: unknown[] = [];
    const published: { value: PluginUiContextEnrichmentV1 | null } = { value: null };
    const remote = { ...DRAFT, body: 'GitHub’s newer notes', updatedAt: '2026-10-25T08:00:00Z' };
    let lostCreate = false;
    const page = await mountReleases({ rows: [DRAFT, RC4], calls, subPath: 'compose', mountId: 'release-cmd', scope, locations,
      publish: value => { published.value = value; },
      executeAction: async ({ action }): Promise<JsonValue> => {
        const localId = (action as { localId: string }).localId;
        if (localId === GITHUB_RELEASE_ACTION_IDS_V1.listReleases) return { kind: 'value', value: { ...emptyPage, rows: [DRAFT, RC4] } } as JsonValue;
        if (localId === GITHUB_RELEASE_ACTION_IDS_V1.readLatestRelease) return { kind: 'value', value: RC4 } as JsonValue;
        if (localId === GITHUB_RELEASE_ACTION_IDS_V1.generateReleaseNotes) return { kind: 'value', value: { name: 'Release candidate 5', body: '## What changed\n\n- Generated' } };
        if (localId === GITHUB_RELEASE_ACTION_IDS_V1.readRelease) return { kind: 'value', value: lostCreate ? { ...remote, body: 'GitHub’s newer notes, edited' } : DRAFT } as JsonValue;
        if (localId === GITHUB_RELEASE_ACTION_IDS_V1.editReleaseDraft) return lostCreate
          ? { kind: 'outcome_unknown', releaseId: DRAFT.releaseId, webUrl: DRAFT.webUrl }
          : { kind: 'conflict', release: remote } as JsonValue;
        return { kind: 'unavailable', failure: { class: 'transient', code: 'not-under-test' } };
      } });
    const command = (name: string) => invoke(page, 'release-cmd', { kind: 'command', command: name });
    await page.findByRole('button', { name: 'Write my own' });
    // Generate installs GitHub's proposal in this editor; Use applies it.
    await act(async () => { expect(await command('generate')).toEqual({ status: 'applied' }); });
    expect(calls.filter(id => id === GITHUB_RELEASE_ACTION_IDS_V1.generateReleaseNotes)).toHaveLength(1);
    await act(async () => { expect(await invoke(page, 'release-cmd', { kind: 'applyGenerated', mode: 'use' })).toEqual({ status: 'applied' }); });
    await page.findByRole('textbox', { label: 'Release notes', value: '## What changed\n\n- Generated' });
    // Close goes through the unsaved-change guard; Keep editing and Discard answer it.
    expect(await command('discard')).toEqual({ status: 'rejected' });
    await act(async () => { expect(await command('close')).toEqual({ status: 'applied' }); });
    await page.getByText('Discard your unsaved changes? The GitHub draft stays as you last saved it.');
    expect(published.value?.commands?.map(entry => entry.title)).toEqual(expect.arrayContaining(['Discard', 'Keep editing']));
    expect(locations).toEqual([]);
    await act(async () => { expect(await command('keepEditing')).toEqual({ status: 'applied' }); });
    expect(await page.queryByText('Discard your unsaved changes? The GitHub draft stays as you last saved it.')).toBeUndefined();
    await act(async () => { await command('close'); expect(await command('discard')).toEqual({ status: 'applied' }); });
    expect(locations).toEqual([{ subPath: '', backLocation: '' }]);
    expect(await page.queryByRole('textbox', { label: 'Release notes' })).toBeUndefined();
    // GitHub's changed draft: the conflict keeps local text until Use GitHub's version is chosen.
    await act(async () => { await page.updatePageLocation(DRAFT.releaseId); });
    await page.findByRole('textbox', { label: 'Release name', value: DRAFT.name });
    expect(await command('useRemote')).toEqual({ status: 'unavailable' });
    await act(async () => { await invoke(page, 'release-cmd', { kind: 'setField', field: 'body', value: 'My local notes' }); });
    await act(async () => { await page.controls.press('Save draft'); });
    await page.getByText('This draft changed on GitHub since you opened it');
    await act(async () => { expect(await command('useRemote')).toEqual({ status: 'applied' }); });
    await page.findByRole('textbox', { label: 'Release notes', value: 'GitHub’s newer notes' });
    // A lost write answer: Check status reads the exact known target once and never replays the write.
    lostCreate = true;
    await act(async () => { await invoke(page, 'release-cmd', { kind: 'setField', field: 'body', value: 'GitHub’s newer notes, edited' }); });
    expect(await command('checkStatus')).toEqual({ status: 'unavailable' });
    await act(async () => { await page.controls.press('Save draft'); });
    await page.getByText('Result unknown — check on GitHub');
    await act(async () => { expect(await command('checkStatus')).toEqual({ status: 'applied' }); });
    expect(await page.queryByText('Result unknown — check on GitHub')).toBeUndefined();
    expect(calls.filter(id => id === GITHUB_RELEASE_ACTION_IDS_V1.editReleaseDraft)).toHaveLength(2);
  });

  it('retains unknown download state across page/editor routes without replaying the host effect', async () => {
    const downloads: unknown[] = [];
    const page = await mountReleases({ rows: [DRAFT, RC4, STABLE], calls: [], downloadCalls: downloads,
      downloadResult: { success: false, status: 'unknown', error: 'Receiver settlement unavailable', errorCode: 'response_lost' } });
    const name = `Download ${RC4.assets.rows[0]!.name}`;
    await act(async () => { await page.press(await page.getByRole('button', { name })); });
    expect((await page.getByRole('button', { name })).state?.disabled).toBe(true);
    await act(async () => { await page.updatePageLocation(DRAFT.releaseId); });
    await act(async () => { await page.updatePageLocation(''); });
    expect((await page.getByRole('button', { name })).state?.disabled).toBe(true);
    expect(downloads).toHaveLength(1);
  });
  it('leads with the saved draft, tells newest from GitHub latest, and reads no assets or bytes on open', async () => {
    const calls: string[] = [];
    const page = await mountReleases({ rows: [DRAFT, RC4, STABLE], calls });
    await page.findByRole('button', { name: 'Open draft' });
    expect(
      await page.queryByRole('button', { name: 'Draft release' }),
    ).toBeUndefined();
    await page.getByText('Release candidate 4');
    // Exactly one Latest mark, and it belongs to the provider's latest (v0.2.14), not the newest rc.
    await page.getByText('Latest');
    await page.getByRole('button', { name: 'v0.2.14 Voice on Android' });
    expect(new Set(calls)).toEqual(
      new Set([
        GITHUB_RELEASE_ACTION_IDS_V1.listReleases,
        GITHUB_RELEASE_ACTION_IDS_V1.readLatestRelease,
      ]),
    );
  });

  it('shows an observation warning while keeping a confirmed release published', async () => {
    const notifications: unknown[] = [];
    const locations: unknown[] = [];
    const page = await mountReleases({ rows: [DRAFT], exact: DRAFT, calls: [], subPath: DRAFT.releaseId, locations,
      notify: async notification => { notifications.push(notification); },
      executeAction: async request => {
        const id = (request.action as { localId: string }).localId;
        if (id === GITHUB_RELEASE_ACTION_IDS_V1.publishReleaseDraft) return { kind: 'confirmed',
          release: { ...DRAFT, draft: false }, observationWarning: { class: 'transient', code: 'github_server_error' } } as JsonValue;
        if (id === GITHUB_RELEASE_ACTION_IDS_V1.listAssets) return { kind: 'value', value: { ...DRAFT.assets, incomplete: null } } as JsonValue;
        return { kind: 'value', value: DRAFT } as JsonValue;
      } });
    await act(async () => { await page.controls.press('Publish…'); });
    expect(notifications).toMatchObject([{ severity: 'warning', message: expect.stringContaining('github_server_error') }]);
    expect(locations.at(-1)).toMatchObject({ subPath: '' });
  });

  it('offers Draft release when nothing is waiting, and keeps Publish unavailable until a draft is saved', async () => {
    const calls: string[] = [];
    const page = await mountReleases({
      rows: [RC4, STABLE],
      calls,
      subPath: 'compose',
    });
    await page.getByText('New release');
    await page.getByText('Not saved · nothing is on GitHub yet');
    expect(page.controls.presentation('Publish…')?.disabled).toBe(true);
    expect(calls).not.toContain(
      GITHUB_RELEASE_ACTION_IDS_V1.createReleaseDraft,
    );
    expect(calls).not.toContain(
      GITHUB_RELEASE_ACTION_IDS_V1.publishReleaseDraft,
    );
  });

  it('invites the first release, and the editor opens even when the repository has none', async () => {
    const calls: string[] = [];
    const page = await mountReleases({ rows: [], calls });
    await page.findByRole('button', { name: 'Draft first release' });
    await act(async () => { await page.updatePageLocation('compose'); });
    await page.getByText('New release');
  });
});
