import { expect, test } from '@playwright/test';

import { dragSessionToTarget } from '../../src/testkit/uiE2e/sessionFoldersPointerDrag';

test('session drag keeps its drop target in the scroll viewport after revealing a distant source', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.setContent(`
    <div style="position:fixed;top:170px;bottom:0;width:384px;overflow:auto">
      <div data-testid="session-folder-drag-row-target" style="height:32px">
        <button data-testid="session-folder-header-target">Target folder</button>
      </div>
      <div style="height:900px"></div>
      <div data-testid="session-list-item-source" style="height:40px">
        <div data-testid="session-item-right-area">
          <button data-testid="session-item-reorder-handle">Drag source</button>
        </div>
      </div>
      <div style="height:100px"></div>
    </div>
    <script>
      const handle = document.querySelector('[data-testid="session-item-reorder-handle"]');
      handle.addEventListener('pointerdown', (event) => handle.setPointerCapture(event.pointerId));
      handle.addEventListener('pointerup', (event) => {
        const target = document.elementFromPoint(event.clientX, event.clientY);
        document.body.dataset.droppedOnTarget = String(Boolean(target?.closest('[data-testid="session-folder-drag-row-target"]')));
      });
    </script>
  `);

  const result = await dragSessionToTarget(page, {
    sessionId: 'source',
    targetTestId: 'session-folder-header-target',
    targetEdge: 'middle',
  });

  expect(result.ok).toBe(true);
  await expect(page.locator('body')).toHaveAttribute('data-dropped-on-target', 'true');
});

test('session drag activates toward the viewport interior above an overlaid footer', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.setContent(`
    <div style="position:fixed;top:170px;bottom:0;width:384px;overflow:auto">
      <div data-testid="session-folder-drag-row-target" style="height:32px">
        <button data-testid="session-folder-header-target">Target folder</button>
      </div>
      <div style="height:613px"></div>
      <div data-testid="session-list-item-source" style="height:40px">
        <div data-testid="session-item-right-area">
          <button data-testid="session-item-reorder-handle" style="height:40px">Drag source</button>
        </div>
      </div>
      <div style="height:100px"></div>
    </div>
    <div id="footer" style="position:fixed;top:840px;bottom:0;left:0;width:384px">Footer</div>
    <script>
      document.addEventListener('pointermove', (event) => {
        if (event.buttons !== 1 || document.body.dataset.activationOverFooter) return;
        document.body.dataset.activationOverFooter = String(document.elementFromPoint(event.clientX, event.clientY)?.id === 'footer');
      });
    </script>
  `);

  await dragSessionToTarget(page, {
    sessionId: 'source',
    targetTestId: 'session-folder-header-target',
    targetEdge: 'middle',
    scrollDuringDrag: 'target-into-view',
  });

  await expect(page.locator('body')).toHaveAttribute('data-activation-over-footer', 'false');
});
