import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';

import {
  ensureQaUiUrlHasHmrDisabled,
  withQaUiBase,
} from '../../../../scripts/qa/resolveQaUiUrl.mjs';
import {
  assertCurrentManagedStackSessionAgentIdentity,
  attestCurrentManagedStackPluginUi,
  deleteCurrentManagedStackNewSessionDraft,
  deleteCurrentManagedStackSession,
  prepareCurrentManagedStackSessionAgentFixture,
  restartCurrentManagedStackDaemon,
  resolveCurrentManagedStackPluginUiContext,
  type CurrentManagedStackPluginUiAttestation,
  type CurrentManagedStackPluginUiContext,
  type CurrentManagedStackSessionAgentFixture,
} from '../../src/testkit/pluginPlatform/currentManagedStackPluginUiQa';
import { selectNewSessionAgent } from '../../src/testkit/uiE2e/selectNewSessionAgent';
import {
  gotoDomContentLoadedWithRetries,
  waitForAuthenticatedRouteUi,
} from '../../src/testkit/uiE2e/pageNavigation';
import { installAuthBootstrapStorageSnapshot } from '../../src/testkit/uiE2e/readLegacyAuthSecretFromLocalStorage';

const enabled = process.env.HAPPIER_E2E_PLUGIN_UI_CURRENT_STACK === '1';
const mutationsEnabled = process.env.HAPPIER_E2E_PLUGIN_UI_CURRENT_STACK_MUTATIONS === '1';
const SESSION_AGENT_PROMPT = 'Run the deterministic check for the current-source browser row.';

function sessionPathname(url: string): string | null {
  try {
    const pathname = new URL(url).pathname;
    return /^\/session\/[^/]+$/u.test(pathname) ? pathname : null;
  } catch {
    return null;
  }
}

