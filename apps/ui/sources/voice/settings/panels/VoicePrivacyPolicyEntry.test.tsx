import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { t } from '@/text';

/**
 * §2.8 / §7.3 — the one in-app privacy destination for Voice.
 *
 * No active Voice surface carries a provider/data-disclosure affordance any more,
 * so Voice settings is where a compliance entry point has to exist. It is
 * deliberately quiet — bottom of the screen, no interruption — but it still has
 * to be a real, reachable control that opens the public policy through the
 * canonical external-URL opener rather than a hand-rolled `Linking` call.
 */

const openExternalUrlSpy = vi.hoisted(() => vi.fn(
  async (_url: string, _options?: Record<string, unknown>) => true,
));

vi.mock('@/utils/url/openExternalUrl', () => ({
  openExternalUrl: (url: string, options?: Record<string, unknown>) => openExternalUrlSpy(url, options),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
  ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
  Item: (props: any) => React.createElement('Item', props),
}));

const SOURCES_ROOT = join(process.cwd(), 'sources');

describe('Voice settings privacy policy entry', () => {
  it('opens the public privacy policy through the canonical external-URL opener', async () => {
    openExternalUrlSpy.mockClear();
    const { HAPPIER_PRIVACY_POLICY_URL } = await import('@/constants/legalUrls');
    const { VoicePrivacyPolicyEntry } = await import('./VoicePrivacyPolicyEntry');
    const screen = await renderScreen(React.createElement(VoicePrivacyPolicyEntry));

    const items = screen.tree.root.findAllByType('Item' as any);
    expect(items).toHaveLength(1);
    const entry = items[0]!;
    expect(entry.props.title).toBe(t('settings.privacyPolicy'));

    // A row with an `onPress` is what makes `Item` render an interactive,
    // focusable, button-role control; a decorative row would not be reachable by
    // keyboard or a screen reader (§7.3).
    expect(typeof entry.props.onPress).toBe('function');

    await entry.props.onPress();
    expect(openExternalUrlSpy).toHaveBeenCalledTimes(1);
    expect(openExternalUrlSpy.mock.calls[0]?.[0]).toBe(HAPPIER_PRIVACY_POLICY_URL);

    await screen.unmount();
  });

  it('is mounted at the bottom of the Voice settings screen', () => {
    // A compliance entry point nobody renders is not an entry point. The route is
    // the production importer, and the placement — after every settings section —
    // is the "quiet" half of the §7.3 decision.
    const route = readFileSync(join(SOURCES_ROOT, 'app/(app)/settings/voice/privacy.tsx'), 'utf8');
    expect(route).toContain('VoicePrivacySettingsScreen');
    const detailScreen = readFileSync(join(SOURCES_ROOT, 'voice/settings/screens/VoicePrivacySettingsScreen.tsx'), 'utf8');

    const entryIndex = detailScreen.lastIndexOf('<VoicePrivacyPolicyEntry');
    expect(entryIndex).toBeGreaterThan(-1);
    for (const precedingSection of [
      '<VoicePrivacySection',
      '<VoiceHistorySettingsEntry',
    ]) {
      expect(detailScreen.lastIndexOf(precedingSection)).toBeLessThan(entryIndex);
    }
  });

  it('leaves the privacy-policy URL with a single owner', () => {
    // Two hardcoded copies of the same legal URL is how one of them goes stale.
    const about = readFileSync(join(SOURCES_ROOT, 'components/settings/SettingsAboutSection.tsx'), 'utf8');
    expect(about).not.toContain("'https://docs.happier.dev/legal/privacy'");
    expect(about).toContain('HAPPIER_PRIVACY_POLICY_URL');
  });
});
