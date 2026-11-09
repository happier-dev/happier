import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1, PUBLIC_PROFILE_FIELDS_V1, type PublicProfileField } from '@happier-dev/protocol/account/publicProfile';

import { renderScreen } from '@/dev/testkit';
import { t } from '@/text';
import type { PublicFieldPlacement } from './publicProfileDraft';
import { PublicProfilePublicData } from './PublicProfilePublicData';
import { PublicProfileConsentStatus } from './PublicProfileConsentStatus';

const placements = Object.fromEntries(PUBLIC_PROFILE_FIELDS_V1.map(field => [field, { shown: DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields[field], blocks: 0, heading: false }])) as Record<PublicProfileField, PublicFieldPlacement>;

describe('PublicProfilePublicData', () => {
  it('offers one switch per item, reflecting and changing only that item’s consent', async () => {
    const onToggle = vi.fn();
    const screen = await renderScreen(<PublicProfilePublicData policy={DEFAULT_PUBLIC_PROFILE_POLICY_V1}
      placements={{ ...placements, calendar: { shown: true, blocks: 2, heading: false } }} onToggle={onToggle} />);
    for (const field of PUBLIC_PROFILE_FIELDS_V1) {
      expect(screen.findByTestId(`public-data-switch-${field}`)?.props.value).toBe(DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields[field]);
    }
    screen.findByTestId('public-data-switch-calendar')!.props.onValueChange(false);
    expect(onToggle).toHaveBeenCalledWith('calendar', false);
    expect(screen.getTextContent()).toContain(t('publicIdentity.publicData.blocks', { count: 2 }));
  });

  it('explains items that reach only badges and JSON, and private placed items', async () => {
    const screen = await renderScreen(<PublicProfilePublicData policy={DEFAULT_PUBLIC_PROFILE_POLICY_V1}
      placements={{ ...placements, activeDays: { shown: true, blocks: 0, heading: false }, punch: { shown: false, blocks: 1, heading: false } }} onToggle={() => {}} />);
    expect(screen.getTextContent()).toContain(t('publicIdentity.publicData.notPlaced'));
    expect(screen.getTextContent()).toContain(t('publicIdentity.publicData.placedPrivate'));
  });

  it('says an identity item shown in the page heading is on the page, not only in badges and JSON', async () => {
    const screen = await renderScreen(<PublicProfilePublicData policy={DEFAULT_PUBLIC_PROFILE_POLICY_V1}
      placements={{ ...placements, name: { shown: true, blocks: 0, heading: true } }} onToggle={() => {}} />);
    const text = screen.getTextContent();
    expect(text).toContain(t('publicIdentity.publicData.heading'));
    // Every other shared item placed nowhere still reaches only badges and JSON.
    const shared = PUBLIC_PROFILE_FIELDS_V1.filter(field => DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields[field] && field !== 'weeklyPeakParallel').length;
    expect(text.split(t('publicIdentity.publicData.notPlaced')).length - 1).toBe(shared - 1);
  });

  it('keeps weekly peaks unavailable while peak parallel is not shared, and says why', async () => {
    const policy = { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1, fields: { ...DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields, peakParallel: false } };
    const screen = await renderScreen(<PublicProfilePublicData policy={policy} placements={placements} onToggle={() => {}} />);
    expect(screen.findByTestId('public-data-switch-weeklyPeakParallel')?.props.disabled).toBe(true);
    expect(screen.getTextContent()).toContain(t('publicIdentity.publicData.needsPeak'));
  });
});

describe('PublicProfileConsentStatus', () => {
  const tokens = () => t('publicIdentity.publicData.fields.tokens');

  it('names a pending change without claiming it is saved', async () => {
    const screen = await renderScreen(<PublicProfileConsentStatus state={{ kind: 'pending', field: 'tokens', shown: false }}
      onUndo={() => {}} onRetry={() => {}} onCheck={() => {}} />);
    expect(screen.getTextContent()).toContain(t('publicIdentity.publicData.consent.hiding', { item: tokens() }));
    expect(screen.getTextContent()).not.toContain(t('publicIdentity.publicData.consent.hidden', { item: tokens() }));
  });

  it('confirms an acknowledged hide and offers Undo', async () => {
    const onUndo = vi.fn();
    const screen = await renderScreen(<PublicProfileConsentStatus state={{ kind: 'acknowledged', field: 'tokens', previousShown: true }}
      onUndo={onUndo} onRetry={() => {}} onCheck={() => {}} />);
    expect(screen.getTextContent()).toContain(t('publicIdentity.publicData.consent.hidden', { item: tokens() }));
    await screen.pressByTestIdAsync('public-data-consent-action');
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it('presents an atomic sharing acknowledgement as shared and offers its direct Undo', async () => {
    const onUndo = vi.fn();
    const screen = await renderScreen(<PublicProfileConsentStatus state={{ kind: 'acknowledged', field: 'tokens', previousShown: false }}
      onUndo={onUndo} onRetry={() => {}} onCheck={() => {}} />);
    expect(screen.getTextContent()).toContain(t('publicIdentity.publicData.consent.shared', { item: tokens() }));
    await screen.pressByTestIdAsync('public-data-consent-action');
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it('keeps a refused change retryable and an uncertain one checkable, never claiming revocation', async () => {
    const onRetry = vi.fn();
    const refused = await renderScreen(<PublicProfileConsentStatus state={{ kind: 'failed', field: 'tokens', shown: false, errorCode: 'action_failed' }}
      onUndo={() => {}} onRetry={onRetry} onCheck={() => {}} />);
    expect(refused.getTextContent()).toContain(t('publicIdentity.publicData.consent.failedHide', { item: tokens() }));
    await refused.pressByTestIdAsync('public-data-consent-action');
    expect(onRetry).toHaveBeenCalledWith('tokens', false);
    const onCheck = vi.fn();
    const uncertain = await renderScreen(<PublicProfileConsentStatus state={{ kind: 'failed', field: 'tokens', shown: false, errorCode: 'action_uncertain' }}
      onUndo={() => {}} onRetry={() => {}} onCheck={onCheck} />);
    expect(uncertain.getTextContent()).toContain(t('publicIdentity.publicData.consent.uncertain', { item: tokens() }));
    await uncertain.pressByTestIdAsync('public-data-consent-action');
    expect(onCheck).toHaveBeenCalledTimes(1);
  });
});
