import { describe, expect, it } from 'vitest';

import { createUnavailableBrowserContextSource } from './source';

const target = { browserSessionId: 'browser_session_1', viewId: 'view_1', navigationGeneration: 1 } as const;

describe('unavailable browser context source', () => {
  it('reports adapter_unavailable for every capture command', async () => {
    const source = createUnavailableBrowserContextSource();

    const page = await source.capturePage(target);
    const screenshot = await source.captureScreenshot(target);
    const summary = await source.captureSummary({ ...target, kind: 'browserNetworkSummary' });
    const element = await source.captureSelectedElement(target);

    for (const result of [page, screenshot, summary, element]) {
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe('adapter_unavailable');
    }
  });
});
