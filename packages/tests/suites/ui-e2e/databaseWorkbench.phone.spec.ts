import { expect, test } from '@playwright/test';
import { join } from 'node:path';

import { EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES } from '@happier-dev/plugin-sdk/actions';

import { createRunDirs } from '../../src/testkit/runDir';
import { startDatabaseWorkbenchBrowser } from '../../src/testkit/uiE2e/databaseWorkbenchBrowser';
import { focusMonacoEditor } from '../../src/testkit/uiE2e/focusMonacoEditor';

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
    await page.getByRole('button', { name: 'sentinel', exact: true }).click();
    await expect(page.getByText('dbw_selected', { exact: true })).toBeVisible();

    // G1: complete an admitted phone edit before any error or refusal assertions.
    await page.getByText('dbw_selected', { exact: true }).click();
    await page.getByRole('textbox', { name: 'target', exact: true }).fill('phone-committed');
    await page.getByRole('textbox', { name: 'target', exact: true }).press('Enter');
    await page.getByRole('button', { name: 'Review', exact: true }).click();
    const reviewedChange = page.getByRole('group', { name: 'sentinel', exact: true }).locator('code');
    const expectReview = async () => {
      await expect(page.getByText('Review 1 change', { exact: true }).filter({ visible: true })).toBeVisible();
      await expect(reviewedChange).toBeVisible();
      await expect(reviewedChange).toContainText('dbw_selected');
      await expect(reviewedChange).toContainText('phone-committed');
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
    const editorSurface = page.locator('body');
    const editor = editorSurface.locator('.monaco-editor');
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    const replaceSql = async (sql: string) => {
      await focusMonacoEditor(editorSurface);
      await page.keyboard.press(`${modifier}+A`);
      await page.keyboard.insertText(sql);
    };
    const selectTarget = 'SELECT target FROM public.sentinel WHERE id = 1';
    await replaceSql(selectTarget);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(editor.locator('.view-lines')).toContainText(selectTarget);
    await expect(editor.getByRole('textbox')).toBeFocused();
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.getByText('phone-committed', { exact: true })).toBeVisible();
    console.info('DBW-F13-known-good-phone-apply', { ...fixture.runtime, uiMode: ui.mode, uiPid: ui.proc?.child.pid });

    // A genuine native syntax error must reach the mounted UI with SQLSTATE;
    // the next valid run uses the same surface and proves visible recovery.
    await replaceSql('SELECT FROM');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await page.getByRole('button', { name: 'Details', exact: true }).click();
    await expect(page.getByText('42601', { exact: true })).toBeVisible();
    await replaceSql(selectTarget);
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.getByText('phone-committed', { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 1100, height: 844 });
    await page.getByRole('button', { name: 'sentinel', exact: true }).click();
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
    await page.getByRole('button', { name: 'large_value', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByText('large-sentinel', { exact: true }).click();
    const payloadField = page.getByRole('listitem').filter({
      has: page.getByText('payload', { exact: true }),
    });
    await expect(payloadField).toBeVisible();
    // The field also renders its label and character count. Check the value's text in the browser.
    const hasPartialPreview = await payloadField.evaluate((field) => {
      const textNodes = document.createTreeWalker(field, NodeFilter.SHOW_TEXT);
      for (let text = textNodes.nextNode(); text; text = textNodes.nextNode()) {
        if (text.nodeValue?.endsWith('x…')) return true;
      }
      return false;
    });
    expect(hasPartialPreview).toBe(true);
    await expect(page.getByRole('textbox', { name: 'payload', exact: true })).toHaveCount(0);
    expect(await fixture.sql('dbw_selected', 'SELECT octet_length(payload) FROM large_value WHERE id = 1'))
      .toBe(String(fullValueBytes));
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.setViewportSize({ width: 1100, height: 844 });
    await page.getByRole('button', { name: 'sentinel', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByText('phone-committed', { exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'target', exact: true })).toHaveValue('phone-committed');
  } finally {
    await fixture.stop();
  }
});
