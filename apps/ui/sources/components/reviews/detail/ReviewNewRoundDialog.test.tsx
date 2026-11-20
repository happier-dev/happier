import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import type { CustomModalChromeConfig } from '@/modal/types';
import { ReviewNewRoundDialog } from './ReviewNewRoundDialog';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

const onClose = () => {};

function Harness(props: Readonly<{ paid?: boolean; onStart: (accepted: boolean) => Promise<{ ok: true } | { ok: false; message: string }> }>) {
  const [chrome, setChrome] = React.useState<CustomModalChromeConfig | null>(null);
  return <><ReviewNewRoundDialog previousRound={1} reviewers={[{ id: 'paid', label: 'Paid reviewer', mark: null,
    continuity: 'fresh', ...(props.paid === false ? {} : { costConsent: { title: 'Accept estimate' } }) }]}
    onStart={props.onStart} onClose={onClose} setChrome={setChrome} />{chrome?.kind === 'card' ? chrome.footer : null}</>;
}

describe('New round paid confirmation', () => {
  it('requires a fresh choice in the existing confirmation and resets it when opened again', async () => {
    const accepted: boolean[] = [];
    const onStart = async (value: boolean) => { accepted.push(value); return { ok: true as const }; };
    const screen = await renderScreen(<Harness onStart={onStart} />);
    expect(screen.findHostByTestId('review-new-round:start')?.props.accessibilityState?.disabled).toBe(true);
    await screen.pressByTestIdAsync('review-start-cost-consent');
    await screen.pressByTestIdAsync('review-new-round:start');
    expect(accepted).toEqual([true]);
    await screen.unmount();
    const reopened = await renderScreen(<Harness onStart={onStart} />);
    const checkbox = reopened.findHostByTestId('review-start-cost-consent');
    expect(checkbox?.props.accessibilityState?.checked ?? checkbox?.props['aria-checked']).toBe(false);
    await reopened.unmount();
  });

  it('asks again after a failed paid start and leaves a free start available', async () => {
    const accepted: boolean[] = [];
    const screen = await renderScreen(<Harness onStart={async value => {
      accepted.push(value);
      return { ok: false, message: 'Unavailable' };
    }} />);
    await screen.pressByTestIdAsync('review-start-cost-consent');
    await screen.pressByTestIdAsync('review-new-round:start');
    expect(accepted).toEqual([true]);
    expect(screen.findHostByTestId('review-new-round:start')?.props.accessibilityState?.disabled).toBe(true);
    expect(screen.findHostByTestId('review-start-cost-consent')?.props.accessibilityState?.checked).toBe(false);
    await screen.unmount();
    const free = await renderScreen(<Harness paid={false} onStart={async value => { accepted.push(value); return { ok: true }; }} />);
    expect(free.findHostByTestId('review-new-round:start')?.props.accessibilityState?.disabled).toBe(false);
    await free.pressByTestIdAsync('review-new-round:start');
    expect(accepted).toEqual([true, false]);
    await free.unmount();
  });
});
