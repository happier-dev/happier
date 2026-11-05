import * as React from 'react';

import { useSavedSecretCatalog } from '@/components/secrets/useSavedSecretCatalog';
import {
  SavedSecretPickerModal,
  type SavedSecretPickerModalProps,
} from '@/components/ui/forms/valueRefs/SavedSecretPickerModal';
import { Modal } from '@/modal';
import { t } from '@/text';

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
    (props: Pick<Extract<SavedSecretPickerModalProps, { selectedId: string | null }>, 'selectedId' | 'includeNoneRow' | 'onSelectId'>) => {
      Modal.show({
        component: SavedSecretPickerModal,
        // Choosing a token binds one; renaming, replacing or deleting stored secrets stays in Settings → Secrets.
        props: { ...props, allowEdit: false },
        chrome: {
          kind: 'card',
          title: t('capabilities.registries.detail.tokenPickTitle'),
          scrollHost: 'bounded',
          bodyScroll: 'none',
          dimensions: { size: 'lg' },
        },
        closeOnBackdrop: true,
      });
    },
    [],
  );
  return React.useMemo(() => ({ nameOf, pick }), [nameOf, pick]);
}
