import { describe, expect, it } from 'vitest';
import type { SavedSecretExternalSourceV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';

import { t } from '@/text';

import { savedSecretShareDisclosureMessage } from './savedSecretShareDisclosure';

const source = {
  kind: 'external',
  contribution: { pluginId: 'onepassword', contributionId: 'onepassword' },
  account: 'acme.1password.com',
  reference: 'op://Dev/Mapbox/token',
  metadata: {
    vault: { id: 'v1', name: 'Dev' },
    item: { id: 'i1', title: 'Mapbox' },
    field: { id: 'f1', title: 'token' },
  },
} as unknown as SavedSecretExternalSourceV1;

describe('savedSecretShareDisclosureMessage', () => {
  it('keeps the value disclosure for a typed value', () => {
    expect(savedSecretShareDisclosureMessage()).toBe(
      t('secretsSettings.sharingDescription'),
    );
  });

  it('discloses a vault reference as a reference, naming where it lives and the reference itself', () => {
    const message = savedSecretShareDisclosureMessage(source, '1Password');
    expect(message).not.toContain(t('secretsSettings.sharingDescription'));
    expect(message).toContain(
      t('secretsSettings.sharingReferenceDescription', {
        provider: '1Password',
      }),
    );
    for (const detail of [
      'acme.1password.com',
      'Dev',
      'Mapbox',
      'token',
      'op://Dev/Mapbox/token',
    ]) {
      expect(message).toContain(detail);
    }
  });
});
