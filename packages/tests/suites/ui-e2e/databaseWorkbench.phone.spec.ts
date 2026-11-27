import { expect, test } from '@playwright/test';
import { join } from 'node:path';

import { EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES } from '@happier-dev/plugin-sdk/actions';

import { createRunDirs } from '../../src/testkit/runDir';
import { startDatabaseWorkbenchBrowser } from '../../src/testkit/uiE2e/databaseWorkbenchBrowser';

const run = createRunDirs({ runLabel: 'dbw-phone' });

// The UI consumes real owner admission and a saved-secret target. Native SQL is
// used only to observe committed effects, never to replace a UI operation.
test('DBW-F13 phone_browse_console_insights_review_continuity', async ({ page }) => {
  test.setTimeout(0);
  const testDir = run.testDir('phone-workbench');
  const fixture = await startDatabaseWorkbenchBrowser({ page, testDir, storageScope: run.runId });
  const { ui } = fixture;
  try {
    await fixture.connectDatabase('Phone native database');
    // Cross the real Action envelope boundary rather than inventing a UI cap.
    const fullValueBytes = EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES + 1;
    await fixture.sql('dbw_selected', `CREATE TABLE large_value (id bigint PRIMARY KEY, marker text, payload text);
      INSERT INTO large_value VALUES (1, 'large-sentinel', repeat('x', ${fullValueBytes}));`);

    await page.setViewportSize({ width: 390, height: 844 });
    await fixture.openDatabase('Phone native database');
    await page.getByLabel('sentinel', { exact: true }).click();
    await expect(page.getByText('dbw_selected', { exact: true })).toBeVisible();

    // G1: complete an admitted phone edit before any error or refusal assertions.
    await page.getByText('dbw_selected', { exact: true }).click();
    await page.getByRole('textbox', { name: 'target', exact: true }).fill('phone-committed');
    await page.getByRole('textbox', { name: 'target', exact: true }).press('Enter');
    await page.getByRole('button', { name: 'Review', exact: true }).click();
    const expectReview = async () => {
      await expect(page.getByRole('heading', { name: 'Review 1 change', exact: true })).toBeVisible();
      await expect(page.getByText('dbw_selected', { exact: true }).filter({ visible: true }).last()).toBeVisible();
      await expect(page.getByText('phone-committed', { exact: true }).filter({ visible: true }).last()).toBeVisible();
    };
    await expectReview();
    await page.setViewportSize({ width: 1100, height: 844 });
    await page.setViewportSize({ width: 390, height: 844 });
    await expectReview();
    await page.getByRole('button', { name: 'Apply 1 change', exact: true }).click();
    await expect.poll(() => fixture.sql('dbw_selected', 'SELECT target FROM sentinel WHERE id = 1'))
      .toBe('phone-committed');

    // Resizing keeps the mounted workbench and its selected relation usable.
    await page.setViewportSize({ width: 1100, height: 844 });
    await page.getByRole('button', { name: 'Console', exact: true }).click();
    const editor = page.locator('textarea:visible, [contenteditable="true"]:visible').first();
    await editor.fill('SELECT target FROM public.sentinel WHERE id = 1');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => editor.evaluate((element) =>
      element instanceof HTMLTextAreaElement ? element.value : element.textContent))
      .toContain('SELECT target FROM public.sentinel WHERE id = 1');
    await expect(editor).toBeFocused();
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.getByText('phone-committed', { exact: true })).toBeVisible();
    console.info('DBW-F13-known-good-phone-apply', { ...fixture.runtime, uiMode: ui.mode, uiPid: ui.proc?.child.pid });

    // A genuine native syntax error must reach the mounted UI with SQLSTATE;
    // the next valid run uses the same surface and proves visible recovery.
    await editor.fill('SELECT FROM');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await page.getByRole('button', { name: 'Details', exact: true }).click();
    await expect(page.getByText('42601', { exact: true })).toBeVisible();
    await editor.fill('SELECT target FROM public.sentinel WHERE id = 1');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.getByText('phone-committed', { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 1100, height: 844 });
    await page.getByLabel('sentinel', { exact: true }).click();
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
    await page.getByLabel('large_value', { exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByText(/^large-sentinel · /).click();
    await expect(page.getByText(/^x+…$/).first()).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'payload', exact: true })).toHaveCount(0);
    expect(await fixture.sql('dbw_selected', 'SELECT octet_length(payload) FROM large_value WHERE id = 1'))
      .toBe(String(fullValueBytes));
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.setViewportSize({ width: 1100, height: 844 });
    await page.getByLabel('sentinel', { exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByText('phone-committed', { exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'target', exact: true })).toHaveValue('phone-committed');
  } finally {
    await fixture.stop();
  }
});
