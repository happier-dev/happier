import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';
import { formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { accountStorageViewRoute } from '@/components/storage/account/storageViewRoute';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { AttentionBanner, type AttentionBannerAction } from '@/components/ui/lists/AttentionBanner';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
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
 * It is the app's one tinted notice (`AttentionBanner`), not an Artifacts-local callout. The Account budget's notice
 * carries its way forward (storage-view lab scene 4): "See what's using space" opens the Storage view filtered to
 * Artifacts, largest first; the Storage view itself passes its in-place action. One Artifact's own size limit
 * ("Too large to save") keeps no link.
 *
 * `standing="near"` is the Account budget from the storage quota owner's near share (`resolveStorageQuotaState`):
 * nothing is refused yet, so it is one quiet line beside the meter, "Nearly full · See what's using space", not the
 * tinted banner.
 */
export function ArtifactQuotaNotice(
  props: Readonly<{
    quota: ArtifactQuota;
    testID: string;
    placement?: 'page-section' | 'inline';
    /** The Account budget is near its limit but nothing is refused: the quiet line, not the banner. */
    standing?: 'near';
    /** The Account budget's action in place of opening Storage (the Storage view lists its biggest Artifacts). */
    usageAction?: AttentionBannerAction;
    onOpenUsage?: () => void;
  }>,
): React.ReactElement {
  const router = useRouter();
  const description = describeArtifactQuota(props.quota);
  const document = props.quota.budget === 'document';
  const action: AttentionBannerAction | undefined = document ? undefined : props.usageAction ?? {
    label: t('artifacts.browser.storageView.seeUsage'),
    onPress: () => {
      props.onOpenUsage?.();
      router.push(accountStorageViewRoute('artifacts') as never);
    },
  };
  if (props.standing === 'near' && action) {
    return (
      <Text testID={props.testID} style={styles.nearLine}>
        <Text style={styles.nearLead}>{t('artifacts.browser.storage.nearlyFull')}</Text>
        {' · '}
        <TextLinkButton tone="quiet" size="meta" label={action.label} onPress={action.onPress} />
      </Text>
    );
  }
  return (
    <AttentionBanner
      testID={props.testID}
      tone="warning"
      placement={props.placement}
      announce="alert"
      action={action}
      {...description}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  nearLine: {
    ...Typography.variant('meta'),
    color: theme.colors.text.tertiary,
  },
  nearLead: {
    color: theme.colors.state.warning.textForeground,
  },
}));
