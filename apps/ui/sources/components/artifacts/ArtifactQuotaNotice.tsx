import * as React from 'react';
import { formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation';

import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { t } from '@/text';

import type { ArtifactQuota } from './artifactActionsClient';

/** The existing budget explanation, shared by Artifact notices and owner-only Session Delete failures. */
export function describeArtifactQuota(
  quota: ArtifactQuota,
  options?: Readonly<{ editsPreserved?: boolean }>,
): Readonly<{ title: string; description: string }> {
  const used = formatHappierDataBytes(quota.usedBytes, { kind: 'storage' });
  const limit = formatHappierDataBytes(quota.limitBytes, { kind: 'storage' });
  return quota.budget === 'document'
    ? { title: t('artifacts.browser.quota.documentTitle'),
      description: t('artifacts.browser.quota.documentBody', { size: used, limit,
        ...(options?.editsPreserved === undefined ? {} : { editsPreserved: options.editsPreserved }) }) }
    : { title: t('artifacts.browser.quota.accountTitle'),
      description: t('artifacts.browser.quota.accountBody', { used, limit }) };
}


/**
 * `quota_exceeded`, said once above the content it blocks (lab A8 / A8p): which budget, the size and
 * the cap, and how to recover. The browser shows the full Account budget; the editor shows the refusal.
 * It is the app's one tinted notice (`AttentionBanner`), not an Artifacts-local callout.
 */
export function ArtifactQuotaNotice(
  props: Readonly<{
    quota: ArtifactQuota;
    testID: string;
    placement?: 'page-section' | 'inline';
  }>,
): React.ReactElement {
  const description = describeArtifactQuota(props.quota);
  return (
    <AttentionBanner
      testID={props.testID}
      tone="warning"
      placement={props.placement}
      announce="alert"
      {...description}
    />
  );
}
