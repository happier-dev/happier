import * as React from 'react';
import type { SavedSecretCatalogEntryV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import type { SharedSavedSecretRevealInputV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';

import { SharedSavedSecretValueItem } from '@/components/secrets/SharedSavedSecretValueItem';
import { useSavedSecretCatalogEntries } from '@/components/secrets/useSavedSecretCatalog';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Modal } from '@/modal';
import type { CustomModalInjectedProps } from '@/modal/types';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { observeSavedSecretCatalog } from '@/sync/engine/settings/savedSecretCatalogEngine';
import {
  getSavedSecretCatalogSnapshot,
  readSavedSecretCatalogEntry,
  subscribeSavedSecretCatalogSnapshots,
} from '@/sync/store/settings/savedSecretCatalogSnapshot';
import { t } from '@/text';

const resourceChanged = {
  ok: false,
  errorCode: 'resource_changed',
  error: 'resource_changed',
} as const;

function isFailure(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    'ok' in result &&
    result.ok === false
  );
}

function ApprovedSavedSecretRevealSheet(
  props: CustomModalInjectedProps &
    Readonly<{
      scope: ServerAccountScope;
      entry: SavedSecretCatalogEntryV1;
      input: SharedSavedSecretRevealInputV1;
      onSettled: (result: unknown) => void;
    }>,
) {
  // The row's custody follows the live catalog entry, so a rename, rotation or lost access hides it.
  const entries = useSavedSecretCatalogEntries({ scope: props.scope });
  const entry =
    entries.find((candidate) => candidate.ref === props.entry.ref) ??
    props.entry;
  const { onClose, onSettled } = props;
  const approvedReveal = React.useMemo(
    () => ({
      input: props.input,
      onSettled: (result: unknown) => {
        onSettled(result);
        // The approval card owns the one failure message; an empty sheet would be a second.
        if (isFailure(result)) onClose();
      },
    }),
    [onClose, onSettled, props.input],
  );
  return (
    <ItemGroup description={t('secretsSettings.revealConfirmBody')}>
      <SharedSavedSecretValueItem
        testID="approved-saved-secret-value"
        scope={props.scope}
        entry={entry}
        active
        approvedReveal={approvedReveal}
      />
    </ItemGroup>
  );
}

/** The approving app may not have this Account's catalog loaded; read its metadata until it settles. */
async function readSettledCatalogEntry(
  scope: ServerAccountScope,
  ref: string,
): Promise<SavedSecretCatalogEntryV1 | null> {
  const settled = () => {
    const snapshot = getSavedSecretCatalogSnapshot(scope);
    return readSavedSecretCatalogEntry(scope, ref) !== null
      || snapshot?.status === 'ready' || snapshot?.status === 'error';
  };
  const release = observeSavedSecretCatalog(scope, { includeMaterial: false });
  try {
    await new Promise<void>((resolve) => {
      if (settled()) return resolve();
      const unsubscribe = subscribeSavedSecretCatalogSnapshots(() => {
        if (!settled()) return;
        unsubscribe();
        resolve();
      }, { scope, refs: [ref] });
    });
    return readSavedSecretCatalogEntry(scope, ref);
  } finally {
    release();
  }
}

/**
 * The display port for a Saved Secret reveal the person allowed: a sheet over the Session holding the
 * shared value row. The value lives only in that row's custody; the replay gets the value-free outcome
 * (`displayed` with its history entry, `cancelled` if the sheet closes first, or the typed refusal).
 */
export async function presentApprovedSavedSecretReveal(
  serverId: string,
  input: SharedSavedSecretRevealInputV1,
): Promise<unknown> {
  // The Account that decided the request on this Home; the row re-checks it before opening the value.
  const account = await captureLazyActionAccountContext(serverId);
  const scope = { ...account.accountLifetime.scope };
  account.dispose();
  const entry = await readSettledCatalogEntry(scope, input.ref);
  if (!entry) return resourceChanged;
  return await new Promise<unknown>((resolve) => {
    let settled = false;
    const settle = (result: unknown) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    Modal.show({
      component: ApprovedSavedSecretRevealSheet,
      props: { scope, entry, input, onSettled: settle },
      chrome: {
        kind: 'card',
        title: entry.name ?? t('secrets.catalog.unavailableName'),
        phonePresentation: 'sheet',
        testID: 'approved-saved-secret-sheet',
      },
      onRequestClose: () => settle({ status: 'cancelled' }),
      onHostUnmount: () => settle({ status: 'cancelled' }),
    });
  });
}
