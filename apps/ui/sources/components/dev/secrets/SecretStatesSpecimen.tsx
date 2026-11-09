import * as React from 'react';
import type { SavedSecretCatalogEntryV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';

import { SecretRequirementModal } from '@/components/secrets/requirements';
import {
  SecretsSettingsPage,
  type SecretsSettingsPageProps,
} from '@/components/settings/secrets/SecretsSettingsPage';
import { Modal } from '@/modal';

/**
 * Dev-only specimen of two states a QA Account cannot reach on its own, drawn by the real owners over fixtures
 * (nothing is read from or written to the Account). `?frame=rows`: a shared secret in each trouble status, which
 * needs another person's share and withdrawal. `?frame=requirement`: a profile's required secret, which only a
 * legacy or imported profile declares. Never linked from product surfaces.
 */
const noop = () => {};
const accepted = async () => true;

function sharedEntry(
  id: string,
  name: string,
  materialStatus: SavedSecretCatalogEntryV1['materialStatus'],
  relationship: SavedSecretCatalogEntryV1['relationship'],
): SavedSecretCatalogEntryV1 {
  return {
    ref: `happier:shared-secret:v1:${id}`,
    source: 'shared_resource',
    relationship,
    name,
    kind: 'token',
    encryptionMode: 'e2ee',
    owner: null,
    accessSources: [],
    audience: { accounts: [], teams: [], groups: [] },
    ownerAccountId: 'specimen-owner',
    revision: 2,
    materialStatus,
    capabilities: {
      use: materialStatus === 'ready',
      rename: false,
      rotate: false,
      manageAccess: false,
      delete: true,
    },
  } as unknown as SavedSecretCatalogEntryV1;
}

const ENTRIES: readonly SavedSecretCatalogEntryV1[] = [
  sharedEntry('deploy', 'Deploy key', 'ready', 'owner'),
  sharedEntry('staging', 'Staging database', 'access_removed', 'owner'),
  sharedEntry('stripe', 'Stripe live key', 'update_required', 'recipient'),
  sharedEntry('sentry', 'Sentry DSN', 'temporarily_unavailable', 'recipient'),
  sharedEntry(
    'linear',
    'Linear token',
    'preparing_encrypted_access',
    'recipient',
  ),
  sharedEntry(
    'analytics',
    'Analytics token',
    'recipient_mode_unsupported',
    'recipient',
  ),
  sharedEntry('signing', 'Release signing', 'deleted', 'recipient'),
];

const resolveSharedReference: SecretsSettingsPageProps['resolveSharedReference'] =
  (ref) =>
    ({
      ref,
      kind: 'shared_resource',
      status:
        ENTRIES.find((entry) => entry.ref === ref)?.materialStatus ?? 'ready',
    }) as ReturnType<SecretsSettingsPageProps['resolveSharedReference']>;

function TroubledRows() {
  return (
    <SecretsSettingsPage
      personalSecrets={[]}
      sharedEntries={ENTRIES}
      corruptEntries={[]}
      resolveSharedReference={resolveSharedReference}
      sharedCatalogStale={false}
      sharedCatalogStatus="ready"
      onRenamePersonal={accepted}
      onRotatePersonal={accepted}
      onDeletePersonal={accepted}
      sharedMutationsDisabled={false}
      approvalId={null}
      onAdd={noop}
      onCancelAdd={noop}
      createEditor={null}
      accessEditor={null}
    />
  );
}

/** Opened the way the profile list opens it (`useProfilesCollection#openSecretModal`). */
function RequiredSecret() {
  React.useEffect(() => {
    const id = Modal.show({
      component: SecretRequirementModal,
      props: {
        profile: { id: 'specimen-profile', name: 'Research notes' },
        secretEnvVarName: 'ANTHROPIC_API_KEY',
        secretEnvVarNames: ['ANTHROPIC_API_KEY', 'SENTRY_AUTH_TOKEN'],
        machineId: null,
        defaultSecretId: null,
        defaultSecretIdByEnvVarName: null,
        allowManage: true,
        allowSessionOnly: false,
        onResolve: noop,
      },
      onRequestClose: noop,
      closeOnBackdrop: true,
    });
    return () => Modal.hide(id);
  }, []);
  return null;
}

export function SecretStatesSpecimen(props: Readonly<{ frame?: string }>) {
  return props.frame === 'requirement' ? <RequiredSecret /> : <TroubledRows />;
}
