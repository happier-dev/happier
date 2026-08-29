import { expect, test } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';

import {
  ensureQaUiUrlHasHmrDisabled,
  withQaUiBase,
} from '../../../../scripts/qa/resolveQaUiUrl.mjs';
import {
  attestCurrentManagedStackPluginUi,
  deleteCurrentManagedStackNewSessionDraft,
  deleteCurrentManagedStackSession,
  prepareCurrentManagedStackNativePublicFixture,
  resolveCurrentManagedStackPluginUiContext,
  type CurrentManagedStackPluginUiAttestation,
  type CurrentManagedStackPluginUiContext,
} from '../../src/testkit/pluginPlatform/currentManagedStackPluginUiQa';
import { createSession } from '../../src/testkit/sessions';
import { selectNewSessionAgent } from '../../src/testkit/uiE2e/selectNewSessionAgent';
import {
  gotoDomContentLoadedWithRetries,
  waitForAuthenticatedRouteUi,
} from '../../src/testkit/uiE2e/pageNavigation';
import { installAuthBootstrapStorageSnapshot } from '../../src/testkit/uiE2e/readLegacyAuthSecretFromLocalStorage';

const enabled = process.env.HAPPIER_E2E_PLUGIN_UI_CURRENT_STACK === '1';
const INSPECTOR_PLUGIN_ID = 'happier.inspector';
const INSPECTOR_VIEW_ID = 'inspector-app';

function currentAccountAccessToken(context: CurrentManagedStackPluginUiContext): string {
  const raw = JSON.parse(context.authStorage.localStorage.auth_credentials) as { token?: unknown };
  if (typeof raw.token !== 'string' || raw.token.trim() === '') {
    throw new Error('plugin_ui_current_stack_account_access_token_missing');
  }
  return raw.token;
}

async function createDisposablePlainSession(params: Readonly<{
  context: CurrentManagedStackPluginUiContext;
}>): Promise<string> {
  const created = await createSession(
    params.context.serverUrl,
    currentAccountAccessToken(params.context),
    { dataEncryptionKeyBase64: null, timeoutMs: 30_000 },
  );
  return created.sessionId;
}

