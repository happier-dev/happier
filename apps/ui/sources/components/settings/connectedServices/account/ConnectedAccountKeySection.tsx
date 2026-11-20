import * as React from 'react';
import { connectedEntitySubjectKeyV1 } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { SharedSavedSecretValueItem } from '@/components/secrets/SharedSavedSecretValueItem';
import { useSavedSecretCatalogEntries } from '@/components/secrets/useSavedSecretCatalog';
import {
  useSavedSecretUsedBy,
  useSavedSecretUsedBySourcesDemand,
} from '@/components/secrets/useSavedSecretUsedBy';
import { SecretUsedByRows } from '@/components/settings/secrets/SecretsSettingsPage';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeResolution } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { t } from '@/text';

/**
 * An API-key account's key, on the account's own page (lab `crDetail-key`): the value row the Secret
 * page uses (Show and Copy) and what else picks the same key. The account detail owns the Replace action.
 */
export const ConnectedAccountKeySection = React.memo(
  function ConnectedAccountKeySection(
    props: Readonly<{
      testID: string;
      serverId: string;
      account: QualifiedConnectedAccountRef;
      savedSecretResourceIds: readonly string[];
      onReplace?: (ref: string) => void;
    }>,
  ) {
    const resolution = useServerCredentialAccountScopeResolution(
      props.serverId,
    );
    if (
      resolution.kind !== 'bound' ||
      props.savedSecretResourceIds.length === 0
    )
      return null;
    return <BoundKeySection {...props} scope={resolution.scope} />;
  },
);

function BoundKeySection(
  props: Readonly<{
    testID: string;
    scope: ServerAccountScope;
    account: QualifiedConnectedAccountRef;
    savedSecretResourceIds: readonly string[];
    onReplace?: (ref: string) => void;
  }>,
) {
  const router = useRouter();
  const refs = React.useMemo(
    () => props.savedSecretResourceIds.map(formatSharedSavedSecretRefV1),
    [props.savedSecretResourceIds],
  );
  const entries = useSavedSecretCatalogEntries({ scope: props.scope, refs });
  useSavedSecretUsedBySourcesDemand(props.scope);
  const firstRef = refs[0] ?? null;
  const usedBy = useSavedSecretUsedBy(props.scope, firstRef);
  // The account itself is the page; Used by lists everything else that picks this key.
  const self = React.useMemo(
    () => ({
      kind: 'connectedAccountCredential' as const,
      id: connectedEntitySubjectKeyV1({
        kind: 'account',
        account: props.account,
      }),
    }),
    [props.account],
  );
  const othersUseIt = (usedBy ?? []).some(
    (reference) =>
      !(
        reference.referrer?.kind === self.kind &&
        reference.referrer.id === self.id
      ),
  );
  if (entries.length === 0) return null;
  return (
    <ItemGroup
      title={t('connectedServicesSettings.detailKeyTitle')}
      description={
        othersUseIt
          ? t('connectedServicesSettings.detailKeyDescription')
          : undefined
      }
    >
      {entries.map((entry) => (
        <SharedSavedSecretValueItem
          key={entry.ref}
          testID={`${props.testID}:value`}
          scope={props.scope}
          entry={entry}
          active
          replaceTestID={`${props.testID}:replace`}
          onReplace={entry.capabilities.rotate && props.onReplace
            ? () => props.onReplace?.(entry.ref)
            : undefined}
        />
      ))}
      <SecretUsedByRows
        testID={`${props.testID}:used-by`}
        usedBy={usedBy}
        exclude={self}
        onOpen={(route) => router.push(route as never)}
      />
    </ItemGroup>
  );
}
