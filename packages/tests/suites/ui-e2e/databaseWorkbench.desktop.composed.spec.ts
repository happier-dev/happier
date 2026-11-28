import { expect, test, type Page } from '@playwright/test';
import { join } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startDatabaseWorkbenchBrowser } from '../../src/testkit/uiE2e/databaseWorkbenchBrowser';
import { focusMonacoEditor } from '../../src/testkit/uiE2e/focusMonacoEditor';

const run = createRunDirs({ runLabel: 'dbw-desktop' });

async function withWorkbench(page: Page, caseName: string,
  scenario: (fixture: Awaited<ReturnType<typeof startDatabaseWorkbenchBrowser>>) => Promise<void>) {
  const testDir = run.testDir(caseName);
  const fixture = await startDatabaseWorkbenchBrowser({ page, testDir, storageScope: `${run.runId}-${caseName}` });
  const { ui } = fixture;
  try {
    await fixture.sql('dbw_selected', `CREATE TABLE ui_stage (id text PRIMARY KEY, note text);
      INSERT INTO ui_stage VALUES ('first', 'before'), ('second', 'remove-me');`);
    await fixture.connectDatabase('Desktop native database');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await fixture.openDatabase('Desktop native database');
    await scenario(fixture);
    console.info(`${caseName}-loaded-runtime`, { ...fixture.runtime, uiMode: ui.mode, uiPid: ui.proc?.child.pid });
    await page.screenshot({ path: join(testDir, `${caseName}.png`), fullPage: true });
  } finally {
    await fixture.stop();
  }
}

test('F2 mounted Console stops native SQL and restores SQL history', async ({ page }) => {
  test.setTimeout(0);
  await withWorkbench(page, 'f2-console', async fixture => {
    await page.getByRole('button', { name: 'Console', exact: true }).click();
    const editorSurface = page.locator('body');
    const visibleSql = editorSurface.locator('.monaco-editor .view-lines');
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    const replaceSql = async (sql: string) => {
      await focusMonacoEditor(editorSurface);
      await page.keyboard.press(`${modifier}+A`);
      await page.keyboard.insertText(sql);
    };
    const controlSql = "SELECT 'desktop-control' AS result";
    await replaceSql(controlSql);
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.getByText('desktop-control', { exact: true })).toBeVisible();
    console.info('P2-F2-known-good-mounted-console', fixture.runtime);

    const activeQueryCount = () => fixture.sql('dbw_selected', `SELECT count(*) FROM pg_stat_activity
      WHERE pid <> pg_backend_pid() AND state = 'active' AND query LIKE '%DBW_DESKTOP_F2_STOP%'`);
    await replaceSql('SELECT pg_sleep(600) /* DBW_DESKTOP_F2_STOP */');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect.poll(activeQueryCount).toBe('1');
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect.poll(activeQueryCount).toBe('0');
    await expect(page.getByText('Stopped. Nothing was changed.', { exact: true })).toBeVisible();

    // A bad second statement must not run when only the first is selected.
    await replaceSql("SELECT 'selected-only' AS result;\nSELECT FROM");
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+ArrowLeft' : 'Shift+Home');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.getByText('selected-only', { exact: true })).toBeVisible();
    await replaceSql('SELECT FROM WHERE');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.getByText(/syntax error at or near/i)).toBeVisible();
    await expect(visibleSql.locator('.happier-editor-diagnostic-error')).toHaveText('W');
    await page.getByRole('button', { name: 'History', exact: true }).click();
    await page.getByText(controlSql, { exact: true }).click();
    await expect(visibleSql).toContainText(controlSql);
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.getByText('desktop-control', { exact: true })).toBeVisible();
  });
});

test('F3 mounted staged edits review old to new, insert and delete before Apply', async ({ page }) => {
  test.setTimeout(0);
  await withWorkbench(page, 'f3-staging', async fixture => {
    await page.getByRole('grid', { name: 'Tables', exact: true }).getByLabel('ui_stage', { exact: true }).click();
    await page.getByText('before', { exact: true }).click();
    const note = page.getByRole('textbox', { name: 'note', exact: true });
    await note.fill('after');
    await note.press('Enter');
    expect(await fixture.sql('dbw_selected', "SELECT note FROM ui_stage WHERE id='first'")).toBe('before');
    await page.getByRole('button', { name: 'Review', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Review 1 change', exact: true })).toBeVisible();
    await expect(page.getByText('before', { exact: true })).toBeVisible();
    await expect(page.getByText('after', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Apply 1 change', exact: true }).click();
    await expect.poll(() => fixture.sql('dbw_selected', "SELECT note FROM ui_stage WHERE id='first'"))
      .toBe('after');
    console.info('P2-F3-known-good-mounted-apply', fixture.runtime);

    await page.getByRole('button', { name: 'New row', exact: true }).click();
    await page.getByRole('textbox', { name: 'id', exact: true }).fill('third');
    const insertedNote = page.getByRole('textbox', { name: 'note', exact: true });
    await insertedNote.fill('inserted');
    await page.getByRole('button', { name: 'Stage row', exact: true }).click();
    await page.getByText('remove-me', { exact: true }).click();
    await page.getByRole('button', { name: 'Delete row', exact: true }).click();
    expect(await fixture.sql('dbw_selected', 'SELECT count(*) FROM ui_stage')).toBe('2');
    await page.getByRole('button', { name: 'Review', exact: true }).click();
    await expect(page.getByText('New row', { exact: true })).toBeVisible();
    await expect(page.getByText('Delete row', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Apply 2 changes', exact: true }).click();
    await expect.poll(() => fixture.sql('dbw_selected',
      "SELECT string_agg(id || ':' || note, ',' ORDER BY id) FROM ui_stage"))
      .toBe('first:after,third:inserted');
  });
});
