import * as React from 'react';
import type { Href } from 'expo-router';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';

/** Where an Add's outcome lines lead: Settings › Pets (a full library) and Settings › Features (pet sync off). */
export function usePetSettingsOpeners() {
  const router = useRouter();
  return React.useMemo(
    () => ({
      pets: () => router.push(SETTINGS_ROUTES.pets as Href),
      features: () => router.push(SETTINGS_ROUTES.features as Href),
    }),
    [router],
  );
}
