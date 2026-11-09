import { act } from 'react';
import { describe, expect, it } from 'vitest';

import { manifest } from '../fixtures/external-authoring/src/index.js';
import {
  REVIEW_READY_NOTICE_CATEGORY,
  sendReviewReadyNotice,
} from '../fixtures/external-authoring/src/reviewReadyNotice.js';
import { ReviewReadyNoticeExample } from '../fixtures/external-authoring/src/reviewReadyNoticeSurface.js';
import { PluginUiProvider } from './components/PluginUiProvider.js';
import { mountThroughReactNativeWeb } from './rnwMount.testSupport.js';
import {
  createHostApiStub,
  createSurfaceContext,
} from './surfaceFixture.testSupport.js';

describe('external author notice', () => {
  it('runs its own declared Action from the surface and says whether the notice went out', async () => {
    const executed: unknown[] = [];
    const context = createSurfaceContext();
    const mounted = mountThroughReactNativeWeb(
      <PluginUiProvider
        context={context}
        hostApi={createHostApiStub(context, {
          executeAction: (async (id: unknown, input: unknown) => {
            executed.push([id, input]);
            return null;
          }) as never,
        })}
      >
        <ReviewReadyNoticeExample />
      </PluginUiProvider>,
    );
    await act(async () => {
      (
        mounted.container.querySelector(
          '[data-testid="author-notice-send"]',
        ) as HTMLElement
      ).click();
    });
    expect(executed).toEqual([['send-review-ready-notice', {}]]);
    expect(
      mounted.container.querySelector('[data-testid="author-notice-status"]')
        ?.textContent,
    ).toBe('Notice sent');
    mounted.unmount();
  });

  it('declares the notice category and sends only that category through the host notifications service', async () => {
    expect(JSON.stringify(manifest)).toContain(
      `"${REVIEW_READY_NOTICE_CATEGORY}"`,
    );
    expect(JSON.stringify(manifest)).toContain('"send-review-ready-notice"');
    const sent: unknown[] = [];
    const signal = new AbortController().signal;
    await sendReviewReadyNotice(
      {
        send: (async (request: unknown, options: unknown) => {
          sent.push([request, options]);
          return { ok: true };
        }) as never,
      },
      signal,
    );
    expect(sent).toEqual([
      [
        {
          clientRequestId: 'external-review-ready',
          categoryId: REVIEW_READY_NOTICE_CATEGORY,
          title: 'Release review ready',
        },
        { signal },
      ],
    ]);
  });
});
