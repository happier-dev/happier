import * as React from 'react';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { useUnistyles } from 'react-native-unistyles';
import type { SavedSecretCatalogEntryV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';

import { useSavedSecretCatalog } from '@/components/secrets/useSavedSecretCatalog';
import { savedSecretAudienceSummary, savedSecretEntryKindLabel, sharedSecretProvenanceSegments } from '@/components/secrets/savedSecretRowCopy';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { t } from '@/text';

import { buildCredentialsSecretRoute } from '../collection/connectedServicesCollectionRoutes';
import { presentCredentialsSecretsState, type CredentialsSecretsState } from './credentialsSecretsState';

/**
 * Your Saved Secrets for Credentials, read once for the rail and the overview: owned and granted (the
 * catalog's metadata only, never values) and the one state both show (`presentCredentialsSecretsState`).
 */
export function useCredentialsSecrets(): Readonly<{
  entries: readonly SavedSecretCatalogEntryV1[];
  state: CredentialsSecretsState;
  errorCause: import('@/sync/domains/scope/scopedSnapshotFacts').ScopedSnapshotError | null;
  retry: () => void;
}> {
  const catalog = useSavedSecretCatalog({ includeMaterial: false });
  const entries = catalog.entries;
  const state = presentCredentialsSecretsState({ status: catalog.status, stale: catalog.stale, entryCount: entries.length });
  const reload = catalog.reload;
  const retry = React.useCallback(() => { void reload().catch(() => undefined); }, [reload]);
  return { entries, state, retry, errorCause: catalog.errorCause };
}

/**
 * Credentials' Secrets section (lab `cr` crHome A): owned and granted Saved Secrets that aren't tied to one
 * service, as rows like the page's others (key · name · type · who can use it), each opening the secret
 * beside the rail. Loading, a failed read and none say so in place, in step with the rail.
 */
export const CredentialsSecretsGroup = React.memo(function CredentialsSecretsGroup(props: Readonly<{
  onOpen: (href: string) => void;
}>) {
  const { theme } = useUnistyles();
  const { entries, state, retry, errorCause } = useCredentialsSecrets();
  return (
    <ItemGroup
      testID="credentials-secrets"
      surface="none"
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
        // A line in this bare section stands on the rows' edge by itself (`BareSectionLineEdge`); no row inset around it.
        <SurfaceStateCard
          testID="credentials-secrets:pending"
          kind={state === 'failed' ? 'warning' : 'loading'}
          size="line"
          title={state === 'failed' ? resolveActionExecutionErrorMessage(errorCause, t('secretsSettings.staleTitle'), { safeToRetry: true }) : t('common.loading')}
          action={state === 'failed' ? { label: t('common.retry'), onPress: retry } : undefined}
        />
      ) : state === 'empty' ? (
        <EmptyState
          testID="credentials-secrets:empty"
          layout="line"
          title={t('secretsSettings.emptyTitle')}
          subtitle={t('secretsSettings.emptyDescription')}
        />
      ) : entries.map((entry) => (
        <Item
          key={entry.ref}
          testID={`credentials-secret:${entry.ref}`}
          title={entry.name ?? t('secrets.catalog.unavailableName')}
          subtitle={savedSecretEntryKindLabel(entry) ?? undefined}
          icon={<Icon name="key" size={18} color={theme.colors.text.secondary} />}
          detail={entry.relationship === 'recipient' ? sharedSecretProvenanceSegments(entry).join(' · ') : savedSecretAudienceSummary(entry)}
          onPress={() => props.onOpen(buildCredentialsSecretRoute({ ref: entry.ref }))}
        />
      ))}
    </ItemGroup>
  );
});