test.describe('current managed Stack Plugin UI', () => {
  test.skip(!enabled, 'Set HAPPIER_E2E_PLUGIN_UI_CURRENT_STACK=1 to attach to an already-running managed Stack.');
  test.describe.configure({ mode: 'serial', timeout: 12 * 60_000 });

  let context: CurrentManagedStackPluginUiContext;
  let attestation: CurrentManagedStackPluginUiAttestation;

  test.beforeAll(async () => {
    context = await resolveCurrentManagedStackPluginUiContext();
    attestation = await attestCurrentManagedStackPluginUi({ context });
  });

  test.beforeEach(async ({ page }) => {
    await installAuthBootstrapStorageSnapshot(page, context.authStorage);
  });

  test('attests and exercises the current RNW host, Action, Resource, lifecycle, and accessibility path', async ({ page }, testInfo) => {
    const uiAssetResponses: Array<Readonly<{ url: string; digest: string; byteSize: number }>> = [];
    const uiOrigin = new URL(context.uiUrl).origin;
    page.on('response', async (response) => {
      const contentType = response.headers()['content-type'] ?? '';
      if (
        response.status() !== 200
        || response.request().resourceType() !== 'script'
        || new URL(response.url()).origin !== uiOrigin
        || !/javascript|ecmascript/u.test(contentType)
      ) return;
      try {
        const bytes = await response.body();
        uiAssetResponses.push(Object.freeze({
          url: response.url(),
          digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
          byteSize: bytes.byteLength,
        }));
      } catch {
        // A superseded HMR request can disappear; at least one adopted module
        // response is required below, so a run cannot pass on this branch.
      }
    });
    await testInfo.attach('current-managed-stack-plugin-ui-attestation.json', {
      body: Buffer.from(`${JSON.stringify(attestation, null, 2)}\n`, 'utf8'),
      contentType: 'application/json',
    });

    const routeUrl = ensureQaUiUrlHasHmrDisabled(withQaUiBase(
      context.uiUrl,
      '/settings/plugins/panels',
    ));
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoDomContentLoadedWithRetries(page, routeUrl, 180_000);
    await waitForAuthenticatedRouteUi({
      page,
      expectedPathname: '/settings/plugins/panels',
      requiredTestIds: ['settings.plugins.appPanels.host'],
      targetUrl: routeUrl,
      timeoutMs: 180_000,
    });

    const tab = page.getByTestId(
      `app-scope-right-sidebar-tab:plugin:${INSPECTOR_PLUGIN_ID}:${INSPECTOR_VIEW_ID}`,
    );
    await expect(tab).toHaveRole('tab');
    await expect(tab).toHaveAccessibleName('Plugin Inspector');
    await tab.focus();
    await expect(tab).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(tab).toHaveAttribute('aria-selected', 'true');

    const surface = page.getByTestId('inspector-surface');
    await expect(surface).toBeVisible({ timeout: 180_000 });
    await expect(surface).toHaveAccessibleName('Installed plugins');
    await expect(page.getByTestId(`inspector-plugin-${INSPECTOR_PLUGIN_ID}`)).toBeVisible();
    await expect(page.getByTestId('inspector-inventory-illustration')).toBeVisible();

    const interactionBoundary = page.getByTestId(
      `plugin-surface-interaction-boundary:surfacePlacement:${INSPECTOR_PLUGIN_ID}:${INSPECTOR_VIEW_ID}`,
    );
    await expect(interactionBoundary).toHaveAttribute('data-plugin-interaction-state', 'enabled');

    const selfCheckAction = page.getByTestId('inspector-self-check-action');
    await expect(selfCheckAction).toBeVisible();
    await selfCheckAction.click();
    await expect(page.getByTestId('inspector-self-check-settled')).toHaveText(
      'Inspector self-check: success',
      { timeout: 180_000 },
    );

    const inventoryImage = page.getByTestId('inspector-inventory-illustration');
    await expect(inventoryImage).toHaveJSProperty('tagName', 'IMG');
    await expect.poll(async () => await inventoryImage.evaluate((node) => {
      const image = node as HTMLImageElement;
      return image.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
    })).toBe(true);

    await expect(interactionBoundary).toHaveAttribute('data-plugin-id', INSPECTOR_PLUGIN_ID);
    await expect(interactionBoundary).toHaveAttribute('data-plugin-generation', attestation.contributionProjectionGeneration);
    await expect(interactionBoundary).toHaveAttribute('data-plugin-artifact-digest', attestation.artifact.digest);
    await expect(interactionBoundary).toHaveAttribute('data-plugin-machine-id', context.daemon.machineId);
    await expect(interactionBoundary).toHaveAttribute('data-plugin-server-id', context.account.uiServerId);

    await expect.poll(() => uiAssetResponses.length).toBeGreaterThan(0);
    const initialUiAssets = new Set(
      uiAssetResponses.map((asset) => `${asset.url}\u0000${asset.digest}`),
    );
    const initialUiAssetResponseCount = uiAssetResponses.length;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForAuthenticatedRouteUi({
      page,
      expectedPathname: '/settings/plugins/panels',
      requiredTestIds: ['settings.plugins.appPanels.host'],
      targetUrl: routeUrl,
      timeoutMs: 180_000,
    });
    await page.getByTestId(
      `app-scope-right-sidebar-tab:plugin:${INSPECTOR_PLUGIN_ID}:${INSPECTOR_VIEW_ID}`,
    ).click();
    await expect(page.getByTestId('inspector-surface')).toBeVisible({ timeout: 180_000 });
    await expect.poll(() => uiAssetResponses.length).toBeGreaterThan(initialUiAssetResponseCount);
    const reloadedUiAssets = new Set(
      uiAssetResponses
        .slice(initialUiAssetResponseCount)
        .map((asset) => `${asset.url}\u0000${asset.digest}`),
    );
    expect([...initialUiAssets].some((asset) => reloadedUiAssets.has(asset))).toBe(true);

    const reconnectedBoundary = page.getByTestId(
      `plugin-surface-interaction-boundary:surfacePlacement:${INSPECTOR_PLUGIN_ID}:${INSPECTOR_VIEW_ID}`,
    );
    const reconnectedSnapshot = page.getByTestId(
      `plugin-surface-snapshot:surfacePlacement:${INSPECTOR_PLUGIN_ID}:${INSPECTOR_VIEW_ID}`,
    );
    await page.context().setOffline(true);
    await expect(reconnectedBoundary).toHaveAttribute(
      'data-plugin-interaction-state',
      'offline-snapshot',
      { timeout: 180_000 },
    );
    await expect(reconnectedSnapshot).toHaveAttribute('inert', '');
    await expect(reconnectedSnapshot).toHaveAttribute('aria-hidden', 'true');

    await page.context().setOffline(false);
    await expect(reconnectedBoundary).toHaveAttribute(
      'data-plugin-interaction-state',
      'enabled',
      { timeout: 180_000 },
    );
    await expect(reconnectedSnapshot).not.toHaveAttribute('inert');
    await expect(reconnectedSnapshot).not.toHaveAttribute('aria-hidden', 'true');

    await page.evaluate(() => {
      document.documentElement.style.zoom = '2';
    });
    await expect(page.getByTestId('inspector-surface')).toBeVisible();
    await expect(page.getByTestId('inspector-plugin-search')).toBeVisible();
    await expect.poll(async () => await page.getByTestId('inspector-surface').evaluate((node) => {
      const box = node.getBoundingClientRect();
      return box.left >= 0 && box.right <= document.documentElement.clientWidth + 1;
    })).toBe(true);
    await page.evaluate(() => {
      document.documentElement.style.zoom = '1';
    });

    const postAttestation = await attestCurrentManagedStackPluginUi({ context });
    expect(uiAssetResponses.length).toBeGreaterThan(0);
    expect(postAttestation).toMatchObject({
      runtimeSnapshotId: attestation.runtimeSnapshotId,
      daemonRuntimeId: attestation.daemonRuntimeId,
      daemonDistClosureFingerprint: attestation.daemonDistClosureFingerprint,
      desiredGeneration: attestation.desiredGeneration,
      appliedGeneration: attestation.appliedGeneration,
      contributionProjectionGeneration: attestation.contributionProjectionGeneration,
      artifact: { digest: attestation.artifact.digest },
    });
    await testInfo.attach('current-managed-stack-plugin-ui-post-attestation.json', {
      body: Buffer.from(`${JSON.stringify(postAttestation, null, 2)}\n`, 'utf8'),
      contentType: 'application/json',
    });
    await testInfo.attach('current-managed-stack-ui-module-responses.json', {
      body: Buffer.from(`${JSON.stringify({ producer: context.uiProducer, responses: uiAssetResponses }, null, 2)}\n`, 'utf8'),
      contentType: 'application/json',
    });
  });

  test('mounts one current-source public RNW, declarative, hosted, targeted, Action, and Composer plugin through its full reversible lifecycle', async ({ page }, testInfo) => {
    test.skip(
      process.env.HAPPIER_E2E_PLUGIN_UI_CURRENT_STACK_MUTATIONS !== '1',
      'Set HAPPIER_E2E_PLUGIN_UI_CURRENT_STACK_MUTATIONS=1 to opt into reversible catalog mutations.',
    );
    const beforeMutation = await attestCurrentManagedStackPluginUi({ context });
    const fixture = await prepareCurrentManagedStackNativePublicFixture({
      context,
      rowId: `browser-${randomUUID()}`,
    });
    const generations: Array<Readonly<{ phase: string; generation: string }>> = [
      { phase: 'installed', generation: fixture.installed.appliedGeneration },
    ];
    let disposableSessionId: string | null = null;
    let newSessionDraftId: string | null = null;
    let v2NewSessionDraftId: string | null = null;
    let v2DisposableSessionId: string | null = null;
    let journeyError: unknown = null;
    const visitPluginRoute = async (params: Readonly<{
      path: string;
      requiredTestId: string;
    }>): Promise<void> => {
      const targetUrl = ensureQaUiUrlHasHmrDisabled(withQaUiBase(context.uiUrl, params.path));
      await gotoDomContentLoadedWithRetries(page, targetUrl, 180_000);
      await waitForAuthenticatedRouteUi({
        page,
        expectedPathname: params.path,
        requiredTestIds: [params.requiredTestId],
        targetUrl,
        timeoutMs: 180_000,
      });
    };
    const visitNative = async (params: Readonly<{
      revision: 'v1' | 'v2';
      generation: string;
      artifactDigest: string;
    }>): Promise<void> => {
      const nativeSentinel = params.revision === 'v1' ? fixture.sentinels.rnV1 : fixture.sentinels.rnV2;
      const targetedSentinel = params.revision === 'v1' ? fixture.sentinels.targetedV1 : fixture.sentinels.targetedV2;
      const resourceSentinel = params.revision === 'v1' ? fixture.sentinels.resourceV1 : fixture.sentinels.resourceV2;
      const staleResourceSentinel = params.revision === 'v1' ? fixture.sentinels.resourceV2 : fixture.sentinels.resourceV1;
      const actionResultSentinel = params.revision === 'v1'
        ? fixture.sentinels.actionResultV1
        : fixture.sentinels.actionResultV2;
      await visitPluginRoute({ path: fixture.rnSurfaceUrlPath, requiredTestId: nativeSentinel });
      await expect(page.getByTestId(targetedSentinel)).toBeVisible({ timeout: 180_000 });
      // The mounted Resource store read the fixture's dynamic Resource through
      // the real host and got exactly this generation's bytes back.
      await expect(page.getByTestId(resourceSentinel)).toBeVisible({ timeout: 180_000 });
      await expect(page.getByTestId(staleResourceSentinel)).toHaveCount(0);
      const actionRun = page.getByTestId(fixture.sentinels.actionRun);
      await expect(actionRun).toBeVisible({ timeout: 180_000 });
      await actionRun.click();
      await expect(page.getByTestId(fixture.sentinels.actionBusy)).toBeVisible();
      await expect(page.getByTestId(fixture.sentinels.actionSettled)).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId(actionResultSentinel)).toHaveText(/Self-check result/, { timeout: 60_000 });
      const boundary = page.getByTestId(
        `plugin-surface-interaction-boundary:surfacePlacement:${fixture.pluginId}:native`,
      );
      await expect(boundary).toHaveAttribute('data-plugin-generation', params.generation);
      await expect(boundary).toHaveAttribute('data-plugin-artifact-digest', params.artifactDigest);
      await expect(boundary).toHaveAttribute('data-plugin-machine-id', context.daemon.machineId);
      await expect(boundary).toHaveAttribute('data-plugin-server-id', context.account.uiServerId);
    };
    const assertComposerScope = async (params: Readonly<{
      inputTestId: 'new-session-composer-input' | 'session-composer-input';
      attachmentLabel: string;
      referenceLabel: string;
    }>): Promise<void> => {
      await expect(page.getByTestId(fixture.sentinels.composerRegion)).toBeVisible({ timeout: 180_000 });
      const control = page.getByTestId(fixture.sentinels.composerControl);
      await expect(control).toBeVisible({ timeout: 180_000 });
      await control.click();
      const choice = page.getByText(fixture.sentinels.composerChoiceLabel, { exact: true }).last();
      await expect(choice).toBeVisible({ timeout: 60_000 });
      await choice.click();
      // The attachment badge and reference token carry exactly the requested
      // generation's labels; a v2 assertion here can only pass if the loaded
      // projection really is that generation.
      await expect(page.getByText(params.attachmentLabel, { exact: true })).toBeVisible({ timeout: 60_000 });

      const input = page.locator(`textarea[data-testid="${params.inputTestId}"]:visible`).first();
      await expect(input).toHaveValue('@qa-ref');
      await expect(page.getByText(params.referenceLabel, { exact: true }).last()).toBeVisible({ timeout: 60_000 });
    };

    try {
      const v1WebArtifact = await fixture.artifact('web');
      const v1HostedArtifact = await fixture.hostedArtifact();
      await visitNative({
        revision: 'v1',
        generation: fixture.installed.contributionProjectionGeneration,
        artifactDigest: v1WebArtifact.digest,
      });

      await visitPluginRoute({
        path: fixture.declarativeSurfaceUrlPath,
        requiredTestId: 'plugin-declarative-text:root.children[0]',
      });
      await expect(page.getByText(fixture.sentinels.declarativeV1, { exact: true })).toBeVisible();
      const externalAction = page.getByTestId(fixture.sentinels.actionTestId);
      await expect(externalAction).toHaveAccessibleName(fixture.sentinels.actionLabel);
      await externalAction.click();
      await expect(externalAction).toHaveAttribute('aria-busy', 'true');
      await expect(externalAction).not.toHaveAttribute('aria-busy', 'true', { timeout: 30_000 });

      await visitPluginRoute({ path: fixture.hostedSurfaceUrlPath, requiredTestId: 'plugin-hosted-web-frame' });
      await expect(page.getByTestId('plugin-hosted-web-frame')).toHaveAttribute('title', 'Current source hosted QA');
      const hosted = page.frameLocator('[data-testid="plugin-hosted-web-frame"]');
      await expect(hosted.locator(`#${fixture.sentinels.hostedV1}`)).toBeVisible({ timeout: 180_000 });
      await hosted.locator(`#${fixture.sentinels.hostedHistoryAction}`).click();
      await expect(hosted.locator(`#${fixture.sentinels.hostedHistoryV1}`)).toBeVisible({ timeout: 60_000 });

      newSessionDraftId = randomUUID();
      const newSessionRoute = new URL(withQaUiBase(context.uiUrl, '/new'));
      newSessionRoute.searchParams.set('draftId', newSessionDraftId);
      const newSessionUrl = ensureQaUiUrlHasHmrDisabled(newSessionRoute.toString());
      await gotoDomContentLoadedWithRetries(page, newSessionUrl, 180_000);
      await waitForAuthenticatedRouteUi({
        page,
        expectedPathname: '/new',
        requiredTestIds: ['new-session-composer-input'],
        targetUrl: newSessionUrl,
        timeoutMs: 180_000,
      });
      await assertComposerScope({
        inputTestId: 'new-session-composer-input',
        attachmentLabel: fixture.sentinels.composerAttachmentV1,
        referenceLabel: fixture.sentinels.composerReferenceV1,
      });
      expect(new URL(page.url()).searchParams.get('draftId')).toBe(newSessionDraftId);

      disposableSessionId = await createDisposablePlainSession({ context });
      await visitPluginRoute({
        path: `/session/${disposableSessionId}`,
        requiredTestId: 'session-composer-input',
      });
      await assertComposerScope({
        inputTestId: 'session-composer-input',
        attachmentLabel: fixture.sentinels.composerAttachmentV1,
        referenceLabel: fixture.sentinels.composerReferenceV1,
      });

      const reloaded = await fixture.applyV2();
      const v2WebArtifact = await fixture.artifact('web');
      const v2HostedArtifact = await fixture.hostedArtifact();
      expect(v2WebArtifact.digest).not.toBe(v1WebArtifact.digest);
      expect(v2HostedArtifact.digest).not.toBe(v1HostedArtifact.digest);
      expect(reloaded.appliedGeneration).not.toBe(fixture.installed.appliedGeneration);
      generations.push({ phase: 'reloaded', generation: reloaded.appliedGeneration });

      // Fresh post-update Composer dispatch through the real UI path: the
      // deterministic fixture Agent is selected on a new QA-owned draft, the
      // v2 control resolves the qa:v2 reference and v2 attachment facts, and
      // a real send settles a fresh transcript. The deterministic Agent
      // rejects another generation's facts before input acceptance, so this
      // transcript can only exist if the reloaded v2 projection resolved and
      // adopted exactly its own generation.
      v2NewSessionDraftId = randomUUID();
      const v2NewSessionRoute = new URL(withQaUiBase(context.uiUrl, '/new'));
      v2NewSessionRoute.searchParams.set('draftId', v2NewSessionDraftId);
      const v2NewSessionUrl = ensureQaUiUrlHasHmrDisabled(v2NewSessionRoute.toString());
      await gotoDomContentLoadedWithRetries(page, v2NewSessionUrl, 180_000);
      await waitForAuthenticatedRouteUi({
        page,
        expectedPathname: '/new',
        requiredTestIds: ['new-session-composer-input'],
        targetUrl: v2NewSessionUrl,
        timeoutMs: 180_000,
      });
      await selectNewSessionAgent({
        page,
        agentId: `agent:${fixture.pluginId}/qa-agent`,
        label: fixture.sentinels.agentTitle,
      });
      await assertComposerScope({
        inputTestId: 'new-session-composer-input',
        attachmentLabel: fixture.sentinels.composerAttachmentV2,
        referenceLabel: fixture.sentinels.composerReferenceV2,
      });
      expect(new URL(page.url()).searchParams.get('draftId')).toBe(v2NewSessionDraftId);
      await page.getByTestId('new-session-composer-send').first().click();
      // Send custody: a landed send leaves the New Session screen for the
      // created Session's route.
      await expect(page).toHaveURL(/\/session\/[^/?#]+/u, { timeout: 120_000 });
      v2DisposableSessionId = new URL(page.url()).pathname.split('/')[2] ?? null;
      // Fresh v2 transcript: the settled turn proves the dispatch resolved
      // and adopted exactly qa:v2 attachment facts.
      await expect(page.getByText(fixture.sentinels.transcriptSentinel).first()).toBeVisible({ timeout: 120_000 });
      await expect(page.getByText(fixture.sentinels.composerAttachmentV2, { exact: true })).toBeVisible({ timeout: 120_000 });

      await visitNative({
        revision: 'v2',
        generation: reloaded.contributionProjectionGeneration,
        artifactDigest: v2WebArtifact.digest,
      });
      await expect(page.getByTestId(fixture.sentinels.rnV1)).toHaveCount(0);
      await expect(page.getByTestId(fixture.sentinels.targetedV1)).toHaveCount(0);
      await visitPluginRoute({
        path: fixture.declarativeSurfaceUrlPath,
        requiredTestId: 'plugin-declarative-text:root.children[0]',
      });
      await expect(page.getByText(fixture.sentinels.declarativeV2, { exact: true })).toBeVisible();
      await visitPluginRoute({ path: fixture.hostedSurfaceUrlPath, requiredTestId: 'plugin-hosted-web-frame' });
      await expect(page.frameLocator('[data-testid="plugin-hosted-web-frame"]')
        .locator(`#${fixture.sentinels.hostedV2}`)).toBeVisible({ timeout: 180_000 });
      await visitNative({
        revision: 'v2',
        generation: reloaded.contributionProjectionGeneration,
        artifactDigest: v2WebArtifact.digest,
      });

      const disabledGeneration = await fixture.disable();
      generations.push({ phase: 'disabled', generation: disabledGeneration.appliedGeneration });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId(fixture.sentinels.rnV2)).toHaveCount(0, { timeout: 180_000 });
      const enabledGeneration = await fixture.enable();
      generations.push({ phase: 'enabled', generation: enabledGeneration.appliedGeneration });
      await visitNative({
        revision: 'v2',
        generation: enabledGeneration.contributionProjectionGeneration,
        artifactDigest: v2WebArtifact.digest,
      });

      await fixture.uninstall();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId(fixture.sentinels.rnV2)).toHaveCount(0, { timeout: 180_000 });

      const reinstalled = await fixture.reinstallV1();
      const reinstalledV1WebArtifact = await fixture.artifact('web');
      const reinstalledV1HostedArtifact = await fixture.hostedArtifact();
      expect(reinstalledV1WebArtifact.digest).toBe(v1WebArtifact.digest);
      expect(reinstalledV1HostedArtifact.digest).toBe(v1HostedArtifact.digest);
      generations.push({ phase: 'reinstalled', generation: reinstalled.appliedGeneration });
      await visitNative({
        revision: 'v1',
        generation: reinstalled.contributionProjectionGeneration,
        artifactDigest: reinstalledV1WebArtifact.digest,
      });
      const afterMutation = await attestCurrentManagedStackPluginUi({ context });
      expect(afterMutation).toMatchObject({
        runtimeSnapshotId: beforeMutation.runtimeSnapshotId,
        daemonRuntimeId: beforeMutation.daemonRuntimeId,
        uiProducer: beforeMutation.uiProducer,
      });
    } catch (error) {
      journeyError = error;
      throw error;
    } finally {
      let cleanupError: unknown = null;
      try {
        await fixture.cleanup();
      } catch (error) {
        cleanupError = error;
      }
      if (newSessionDraftId) {
        try {
          await deleteCurrentManagedStackNewSessionDraft(context, newSessionDraftId);
        } catch (error) {
          cleanupError = cleanupError
            ? new AggregateError([cleanupError, error], 'Plugin fixture and New Session draft cleanup both failed')
            : error;
        }
      }
      if (v2NewSessionDraftId) {
        try {
          await deleteCurrentManagedStackNewSessionDraft(context, v2NewSessionDraftId);
        } catch (error) {
          cleanupError = cleanupError
            ? new AggregateError([cleanupError, error], 'Plugin fixture and fresh v2 New Session draft cleanup both failed')
            : error;
        }
      }
      if (disposableSessionId) {
        try {
          await deleteCurrentManagedStackSession(context, disposableSessionId);
        } catch (error) {
          cleanupError = cleanupError
            ? new AggregateError([cleanupError, error], 'Plugin fixture and disposable Session cleanup both failed')
            : error;
        }
      }
      if (v2DisposableSessionId) {
        try {
          await deleteCurrentManagedStackSession(context, v2DisposableSessionId);
        } catch (error) {
          cleanupError = cleanupError
            ? new AggregateError([cleanupError, error], 'Plugin fixture and fresh v2 disposable Session cleanup both failed')
            : error;
        }
      }
      await testInfo.attach('current-managed-stack-plugin-ui-mutation-generations.json', {
        body: Buffer.from(`${JSON.stringify({ pluginId: fixture.pluginId, generations }, null, 2)}\n`, 'utf8'),
        contentType: 'application/json',
      });
      if (cleanupError) {
        if (journeyError) {
          throw new AggregateError([journeyError, cleanupError], 'Current Stack journey and cleanup both failed');
        }
        throw cleanupError;
      }
    }
  });
});
