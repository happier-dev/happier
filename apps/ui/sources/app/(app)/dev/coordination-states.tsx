import { Stack, useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { CoordinationStatesSpecimen } from '@/components/dev/coordination/CoordinationStatesSpecimen';
import { t } from '@/text';

/**
 * Dev-only: coordination states drawn by their real owners (lab coordination-v3). `?scene=followers` is People's
 * populated Followers sheet; `?scene=ask` (default) is a composer Ask's grouped target lines.
 */
export default function CoordinationStatesDevScreen() {
  const params = useLocalSearchParams<{ scene?: string }>();
  const followers = params.scene === 'followers';
  return (
    <>
      {/* The phone page takes its title from the screen header, as the Followers route sets it. */}
      {followers ? <Stack.Screen options={{ headerShown: true, title: t('session.collaboration.pane.followersTitle') }} /> : null}
      <CoordinationStatesSpecimen scene={followers ? 'followers' : 'ask'} />
    </>
  );
}
