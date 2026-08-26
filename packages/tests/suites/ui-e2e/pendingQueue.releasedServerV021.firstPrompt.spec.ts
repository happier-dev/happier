import { expect, test, type Page, type Request } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { type StartedDaemon } from '../../src/testkit/daemon/daemon';
import {
  countFakeClaudeEventsAfterCurrentRunSentinel,
  fakeClaudeFixturePath,
  waitForFakeClaudeUserText,
} from '../../src/testkit/fakeClaude';
import { repoRootDir } from '../../src/testkit/paths';
import {
  resolveReleasedServerV021ArtifactPrerequisite,
  startReleasedServerLight,
  type StartedReleasedServerLight,
} from '../../src/testkit/process/releasedServerLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { createRunDirs } from '../../src/testkit/runDir';
import { authenticateAndStartDaemon } from '../../src/testkit/uiE2e/authenticateAndStartDaemon';
import { createSessionFromNewSessionComposer } from '../../src/testkit/uiE2e/createSessionFromNewSessionComposer';
import { waitForDaemonMachineIdFromCliSettings } from '../../src/testkit/uiE2e/daemonMachineId';
import {
  gotoCommittedWithRetries,
  normalizeLoopbackBaseUrl,
} from '../../src/testkit/uiE2e/pageNavigation';

const run = createRunDirs({ runLabel: 'ui-e2e' });
const releasedServerArtifact = resolveReleasedServerV021ArtifactPrerequisite({
  defaultArtifactDir: join(repoRootDir(), '.project/tmp/c1-server-v0.2.1'),
});

function isPendingEnqueueRequest(request: Request): boolean {
  if (request.method() !== 'POST') return false;
  try {
    return /^\/v2\/sessions\/[^/]+\/pending$/u.test(new URL(request.url()).pathname);
  } catch {
    return false;
  }
}

async function countVisibleCommittedTranscriptMessagesWithText(page: Page, text: string): Promise<number> {
  return await page.locator('[data-testid^="transcript-message-"]').evaluateAll((nodes, expectedText) => (
    nodes.filter((node) => {
      const testId = node.getAttribute('data-testid') ?? '';
      if (!testId.startsWith('transcript-message-') || testId.includes(':')) return false;
      if (!String(node.textContent ?? '').includes(String(expectedText))) return false;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }).length
  ), text);
}

async function expectOneVisibleCommittedTranscriptMessage(
  page: Page,
  text: string,
  timeoutMs = 180_000,
): Promise<void> {
  await page.waitForFunction(
    ({ expectedText }) => {
      const nodes = Array.from(document.querySelectorAll('[data-testid^="transcript-message-"]'));
      return nodes.filter((node) => {
        const testId = node.getAttribute('data-testid') ?? '';
        if (!testId.startsWith('transcript-message-') || testId.includes(':')) return false;
        if (!String(node.textContent ?? '').includes(String(expectedText))) return false;
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      }).length === 1;
    },
    { expectedText: text },
    { timeout: timeoutMs },
  );
  expect(await countVisibleCommittedTranscriptMessagesWithText(page, text)).toBe(1);
}

const describeReleasedServer = releasedServerArtifact.status === 'ready' ? test.describe : test.describe.skip;
const releasedServerSuiteName = releasedServerArtifact.status === 'ready'
  ? 'ui e2e: current UI spawn-first first prompt against immutable server-v0.2.1'
  : `ui e2e: current UI spawn-first first prompt against immutable server-v0.2.1 [skipped: ${releasedServerArtifact.reason}]`;

