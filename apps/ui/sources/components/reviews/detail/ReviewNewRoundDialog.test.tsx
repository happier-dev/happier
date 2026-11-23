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

describe('Retrying reviewers that did not finish', () => {
  const titles: string[] = [];
  const subtitles: string[] = [];
  const startNothing = async () => ({ ok: true as const });
  function RetryHarness(props: Readonly<{ retried: readonly string[]; everyone?: boolean; onRetry?: () => void; reason?: string | null }>) {
    const [chrome, setChrome] = React.useState<CustomModalChromeConfig | null>(null);
    if (chrome?.kind === 'card' && typeof chrome.title === 'string') titles.push(chrome.title);
    if (chrome?.kind === 'card' && typeof chrome.subtitle === 'string') subtitles.push(chrome.subtitle);
    return <><ReviewNewRoundDialog previousRound={1} retrying={props.retried} retryingEveryone={props.everyone === true}
      reviewers={props.retried.map(name => ({ id: name, label: name, mark: null, continuity: null }))}
      ready={false} reason={props.reason ?? null} onRetry={props.onRetry}
      onStart={startNothing} onClose={onClose} setChrome={setChrome} />
      {chrome?.kind === 'card' ? chrome.footer : null}</>;
  }

  it('keeps the retried reviewer named while its Machine does not answer, with Retry on the reason line (U8 R4 P5)', async () => {
    const { t } = await import('@/text');
    const onRetry = vi.fn();
    titles.length = 0;
    const screen = await renderScreen(<RetryHarness retried={['Claude · step 1']} reason="It isn’t answering." onRetry={onRetry} />);
    try {
      expect(titles.at(-1)).toBe(t('reviewWalkthrough.detail.retryReviewer', { name: 'Claude · step 1' }));
      expect(screen.findByTestId('review-new-round:reviewer:Claude · step 1')).not.toBeNull();
      // The reason and its Retry are one line in the body; the footer no longer repeats the reason.
      expect(screen.findByTestId('review-new-round:unavailable')).not.toBeNull();
      expect(screen.findByTestId('review-new-round:failure')).toBeNull();
      await screen.pressByTestIdAsync('review-new-round:retry');
      expect(onRetry).toHaveBeenCalledOnce();
    } finally { await screen.unmount(); }
  });

  it('names a retry of several reviewers by their count', async () => {
    const { t } = await import('@/text');
    titles.length = 0;
    const screen = await renderScreen(<RetryHarness retried={['Claude · step 1', 'Claude · step 2']} />);
    try {
      expect(titles.at(-1)).toBe(t('reviewWalkthrough.detail.retryUnfinished', { count: 2 }));
      expect(screen.findByTestId('review-new-round:reviewer:Claude · step 2')).not.toBeNull();
    } finally { await screen.unmount(); }
  });

  it('says no "others" stay when every reviewer of the round is retried (U8 R5 P10)', async () => {
    const { t } = await import('@/text');
    subtitles.length = 0;
    const screen = await renderScreen(<RetryHarness retried={['Claude · step 1', 'Claude · step 2']} everyone />);
    try { expect(subtitles.at(-1)).toBe(t('reviewWalkthrough.detail.retryRoundDescriptionAll')); } finally { await screen.unmount(); }
  });

  it('keeps the retried rows in place while the preview loads, with no panel that collapses when it arrives (U8 R6)', async () => {
    const loading = await renderScreen(<ReviewNewRoundDialog previousRound={2} retrying={['Claude · step 2']}
      reviewers={[{ id: 'step-2-reviewer-1', label: 'Claude · step 2', mark: null, continuity: null }]} loading ready={false}
      onStart={startNothing} onClose={onClose} setChrome={() => {}} />);
    try {
      expect(loading.findByTestId('review-new-round:reviewer:step-2-reviewer-1')).not.toBeNull();
      const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
      expect(loading.findAllByType(SurfaceStateCard).filter(card => card.props.kind === 'loading')).toHaveLength(0);
      // The row says it is being checked where "starts fresh" lands, so Start isn't a dead button (U8 R7 R6c).
      const { t } = await import('@/text');
      expect(loading.findByTestId('review-new-round:reviewer:step-2-reviewer-1:checking')).not.toBeNull();
      expect(loading.getTextContent()).toContain(t('reviewWalkthrough.detail.checkingReviewer'));
    } finally { await loading.unmount(); }
  });
});
