import type { PopoverAnchor } from '@/components/ui/popover';
import * as React from 'react';

import { useSavedSecretCatalog } from '@/components/secrets/useSavedSecretCatalog';
import { presentConnectSheet } from '@/components/settings/connectedServices/setup/ConnectedServiceSetupModal';

/**
 * The one way a registry token is chosen (P4 F3/F4): a private Saved Secret from the picker, named back by its
 * label. The add form and a registry's detail both read it, so a token never has two pickers.
 */
export function useRegistryTokenPicker() {
  const catalog = useSavedSecretCatalog();
  const { personalSecrets, sharedEntries } = catalog.picker;
  const nameOf = React.useCallback(
    (secretRef: string | null): string | null =>
      secretRef === null
        ? null
        : (personalSecrets.find((secret) => secret.id === secretRef)?.name ??
          sharedEntries.find((entry) => entry.ref === secretRef)?.name ??
          null),
    [personalSecrets, sharedEntries],
  );
  const pick = React.useCallback(
    (props: Readonly<{
      selectedId: string | null;
      anchor?: PopoverAnchor;
      includeNoneRow?: boolean;
      onSelectId: (secretRef: string | null) => void;
    }>) => {
      void presentConnectSheet({
        service: { kind: 'key', keyKind: 'token' },
        anchor: props.anchor,
        ...(props.selectedId ? { current: props.selectedId } : {}),
      }).then(result => {
        if (result.kind !== 'dismissed') props.onSelectId(result.secretRef);
      });
    },
    [],
  );
  return React.useMemo(() => ({ nameOf, pick }), [nameOf, pick]);
}