describeReleasedServer(releasedServerSuiteName, () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('pending-queue-released-server-v0-2-1-first-prompt-suite');
  const cliHomeDir = resolve(suiteDir, 'cli-home');
  const fakeClaudeLogPath = resolve(suiteDir, 'fake-claude.jsonl');

  let server: StartedReleasedServerLight | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;
  let daemon: StartedDaemon | null = null;

  test.beforeAll(async () => {
    test.setTimeout(900_000);
    if (releasedServerArtifact.status !== 'ready') throw new Error(releasedServerArtifact.reason);
    await mkdir(cliHomeDir, { recursive: true });
    server = await startReleasedServerLight({
      testDir: suiteDir,
      archivePath: releasedServerArtifact.archivePath,
      manifestPath: releasedServerArtifact.manifestPath,
      expectedArchiveSha256: releasedServerArtifact.expectedArchiveSha256,
    });
    ui = await startUiWeb({
      testDir: suiteDir,
      env: {
        ...process.env,
        EXPO_PUBLIC_DEBUG: '1',
        EXPO_PUBLIC_HAPPIER_SERVER_URL: server.baseUrl,
        EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-c1-old-server-${run.runId}`,
      },
    });
    uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    await daemon?.stop().catch(() => {});
    await ui?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  test('uses a real new-session submit to enqueue and deliver the first prompt once', async ({ page }) => {
    test.setTimeout(720_000);
    if (!server || !uiBaseUrl) throw new Error('missing released-server/UI fixtures');

    const providerObservationStartedAt = Date.now();
    const browserDiagnostics: string[] = [];
    page.on('console', (message) => browserDiagnostics.push(`console.${message.type()}: ${message.text()}`));
    page.on('pageerror', (error) => browserDiagnostics.push(`pageerror: ${error.message}`));
    page.on('requestfailed', (request) => {
      browserDiagnostics.push(`requestfailed: ${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`);
    });
    try {
      daemon = await authenticateAndStartDaemon({
        page,
        testDir: suiteDir,
        cliHomeDir,
        serverUrl: server.baseUrl,
        uiBaseUrl,
        initialUiReadyTimeoutMs: 180_000,
        accountReadyTimeoutMs: 20_000,
        allowStoredCredentialsWithoutReady: true,
        daemonStartupTimeoutMs: 180_000,
        beforeTerminalConnect: async (authenticatedPage) => {
          await gotoCommittedWithRetries(
            authenticatedPage,
            `${uiBaseUrl}/settings/session`,
            60_000,
          );
          const runtimeSettings = authenticatedPage.getByText('Runtime and terminal', { exact: true });
          await expect(runtimeSettings).toBeVisible({ timeout: 60_000 });
          await runtimeSettings.scrollIntoViewIfNeeded();
          await runtimeSettings.click();
          const compatibilitySetting = authenticatedPage.getByText(
            'Legacy secret export (compatibility)',
            { exact: true },
          );
          await expect(compatibilitySetting).toBeVisible({ timeout: 60_000 });
          await compatibilitySetting.click();
          await expect(authenticatedPage.getByText(
            /Enabled: exports your legacy account secret to the terminal/u,
          )).toBeVisible({ timeout: 60_000 });
        },
        extraEnv: {
          ...process.env,
          HOME: cliHomeDir,
          HAPPIER_CLAUDE_PATH: fakeClaudeFixturePath(),
          HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeClaudeLogPath,
          HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-c1-${run.runId}`,
          HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-claude-c1-${run.runId}`,
        },
      });
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n${browserDiagnostics.slice(-40).join('\n')}`,
      );
    }

    const machineId = await waitForDaemonMachineIdFromCliSettings({ cliHomeDir, timeoutMs: 120_000 });
    const firstPrompt = `released old server UI first prompt ${run.runId}`;
    const pendingEnqueueRequests: Request[] = [];
    const recordPendingEnqueue = (request: Request) => {
      if (isPendingEnqueueRequest(request)) pendingEnqueueRequests.push(request);
    };
    page.on('request', recordPendingEnqueue);

    const { sessionId } = await createSessionFromNewSessionComposer({
      page,
      uiBaseUrl,
      machineId,
      prompt: firstPrompt,
    });

    await waitForFakeClaudeUserText(
      fakeClaudeLogPath,
      (text) => text.includes(firstPrompt),
      { timeoutMs: 180_000, pollMs: 100 },
    );
    await expectOneVisibleCommittedTranscriptMessage(page, firstPrompt);
    await expectOneVisibleCommittedTranscriptMessage(page, 'FAKE_CLAUDE_OK_1');
    page.off('request', recordPendingEnqueue);

    const matchingEnqueues = pendingEnqueueRequests.filter((request) => (
      new URL(request.url()).pathname === `/v2/sessions/${sessionId}/pending`
    ));
    expect(matchingEnqueues).toHaveLength(1);
    const enqueueBody = matchingEnqueues[0]!.postDataJSON() as Record<string, unknown>;
    expect(Object.keys(enqueueBody).sort()).toEqual(['ciphertext', 'localId']);
    expect(typeof enqueueBody.localId).toBe('string');
    expect(String(enqueueBody.localId).trim()).not.toBe('');
    expect(typeof enqueueBody.ciphertext).toBe('string');
    expect(String(enqueueBody.ciphertext).trim()).not.toBe('');

    const providerInputs = await countFakeClaudeEventsAfterCurrentRunSentinel({
      logPath: fakeClaudeLogPath,
      sinceMs: providerObservationStartedAt,
      sentinelPredicate: (event) => event.type === 'invocation',
      predicate: (event) => event.type === 'sdk_stdin'
        && event.hasUserText === true
        && typeof event.userTextPreview === 'string'
        && event.userTextPreview.includes(firstPrompt),
    });
    expect(providerInputs).toBe(1);
    await expect(page).toHaveURL(new RegExp(`/session/${sessionId}(?:\\?.*)?$`));
  });
});
