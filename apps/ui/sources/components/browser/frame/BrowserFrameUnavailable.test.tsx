import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key) => key });
});

describe('BrowserFrameUnavailable', () => {
  it('uses the owner-supplied failed-start title and sentence without changing the card tree', async () => {
    const { BrowserFrameUnavailable } = await import('./BrowserFrameUnavailable');
    const screen = await renderScreen(<BrowserFrameUnavailable testID="frame" reasonCode="preview_ended" recovery={{
      serviceStartFailure: { reasonCode: 'plugin_managed_service_establishment_failed',
        title: 'Service couldn’t start', body: 'Lumen web stopped before it was ready.',
        recovery: { kind: 'reviewOutput', label: 'Review output', lines: ['Address already in use'] } },
    }} />);
    expect(screen.getTextContent()).toContain('Service couldn’t start');
    expect(screen.getTextContent()).toContain('Lumen web stopped before it was ready.');
    expect(screen.getTextContent()).not.toContain('browserShell.unavailable.previewEndedTitle');
  });

  it('offers the failed start\'s output through the Services disclosure, with Close tab as the exit', async () => {
    const { BrowserFrameUnavailable } = await import('./BrowserFrameUnavailable');
    const onClose = vi.fn();
    const onOpenServices = vi.fn();
    const screen = await renderScreen(<BrowserFrameUnavailable testID="frame" reasonCode="preview_ended" recovery={{
      serviceStartFailure: { reasonCode: 'plugin_managed_service_establishment_failed',
        title: 'Service couldn’t start', body: 'Lumen web stopped before it was ready.',
        recovery: { kind: 'reviewOutput', label: 'Review output', lines: ['Address already in use'] } },
      onOpenServices,
      onClose,
    }} />);
    // Closed, the output is one press away; the recovery label is not repeated in the sentence.
    expect(screen.getTextContent()).not.toContain('Address already in use');
    expect(screen.getTextContent().split('Review output').length - 1).toBe(1);
    await screen.pressByTestIdAsync('frame-output-toggle');
    expect(screen.getTextContent()).toContain('Address already in use');
    // The output replaces the generic way to Services; Close tab stays the exit.
    expect(screen.findByTestId('frame-ended-services')).toBeNull();
    await screen.pressByTestIdAsync('frame-ended-close');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps Go to Services for a failed start with no output to review', async () => {
    const { BrowserFrameUnavailable } = await import('./BrowserFrameUnavailable');
    const screen = await renderScreen(<BrowserFrameUnavailable testID="frame" reasonCode="preview_ended" recovery={{
      serviceStartFailure: { reasonCode: 'plugin_managed_service_establishment_failed',
        title: 'Service couldn’t start', body: 'Lumen web stopped before it was ready.' },
      onOpenServices: vi.fn(),
      onClose: vi.fn(),
    }} />);
    expect(screen.findByTestId('frame-output-toggle')).toBeNull();
    expect(screen.findByTestId('frame-ended-services')).toBeTruthy();
  });
  it('keeps a refused Open again reason once nothing runs the Service, and leads to Services instead', async () => {
    const { BrowserFrameUnavailable } =
      await import('./BrowserFrameUnavailable');
    const onOpenServices = vi.fn();
    const screen = await renderScreen(
      <BrowserFrameUnavailable
        testID="frame"
        reasonCode="preview_ended"
        recovery={{
          openAgainFailure:
            'Reading desk is no longer running. Check Services.',
          onOpenServices,
          onClose: vi.fn(),
        }}
      />,
    );
    expect(screen.getTextContent()).toContain(
      'Reading desk is no longer running. Check Services.',
    );
    expect(screen.findByTestId('frame-ended-open-again')).toBeNull();
    await screen.pressByTestIdAsync('frame-ended-services');
    expect(onOpenServices).toHaveBeenCalledTimes(1);
  });

  it('offers Try again on a preview it cannot reach, through the caller-owned reload', async () => {
    const { BrowserFrameUnavailable } =
      await import('./BrowserFrameUnavailable');
    const onTryAgain = vi.fn();
    const screen = await renderScreen(
      <BrowserFrameUnavailable
        testID="frame"
        reasonCode="preview_transport_unavailable"
        recovery={{ onTryAgain, onClose: vi.fn() }}
      />,
    );
    await screen.pressByTestIdAsync('frame-try-again');
    expect(onTryAgain).toHaveBeenCalledTimes(1);
    // An unreachable page is not an ended one: Close tab is the ended card's exit, not this card's.
    expect(screen.findByTestId('frame-ended-close')).toBeNull();
  });
  it('names the Machine a preview cannot be reached on, and keeps the unnamed sentence when it is unknown', async () => {
    const { BrowserFrameUnavailable } = await import('./BrowserFrameUnavailable');
    const named = await renderScreen(<BrowserFrameUnavailable testID="frame" reasonCode="preview_transport_unavailable"
      recovery={{ machineName: 'MacBook Pro', onTryAgain: vi.fn() }} />);
    expect(named.getTextContent()).toContain('browserShell.unavailable.previewTransportUnavailableNamed');
    const unnamed = await renderScreen(<BrowserFrameUnavailable testID="frame" reasonCode="preview_transport_unavailable"
      recovery={{ machineName: null, onTryAgain: vi.fn() }} />);
    expect(unnamed.getTextContent()).not.toContain('previewTransportUnavailableNamed');
    expect(unnamed.getTextContent()).toContain('browserShell.unavailable.previewTransportUnavailable');
  });
  it('leads a failed start with Start again, ahead of Close tab, bound to the Services outcome runner', async () => {
    const { BrowserFrameUnavailable } = await import('./BrowserFrameUnavailable');
    const run = vi.fn(async (_start: () => Promise<unknown>) => true);
    const screen = await renderScreen(<BrowserFrameUnavailable testID="frame" reasonCode="preview_ended" recovery={{
      serviceStartFailure: { reasonCode: 'plugin_managed_service_establishment_failed',
        title: 'Service couldn’t start', body: 'Lumen web stopped before it was ready.',
        recovery: { kind: 'reviewOutput', label: 'Review output', lines: ['Address already in use'] } },
      startAgain: { target: { id: 'managed:lumen-web', machineId: 'machine-a', title: 'Lumen web' } as never, serverId: 'home', run },
      onClose: vi.fn(),
    }} />);
    expect(screen.findByTestId('frame-ended-start-again')).toBeTruthy();
    expect(screen.findByTestId('frame-ended-close')).toBeTruthy();
    expect(screen.findByTestId('frame-ended-services')).toBeNull();
    await screen.pressByTestIdAsync('frame-ended-start-again');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('names the ended preview\'s Service in place of "its service" whenever the Service is known', async () => {
    const { BrowserFrameUnavailable } = await import('./BrowserFrameUnavailable');
    const running = await renderScreen(<BrowserFrameUnavailable testID="frame" reasonCode="preview_ended" recovery={{
      lastPage: '/pricing', serviceName: 'Lumen web', onOpenAgain: vi.fn(), onClose: vi.fn(),
    }} />);
    expect(running.getTextContent()).toContain('browserShell.unavailable.previewEndedRunningNamed');
    const revoked = await renderScreen(<BrowserFrameUnavailable testID="frame" reasonCode="preview_ended" recovery={{
      serviceName: 'Lumen web', onOpenServices: vi.fn(), onClose: vi.fn(),
    }} />);
    expect(revoked.getTextContent()).toContain('browserShell.unavailable.previewEndedStoppedNamed');
    const noServices = await renderScreen(<BrowserFrameUnavailable testID="frame" reasonCode="preview_ended" recovery={{
      lastPage: '/pricing', serviceName: 'Lumen web', onClose: vi.fn(),
    }} />);
    expect(noServices.getTextContent()).toContain('browserShell.unavailable.previewEndedNamed');
  });

  it('leads with what happened and keeps the last page as its own quiet detail line, whatever the consequence', async () => {
    const { BrowserFrameUnavailable } = await import('./BrowserFrameUnavailable');
    const stopped = await renderScreen(<BrowserFrameUnavailable testID="frame" reasonCode="preview_ended" recovery={{
      lastPage: '/pricing', stoppedServiceName: 'Lumen web', onOpenServices: vi.fn(), onClose: vi.fn(),
    }} />);
    expect(stopped.getTextContent()).toContain('browserShell.unavailable.previewEndedServiceStopped');
    expect(stopped.findByTestId('frame-unavailable-detail')?.props.children).toBe('browserShell.unavailable.previewEndedLastPageDetail');
    const unknown = await renderScreen(<BrowserFrameUnavailable testID="frame" reasonCode="preview_ended" recovery={{
      lastPage: '/pricing', onOpenServices: vi.fn(), onClose: vi.fn(),
    }} />);
    expect(unknown.getTextContent()).not.toContain('previewEndedServiceStopped');
    expect(unknown.getTextContent()).toContain('browserShell.unavailable.previewEndedStopped');
    // No page known, no detail line.
    const pageless = await renderScreen(<BrowserFrameUnavailable testID="frame" reasonCode="preview_ended" recovery={{
      onOpenServices: vi.fn(), onClose: vi.fn(),
    }} />);
    expect(pageless.findByTestId('frame-unavailable-detail')).toBeNull();
  });

  it('keeps the refused Open again reason beside its retry action', async () => {
    const { BrowserFrameUnavailable } = await import('./BrowserFrameUnavailable');
    const screen = await renderScreen(<BrowserFrameUnavailable testID="frame" reasonCode="preview_ended" recovery={{
      serviceName: 'Lumen web', openAgainFailure: 'Lumen web is no longer listening.',
      onOpenAgain: vi.fn(), onClose: vi.fn(),
    }} />);
    expect(screen.findByTestId('frame-ended-open-again')).toBeTruthy();
    expect(screen.getTextContent()).toContain('Lumen web is no longer listening.');
    expect(screen.getTextContent()).not.toContain('browserShell.unavailable.previewEndedRunningNamed');
  });
});
