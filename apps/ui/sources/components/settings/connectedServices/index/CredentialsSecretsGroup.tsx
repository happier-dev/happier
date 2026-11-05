import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import type { SavedSecretCatalogEntryV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';

import { useSavedSecretCatalog } from '@/components/secrets/useSavedSecretCatalog';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { t } from '@/text';

import { buildCredentialsSecretRoute } from '../collection/connectedServicesCollectionRoutes';
import { presentCredentialsSecretsState, type CredentialsSecretsState } from './credentialsSecretsState';

/** "Only you", or how many people and Teams can use it (the access summary the Secrets page shows). */
export function presentSavedSecretAudience(
  entry: SavedSecretCatalogEntryV1,
): string {
  const audience = entry.audience;
  const count = audience
    ? audience.accounts.length + audience.teams.length + audience.groups.length
    : 0;
  return count === 0
    ? t('secretsSettings.accessOnlyYou')
    : t('secretsSettings.accessRecipients', { count });
}

/** The secret's type word ("API key", "Token"); a row the Home cannot fully read may not carry one. */
export function presentSavedSecretKind(
  entry: SavedSecretCatalogEntryV1,
): string | null {
  return entry.kind ? t(`secrets.catalog.kinds.${entry.kind}`) : null;
}

/**
 * Your Saved Secrets for Credentials, read once for the rail and the overview: the ones you own (the
 * catalog's metadata only, never values) and the one state both show (`presentCredentialsSecretsState`).
 */
export function useCredentialsSecrets(): Readonly<{
  owned: readonly SavedSecretCatalogEntryV1[];
  state: CredentialsSecretsState;
  retry: () => void;
}> {
  const catalog = useSavedSecretCatalog({ includeMaterial: false });
  const owned = React.useMemo(
    () => catalog.entries.filter((entry) => entry.relationship === 'owner'),
    [catalog.entries],
  );
  const state = presentCredentialsSecretsState({ status: catalog.status, stale: catalog.stale, ownedCount: owned.length });
  const reload = catalog.reload;
  const retry = React.useCallback(() => { void reload().catch(() => undefined); }, [reload]);
  return { owned, state, retry };
}

/**
 * Credentials' Secrets section (lab `cr` crHome A): the Saved Secrets you own that aren't tied to one
 * service, as rows like the page's others (key · name · type · who can use it), each opening the secret
 * beside the rail. Loading, a failed read and none say so in place, in step with the rail.
 */
export const CredentialsSecretsGroup = React.memo(function CredentialsSecretsGroup(props: Readonly<{
  onOpen: (href: string) => void;
}>) {
  const { theme } = useUnistyles();
  const { owned, state, retry } = useCredentialsSecrets();
  return (
    <ItemGroup
      testID="credentials-secrets"
      title={t('connectedServicesCollection.secretsGroup')}
      description={t('connectedServicesCollection.secretsDescription')}
      action={(
        <SectionActionButton
          testID="credentials-secrets:new"
          icon="plus"
          title={t('connectedServicesCollection.newSecret')}
          onPress={() => props.onOpen(buildCredentialsSecretRoute({ add: true }))}
        />
      )}
    >
      {state === 'loading' || state === 'failed' ? (
        <SectionContentRow>
          <SurfaceStateCard
            testID="credentials-secrets:pending"
            kind={state === 'failed' ? 'warning' : 'loading'}
            size="line"
            title={state === 'failed' ? t('secretsSettings.staleTitle') : t('common.loading')}
            action={state === 'failed' ? { label: t('common.retry'), onPress: retry } : undefined}
          />
        </SectionContentRow>
      ) : state === 'empty' ? (
        <EmptyState
          testID="credentials-secrets:empty"
          layout="line"
          title={t('secretsSettings.emptyTitle')}
          subtitle={t('secretsSettings.emptyDescription')}
        />
      ) : owned.map((entry) => (
        <Item
          key={entry.ref}
          testID={`credentials-secret:${entry.ref}`}
          title={entry.name ?? t('secrets.catalog.unavailableName')}
          subtitle={presentSavedSecretKind(entry) ?? undefined}
          icon={<Icon name="key" size={18} color={theme.colors.text.secondary} />}
          detail={presentSavedSecretAudience(entry)}
          onPress={() => props.onOpen(buildCredentialsSecretRoute({ ref: entry.ref }))}
        />
      ))}
    </ItemGroup>
  );
});
