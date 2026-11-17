import { expect, test } from '@playwright/test';
import { join } from 'node:path';

import { PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/account/settings/personalSavedSecretActionsV1';
import { EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES } from '@happier-dev/plugin-sdk/actions';
import { DATABASE_TARGETS_CONNECT_ACTION_ID_V1 } from '../../../database-protocol/src/actionIdsDatabaseV1';
import { DatabaseTargetsConnectResultV1Schema } from '../../../database-protocol/src/databaseTargetActions';
import { startDatabaseWorkbenchInsightsFixture } from '../../src/testkit/databaseWorkbench';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { createRunDirs } from '../../src/testkit/runDir';
import { buildCredentialsAuthBootstrapStorageSnapshot } from '../../src/testkit/uiE2e/buildAuthBootstrapStorageSnapshot';
import { installAuthBootstrapStorageSnapshot } from '../../src/testkit/uiE2e/readLegacyAuthSecretFromLocalStorage';
import { approveTerminalConnect } from '../../src/testkit/uiE2e/approveTerminalConnect';

const run = createRunDirs({ runLabel: 'dbw-phone' });

// The UI consumes real owner admission and a saved-secret target. Native SQL is
// used only to observe committed effects, never to replace a UI operation.
test('DBW-F13 phone_browse_console_insights_review_continuity', async ({ page }) => {
  test.setTimeout(0);
  const testDir = run.testDir('phone-workbench');
  let fixture: Awaited<ReturnType<typeof startDatabaseWorkbenchInsightsFixture>> | undefined;
  let ui: StartedUiWeb | undefined;
  const storageScope = run.runId;
  try {
    fixture = await startDatabaseWorkbenchInsightsFixture({ testDir,
      completeTerminalConnect: async options => {
        ui = await startUiWeb({ testDir: join(testDir, 'ui'), env: {
          ...process.env, HAPPIER_E2E_UI_WEB_MODE: 'metro',
          EXPO_PUBLIC_HAPPY_SERVER_URL: options.canonicalServerUrl,
          EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: storageScope,
        } });
        await installAuthBootstrapStorageSnapshot(page, buildCredentialsAuthBootstrapStorageSnapshot({
          serverUrl: options.canonicalServerUrl, serverIdentityId: options.homeServerIdentityId,
          credentials: options.credentials, storageScope,
        }));
        const connectUrl = new URL(options.connectUrl);
        const browserUrl = new URL(`${connectUrl.pathname}${connectUrl.search}${connectUrl.hash}`, ui.baseUrl);
        await page.goto(browserUrl.href, { waitUntil: 'domcontentloaded' });
        await approveTerminalConnect({ page });
        await options.waitForSuccess();
      },
    });
    const pairedFixture = fixture;
    const secretArrival = await fixture.owner.execute('secrets.create', {
      name: 'Phone native database', kind: 'other', value: fixture.postgres.selectedDatabaseUrl,
    }, { presentUserConfirmation: { actionId: 'secrets.create' } });
    if (!secretArrival.ok) throw new Error(`F13 Saved Secret refused (${secretArrival.errorCode})`);
    const secret = PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1['secrets.create'].parse(secretArrival.result);
    const { source: _source, ...scope } = fixture.targets.selected;
    const connected = await fixture.executeDatabase(DATABASE_TARGETS_CONNECT_ACTION_ID_V1, {
      scope, savedSecretRef: secret.secretRef, label: 'Phone native database',
    });
    if (!connected.ok) throw new Error(`F13 Connect refused (${connected.errorCode})`);
    DatabaseTargetsConnectResultV1Schema.parse(connected.result);
    // Cross the real Action envelope boundary rather than inventing a UI cap.
    const fullValueBytes = EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES + 1;
    await fixture.postgres.sql('dbw_selected', `CREATE TABLE large_value (id bigint PRIMARY KEY, marker text, payload text);
      INSERT INTO large_value VALUES (1, 'large-sentinel', repeat('x', ${fullValueBytes}));`);

    if (!ui) throw new Error('Phone fixture did not open its pairing UI');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${ui.baseUrl}/projects/${encodeURIComponent(scope.workspace.workspaceId)}/services?happier_hmr=0`,
      { waitUntil: 'domcontentloaded' });
    await page.getByText('Phone native database', { exact: true }).click();
    await page.getByText('sentinel', { exact: true }).click();
    await expect(page.getByText('dbw_selected', { exact: true })).toBeVisible();

    // G1: complete an admitted phone edit before any error or refusal assertions.
    await page.getByText('dbw_selected', { exact: true }).click();
    await page.getByRole('textbox', { name: 'target', exact: true }).fill('phone-committed');
    await page.getByRole('textbox', { name: 'target', exact: true }).press('Enter');
    await page.getByRole('button', { name: 'Review', exact: true }).click();
    await expect(page.getByText(/dbw_selected → phone-committed/)).toBeVisible();
    await page.setViewportSize({ width: 1100, height: 844 });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByText(/dbw_selected → phone-committed/)).toBeVisible();
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect.poll(() => pairedFixture.postgres.sql('dbw_selected', 'SELECT target FROM sentinel WHERE id = 1'))
      .toBe('phone-committed');

    // Resizing keeps the mounted workbench and its selected relation usable.
    await page.setViewportSize({ width: 1100, height: 844 });
    await page.getByRole('button', { name: 'Console', exact: true }).click();
    const editor = page.locator('[contenteditable="true"]').first();
    await editor.fill('SELECT target FROM public.sentinel WHERE id = 1');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(editor).toContainText('SELECT target FROM public.sentinel WHERE id = 1');
    await expect(editor).toBeFocused();
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.getByText('phone-committed', { exact: true })).toBeVisible();
    console.info('DBW-F13-known-good-phone-apply', { ...fixture.runtime, uiMode: ui.mode, uiPid: ui.proc?.child.pid });

    // A genuine native syntax error must reach the mounted UI with SQLSTATE;
    // the next valid run uses the same surface and proves visible recovery.
    await editor.fill('SELECT FROM');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.getByText('42601', { exact: true })).toBeVisible();
    await editor.fill('SELECT target FROM public.sentinel WHERE id = 1');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.getByText('phone-committed', { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 1100, height: 844 });
    await page.getByText('sentinel', { exact: true }).click();
    await page.getByRole('radio', { name: 'Structure', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByText('target', { exact: true }).first()).toBeVisible();
    await page.screenshot({ path: join(testDir, 'phone-structure.png'), fullPage: true });
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByText('Insights', { exact: true }).click();
    await expect(page.getByText('Statements', { exact: true })).toBeVisible();

    // The producer's partial cell cannot become an editable truncated value.
    // Returning to the complete relation must leave ordinary editing usable.
    await page.setViewportSize({ width: 1100, height: 844 });
    await page.getByText('large_value', { exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByText('large-sentinel', { exact: true }).click();
    await expect(page.getByText(/^x+…$/).first()).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'payload', exact: true })).toHaveCount(0);
    expect(await fixture.postgres.sql('dbw_selected', 'SELECT octet_length(payload) FROM large_value WHERE id = 1'))
      .toBe(String(fullValueBytes));
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.setViewportSize({ width: 1100, height: 844 });
    await page.getByText('sentinel', { exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByText('phone-committed', { exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'target', exact: true })).toHaveValue('phone-committed');
  } finally {
    try { await ui?.stop(); } finally { await fixture?.stop(); }
  }
});