test.describe('current managed Stack external Session Agent', () => {
  test.skip(!enabled, 'Set HAPPIER_E2E_PLUGIN_UI_CURRENT_STACK=1 to attach to an already-running managed Stack.');
  test.describe.configure({ mode: 'serial' });

  let context: CurrentManagedStackPluginUiContext;
  let attestation: CurrentManagedStackPluginUiAttestation;
  let fixture: CurrentManagedStackSessionAgentFixture;

  test.beforeAll(async () => {
    test.setTimeout(20 * 60_000);
    context = await resolveCurrentManagedStackPluginUiContext();
    attestation = await attestCurrentManagedStackPluginUi({ context });
    fixture = await prepareCurrentManagedStackSessionAgentFixture({
      context,
      rowId: `browser-${randomUUID()}`,
    });
  });

  test.beforeEach(async ({ page }) => {
    await installAuthBootstrapStorageSnapshot(page, context.authStorage);
  });

  test('drives the exact qualified external Agent through one full reversible source lifecycle', async ({ page }, testInfo) => {
    test.skip(!mutationsEnabled, 'Set HAPPIER_E2E_PLUGIN_UI_CURRENT_STACK_MUTATIONS=1 to opt into reversible catalog mutations.');
    test.setTimeout(30 * 60_000);
    await testInfo.attach('current-managed-stack-session-agent-attestation.json', {
      body: Buffer.from(`${JSON.stringify(attestation, null, 2)}\n`, 'utf8'),
      contentType: 'application/json',
    });

    const visitRoute = async (params: Readonly<{
      urlPath: string;
      expectedPathname?: string;
      requiredTestId: string;
      timeoutMs?: number;
    }>): Promise<void> => {
      const targetUrl = ensureQaUiUrlHasHmrDisabled(withQaUiBase(context.uiUrl, params.urlPath));
      await gotoDomContentLoadedWithRetries(page, targetUrl, params.timeoutMs ?? 180_000);
      await waitForAuthenticatedRouteUi({
        page,
        expectedPathname: params.expectedPathname ?? params.urlPath,
        requiredTestIds: [params.requiredTestId],
        targetUrl,
        timeoutMs: params.timeoutMs ?? 180_000,
      });
    };
    const openNewSessionDraft = async (): Promise<string> => {
      const draftId = randomUUID();
      await visitRoute({
        urlPath: `/new?draftId=${draftId}`,
        expectedPathname: '/new',
        requiredTestId: fixture.selectors.newSessionComposerInput,
      });
      return draftId;
    };
    const composerSend = async (params: Readonly<{
      inputTestId: string;
      sendTestId: string;
      text: string;
    }>): Promise<void> => {
      const input = page.locator(`textarea[data-testid="${params.inputTestId}"]:visible`).first();
      await expect(input).toBeVisible({ timeout: 120_000 });
      await input.fill(params.text);
      await page.getByTestId(params.sendTestId).first().click();
    };
    const settleConfirmation = async (): Promise<void> => {
      const allow = page.getByTestId(fixture.selectors.permissionAllow).first();
      await expect(allow).toBeVisible({ timeout: 120_000 });
      await allow.click();
      await expect(allow).toHaveCount(0, { timeout: 120_000 });
    };

    const lifecyclePhases: Array<Readonly<{ phase: string; generation: string }>> = [
      { phase: 'installed', generation: fixture.installed.appliedGeneration },
    ];
    const wizardAgentOption = () => page.getByTestId(fixture.selectors.wizardOption);
    const ownedDraftIds: string[] = [];
    const ownedSessionIds: string[] = [];
    let journeyError: unknown = null;
    try {
      // Exact qualified identity at the canonical daemon catalog seam before
      // any client interaction.
      await assertCurrentManagedStackSessionAgentIdentity({ context, phase: 'active' });

      // Activation and exact qualified selection on the New Session wizard.
      ownedDraftIds.push(await openNewSessionDraft());
      await selectNewSessionAgent({
        page,
        agentId: fixture.qualifiedAgentId,
        label: fixture.displayTitle,
      });
      await expect(page.getByTestId(fixture.selectors.agentChip).first()).toContainText(
        fixture.displayTitle,
        { timeout: 60_000 },
      );

      // Session open, prompt, host confirmation, reasoning, tool call, and
      // assistant message.
      await composerSend({
        inputTestId: fixture.selectors.newSessionComposerInput,
        sendTestId: fixture.selectors.newSessionComposerSend,
        text: SESSION_AGENT_PROMPT,
      });
      await expect.poll(() => sessionPathname(page.url()), { timeout: 120_000 }).not.toBeNull();
      const sessionId = sessionPathname(page.url())!.split('/')[2]!;
      ownedSessionIds.push(sessionId);
      await settleConfirmation();
      await expect(page.getByText(fixture.assistantText).first()).toBeVisible({ timeout: 120_000 });
      // Reasoning reaches the transcript presentation; visibility may depend
      // on the collapsible thinking control, so presence is the contract here.
      await expect(page.getByText(fixture.reasoningText)).not.toHaveCount(0, { timeout: 120_000 });
      await expect(page.getByTestId('transcript-tool-calls-header').first()).toBeVisible({ timeout: 120_000 });

      // A later cancellation turn: cancelling the pending host confirmation
      // is terminal — no assistant message may appear for that turn.
      const approvedMessageCount = await page.getByText(fixture.assistantText).count();
      const cancelledPrompt = `${SESSION_AGENT_PROMPT} This turn must be cancelled.`;
      await composerSend({
        inputTestId: fixture.selectors.sessionComposerInput,
        sendTestId: fixture.selectors.sessionComposerSend,
        text: cancelledPrompt,
      });
      const pendingAllow = page.getByTestId(fixture.selectors.permissionAllow).first();
      await expect(pendingAllow).toBeVisible({ timeout: 120_000 });
      await page.getByTestId(fixture.selectors.abort).first().click();
      await expect(pendingAllow).toHaveCount(0, { timeout: 120_000 });
      await expect(page.getByTestId(fixture.selectors.abort)).toHaveCount(0, { timeout: 120_000 });
      await expect(page.locator(`textarea[data-testid="${fixture.selectors.sessionComposerInput}"]:visible`).first())
        .toBeEnabled({ timeout: 120_000 });
      expect(await page.getByText(fixture.assistantText).count()).toBe(approvedMessageCount);
      await expect(page.getByText(`Prompt: ${cancelledPrompt}`)).toHaveCount(0);

      // Daemon restart and provider resume on the same Session.
      context = await restartCurrentManagedStackDaemon({ context, restartSessionRunners: true });
      fixture.reattach(context);
      const restartedGeneration = await fixture.generation();
      lifecyclePhases.push({ phase: 'daemon-restarted', generation: restartedGeneration.appliedGeneration });
      await assertCurrentManagedStackSessionAgentIdentity({ context, phase: 'active' });
      await visitRoute({
        urlPath: `/session/${sessionId}`,
        requiredTestId: fixture.selectors.sessionComposerInput,
      });
      await composerSend({
        inputTestId: fixture.selectors.sessionComposerInput,
        sendTestId: fixture.selectors.sessionComposerSend,
        text: SESSION_AGENT_PROMPT,
      });
      await settleConfirmation();
      await expect(page.getByText(fixture.assistantText)).toHaveCount(approvedMessageCount + 1, { timeout: 180_000 });

      // Source update and plugin reload: the canonical generation owner must
      // apply a fresh current generation for the same plugin identity.
      const reloaded = await fixture.applySourceUpdate();
      expect(reloaded.appliedGeneration).not.toBe(fixture.installed.appliedGeneration);
      lifecyclePhases.push({ phase: 'reloaded', generation: reloaded.appliedGeneration });
      const reloadedIdentity = await assertCurrentManagedStackSessionAgentIdentity({ context, phase: 'active' });
      if (reloadedIdentity?.appliedGeneration !== reloaded.appliedGeneration) {
        throw new Error('session_agent_reload_generation_not_current');
      }
      await visitRoute({
        urlPath: `/session/${sessionId}`,
        requiredTestId: fixture.selectors.sessionComposerInput,
      });
      await composerSend({
        inputTestId: fixture.selectors.sessionComposerInput,
        sendTestId: fixture.selectors.sessionComposerSend,
        text: SESSION_AGENT_PROMPT,
      });
      await settleConfirmation();
      await expect(page.getByText(fixture.updatedReasoningText)).not.toHaveCount(0, { timeout: 120_000 });
      await expect(page.getByText(fixture.assistantText)).toHaveCount(approvedMessageCount + 2, { timeout: 180_000 });

      // Disable: the exact qualified option must disappear from the picker.
      const disabled = await fixture.disable();
      lifecyclePhases.push({ phase: 'disabled', generation: disabled.appliedGeneration });
      await assertCurrentManagedStackSessionAgentIdentity({ context, phase: 'present' });
      await visitRoute({ urlPath: '/new', requiredTestId: fixture.selectors.newSessionComposerInput });
      await expect(wizardAgentOption()).toHaveCount(0, { timeout: 180_000 });

      // Re-enable: the same qualified identity returns.
      const enabledGeneration = await fixture.enable();
      lifecyclePhases.push({ phase: 'enabled', generation: enabledGeneration.appliedGeneration });
      await visitRoute({ urlPath: '/new', requiredTestId: fixture.selectors.newSessionComposerInput });
      await selectNewSessionAgent({
        page,
        agentId: fixture.qualifiedAgentId,
        label: fixture.displayTitle,
      });

      // Uninstall: the Agent identity disappears with the plugin.
      await fixture.uninstall();
      lifecyclePhases.push({ phase: 'uninstalled', generation: enabledGeneration.appliedGeneration });
      await assertCurrentManagedStackSessionAgentIdentity({ context, phase: 'absent' });
      await visitRoute({ urlPath: '/new', requiredTestId: fixture.selectors.newSessionComposerInput });
      await expect(wizardAgentOption()).toHaveCount(0, { timeout: 180_000 });

      // Hard trust revocation with a pending host confirmation: reinstall,
      // reopen the Agent, leave the confirmation pending, then forget trust
      // from the plugin detail surface. The active generation must retire,
      // the late confirmation must settle without publishing a result, and
      // the Agent must stay unavailable.
      const reinstalled = await fixture.reinstall();
      lifecyclePhases.push({ phase: 'reinstalled', generation: reinstalled.appliedGeneration });
      await assertCurrentManagedStackSessionAgentIdentity({ context, phase: 'active' });
      ownedDraftIds.push(await openNewSessionDraft());
      await selectNewSessionAgent({
        page,
        agentId: fixture.qualifiedAgentId,
        label: fixture.displayTitle,
      });
      await composerSend({
        inputTestId: fixture.selectors.newSessionComposerInput,
        sendTestId: fixture.selectors.newSessionComposerSend,
        text: SESSION_AGENT_PROMPT,
      });
      await expect.poll(() => sessionPathname(page.url()), { timeout: 120_000 }).not.toBeNull();
      const revocationSessionId = sessionPathname(page.url())!.split('/')[2]!;
      ownedSessionIds.push(revocationSessionId);
      await expect(page.getByTestId(fixture.selectors.permissionAllow).first())
        .toBeVisible({ timeout: 120_000 });
      await visitRoute({
        urlPath: `/settings/plugins/${fixture.pluginId}`,
        requiredTestId: fixture.selectors.forgetTrustAction,
      });
      await page.getByTestId(fixture.selectors.forgetTrustAction).first().click();
      await expect(page.getByTestId('web-modal-confirm')).toBeVisible({ timeout: 60_000 });
      await page.getByTestId('web-modal-confirm').click();
      await expect(page.getByTestId('web-modal-confirm')).toHaveCount(0, { timeout: 120_000 });
      await visitRoute({
        urlPath: `/session/${revocationSessionId}`,
        requiredTestId: fixture.selectors.sessionComposerInput,
      });
      await expect(page.getByTestId(fixture.selectors.permissionAllow)).toHaveCount(0, { timeout: 180_000 });
      expect(await page.getByText(fixture.assistantText).count()).toBe(0);
      await assertCurrentManagedStackSessionAgentIdentity({ context, phase: 'present' });
      await visitRoute({ urlPath: '/new', requiredTestId: fixture.selectors.newSessionComposerInput });
      await expect(wizardAgentOption()).toHaveCount(0, { timeout: 180_000 });

      // The daemon restart intentionally changed the daemon process identity,
      // so the successor-scoped invariants asserted above — identical dist
      // closure fingerprint and machine at restart, catalog generation
      // currentness through the successor, and Agent unavailability after
      // revocation — are the runtime-stability evidence for this journey.
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
      for (const draftId of ownedDraftIds) {
        try {
          await deleteCurrentManagedStackNewSessionDraft(context, draftId);
        } catch (error) {
          cleanupError = cleanupError
            ? new AggregateError([cleanupError, error], 'Additional New Session draft cleanup failure')
            : error;
        }
      }
      for (const ownedSessionId of ownedSessionIds) {
        try {
          await deleteCurrentManagedStackSession(context, ownedSessionId);
        } catch (error) {
          cleanupError = cleanupError
            ? new AggregateError([cleanupError, error], 'Additional disposable Session cleanup failure')
            : error;
        }
      }
      await testInfo.attach('current-managed-stack-session-agent-generations.json', {
        body: Buffer.from(`${JSON.stringify({ pluginId: fixture.pluginId, lifecyclePhases }, null, 2)}\n`, 'utf8'),
        contentType: 'application/json',
      });
      if (cleanupError) {
        if (journeyError) {
          throw new AggregateError([journeyError, cleanupError], 'Session Agent journey and cleanup both failed');
        }
        throw cleanupError;
      }
    }
  });
});
