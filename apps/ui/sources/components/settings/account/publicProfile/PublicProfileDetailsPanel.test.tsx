import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1 } from '@happier-dev/protocol/account/publicProfile';
import type { PublicProfileMetadataSelectionV1 } from '@happier-dev/protocol/account/publicProfileIntents';

import { renderScreen } from '@/dev/testkit';
import { t } from '@/text';
import { PublicProfileDetailsPanel } from './PublicProfileDetailsPanel';

function Harness(
  props: Readonly<{
    onChange: (metadata: PublicProfileMetadataSelectionV1) => void;
  }>,
) {
  const [metadata, setMetadata] =
    React.useState<PublicProfileMetadataSelectionV1>({});
  return (
    <PublicProfileDetailsPanel
      scope={{ serverId: 'server', accountId: 'owner' }}
      policy={DEFAULT_PUBLIC_PROFILE_POLICY_V1}
      metadata={metadata}
      onMetadataChange={(next) => {
        setMetadata(next);
        props.onChange(next);
      }}
      period="90days"
      onPeriodChange={() => {}}
      theme="auto"
      themeUnavailableReason={null}
      onThemeChange={() => {}}
      hasAccountPhoto={false}
    />
  );
}

describe('PublicProfileDetailsPanel', () => {
  it('keeps the words and complete https links in the draft, and says when an item is not shared', async () => {
    const seen: PublicProfileMetadataSelectionV1[] = [];
    const screen = await renderScreen(
      <Harness onChange={(next) => seen.push(next)} />,
    );
    await act(async () => {
      screen
        .findByTestId('public-profile-details-bio')!
        .props.onChangeText('Building Happier.');
    });
    expect(seen.at(-1)).toEqual({ bio: 'Building Happier.' });
    await act(async () => {
      screen.findByTestId('public-profile-details-links.add')!.props.onPress();
    });
    await act(async () => {
      screen
        .findByTestId('public-profile-details-links.item.0')!
        .props.onChangeText('leeroy.dev');
    });
    // An address visitors could not open is never sent; the field says why.
    expect(seen.at(-1)).toEqual({ bio: 'Building Happier.' });
    expect(screen.getTextContent()).toContain(
      t('publicIdentity.details.linkInvalid'),
    );
    await act(async () => {
      screen
        .findByTestId('public-profile-details-links.item.0')!
        .props.onChangeText('https://leeroy.dev/');
    });
    expect(seen.at(-1)).toEqual({
      bio: 'Building Happier.',
      links: [{ label: 'leeroy.dev', url: 'https://leeroy.dev/' }],
    });
    // Bio and Links are off by default in Public data (Photo is on): one line says so, never one per row.
    const items = ['bio', 'links'].map((field) => t(`publicIdentity.publicData.fields.${field as 'bio'}`)).join(', ');
    expect(screen.getTextContent()).toContain(t('publicIdentity.details.notSharedMany', { items }));
    expect(screen.getTextContent()).not.toContain(t('publicIdentity.details.notShared', { item: t('publicIdentity.publicData.fields.bio') }));
  });
});
