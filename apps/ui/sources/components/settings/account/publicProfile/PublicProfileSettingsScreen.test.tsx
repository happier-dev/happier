import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';
import { t } from '@/text';

const ownerRead = vi.hoisted(() => ({ value: null as unknown }));

// The mounted Action executor is the network boundary: it answers the owner read this page issues.
vi.mock('@/components/approvals/useMountedActionExecution', () => ({
  useMountedActionExecution: () => ({
    ready: true,
    executeValue: async () => ownerRead.value,
    execute: async () => ({ ok: true, result: { kind: 'updated' } }),
  }),
}));

// The server's feature snapshot is a network boundary; this Home offers public profiles.
vi.mock('@/hooks/server/useFeatureDecision', () => ({
  useFeatureDecision: () => ({ state: 'enabled' }),
}));

const context = { handle: 'leeroy', identity: {}, service: null, urls: null };
const restriction = { removedAtMs: 1_700_000_000_000, reason: 'Impersonation report' };
const unpublishedRecord = {
  state: 'draft', policy: null, metadata: null, projectSelections: [], query: null, snapshot: null,
  layout: null, appearance: null, updatedAtMs: 1_700_000_000_000, publishedAtMs: null, restriction,
};

async function renderOwnerPage() {
  // Imported after the boundary mocks are installed, as the Home governance suites do.
  const { PublicProfileSettingsScreen } = await import('./PublicProfileSettingsScreen');
  const screen = await renderScreen(<PublicProfileSettingsScreen />);
  // The owner read resolves asynchronously; settle on its answer rather than a fixed delay.
  for (let attempt = 0; attempt < 40 && screen.findByTestId('settings-public-profile-loading'); attempt += 1) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
  }
  return screen;
}

describe('PublicProfileSettingsScreen', () => {
  it('tells the owner why their page was removed even after they unpublished it', async () => {
    ownerRead.value = { kind: 'ready', record: unpublishedRecord, context };

    const screen = await renderOwnerPage();

    expect(screen.getTextContent()).toContain(t('publicIdentity.profile.restrictedTitle'));
    expect(screen.findByTestId('settings-public-profile-restricted')).toBeTruthy();
    expect(screen.getTextContent()).toContain('Impersonation report');
    expect(screen.getTextContent()).toContain(t('publicIdentity.profile.restrictedTitle'));
  });

  it('shows no removal notice for an unrestricted draft', async () => {
    ownerRead.value = { kind: 'ready', record: { ...unpublishedRecord, restriction: null }, context };

    const screen = await renderOwnerPage();

    expect(screen.findByTestId('settings-public-profile-restricted')).toBeNull();
  });
});
