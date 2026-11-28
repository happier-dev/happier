import type { Locator } from '@playwright/test';
import { playwrightRunnerTestApi } from '../../../scripts/playwrightRunnerTestApi.mjs';

export async function focusMonacoEditor(editorSurface: Locator): Promise<void> {
  const { expect } = playwrightRunnerTestApi();
  const monacoRoot = editorSurface.locator('.monaco-editor');
  await expect(monacoRoot).toHaveCount(1, { timeout: 60_000 });
  await expect(monacoRoot).toBeVisible();

  // Monaco can use either a textarea or a native EditContext textbox. Its
  // separate, read-only IME textarea is not the editor's keyboard input. The
  // EditContext host is not a visible click target; focus it directly.
  const input = monacoRoot.getByRole('textbox');
  await input.focus();
  await expect(input).toBeFocused();
}
