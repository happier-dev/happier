import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseCaptureEndpointV1, DatabaseCaptureSummaryV1 } from '@happier-dev/plugin-sdk/database';
import { CaptureEndpoints, CaptureLogs, CaptureTraces } from '@happier-dev/plugin-ui/components';

import { PluginUiProvider } from '../PluginUiProvider.js';
import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../../surfaceFixture.testSupport.js';

describe('the public capture renderers', () => {
  it('renders selected endpoint and trace evidence and reads a truncated log body on demand', async () => {
    const endpoint = {
      method: 'GET', route: '/report', serviceName: 'reports', requestCount: 4,
      errorCount: 1, errorRate: 0.25, totalDurationMs: 60, databaseTimeMs: 12,
    } satisfies DatabaseCaptureEndpointV1;
    const trace = {
      id: 'trace', worktree: 'worktree', kind: 'span', source: 'otlp', at: 0,
      endpointMethod: 'POST', endpointRoute: '/submit', durationMs: 60, httpStatusCode: 503,
    } satisfies DatabaseCaptureSummaryV1;
    const log = {
      id: 'log', worktree: 'worktree', kind: 'log', source: 'otlp', at: 0,
      bodyPrefix: 'Request paused', bodyPrefixTruncated: true,
    } satisfies DatabaseCaptureSummaryV1;
    const readBody = vi.fn(async () => ({ text: 'Request paused while draining', secretMaskingIncomplete: false }));
    const onOpen = vi.fn();
    const context = createSurfaceContext();
    const view = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <CaptureEndpoints items={[endpoint]} loading={false} locale="en-GB" />
        <CaptureTraces items={[trace]} loading={false} locale="en-GB" onOpen={onOpen} />
        <CaptureLogs items={[log]} loading={false} locale="en-GB" readBody={readBody} />
      </PluginUiProvider>,
    );
    try {
      expect(view.container.textContent).toContain('/report');
      expect(view.container.textContent).toContain('503');
      act(() => { view.container.querySelector<HTMLElement>('[data-testid="telemetry.capture.trace.trace"]')!.click(); });
      expect(onOpen).toHaveBeenCalledWith(trace);
      expect(readBody).not.toHaveBeenCalled();
      await act(async () => {
        view.container.querySelector<HTMLElement>('[data-testid="telemetry.capture.log.log.open"]')!.click();
      });
      expect(readBody).toHaveBeenCalledExactlyOnceWith('log');
      expect(view.container.textContent).toContain('Request paused while draining');
    } finally {
      view.unmount();
    }
  });
});
