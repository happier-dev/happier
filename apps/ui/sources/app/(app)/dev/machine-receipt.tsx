import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { MachineReceiptSpecimen } from '@/components/dev/machines/MachineReceiptSpecimen';

/** Dev-only: one provider's new-machine page and receipt (58d U8). `?provider=<pluginId/localId>&price=0.12`. */
export default function MachineReceiptDevScreen() {
  const params = useLocalSearchParams<{ provider?: string; price?: string; acquire?: string }>();
  return (
    <MachineReceiptSpecimen
      provider={typeof params.provider === 'string' ? params.provider : null}
      price={typeof params.price === 'string' ? params.price : null}
      acquire={typeof params.acquire === 'string' ? params.acquire : null}
    />
  );
}
