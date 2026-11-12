import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { DeploymentReceiptFactsV1 } from '@happier-dev/deployments';
import { readDeploymentDomainServingUrlV1 } from '@happier-dev/protocol/deployments/deploymentDomainContentV1';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { CopyIconButton } from '@/components/ui/copy/CopyIconButton';
import { requestOpenExternalUrl } from '@/utils/url/requestOpenExternalUrl';
import { isTextSharingAvailable, shareTextSafe } from '@/utils/ui/shareText';
import { t } from '@/text';

type DomainRow = Readonly<{
  domain: Readonly<{ targetLinkId?: string | null; state: string }>;
  content: Parameters<typeof readDeploymentDomainServingUrlV1>[0] &
    Readonly<{ target: Readonly<{ service?: string | null }> }>;
}>;

type LiveReceipt = Readonly<{
  deployment: Readonly<{ targetLinkId: string }>;
  content: Readonly<{
    sourceIntent?: Readonly<{
      kind: string;
      primaryService?: string;
      compose?: Readonly<{ primaryService?: string }>;
    }>;
  }>;
  facts: Pick<DeploymentReceiptFactsV1, 'urls'>;
}>;

/**
 * The address a serving receipt is live at: a platform's observed URL, else the current Domain that routes its
 * primary service on its own runtime link. The receipt page and the Environment page read it here, once.
 */
export function resolveDeploymentLiveUrl(
  receipt: LiveReceipt,
  domains: readonly DomainRow[],
): string | null {
  const observed = receipt.facts.urls?.[0];
  if (observed) return observed;
  const intent = receipt.content.sourceIntent;
  const primaryService =
    intent?.kind === 'repository'
      ? intent.compose?.primaryService
      : intent?.primaryService;
  if (!primaryService) return null;
  const domain = domains.find(
    (item) =>
      item.domain.targetLinkId === receipt.deployment.targetLinkId &&
      (item.domain.state === 'active' || item.domain.state === 'warning') &&
      item.content.target.service === primaryService,
  );
  return domain ? readDeploymentDomainServingUrlV1(domain.content) : null;
}

/** The address as people say it: no scheme, no trailing slash. */
export function formatDeploymentLiveAddress(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/** Copy, Share where the platform has it, and Open: the live address's own actions. */
export const DeploymentLiveAddressActions = React.memo(
  function DeploymentLiveAddressActions(
    props: Readonly<{
      url: string;
      serverId: string;
      accountId: string;
      testIDPrefix: string;
      /** Open is the view's one primary when nothing else leads; otherwise it steps back beside it. */
      openEmphasis: 'primary' | 'secondary';
    }>,
  ) {
    const { url } = props;
    return (
      <View style={styles.actions}>
        <CopyIconButton text={url} testID={`${props.testIDPrefix}.copy`} />
        {isTextSharingAvailable() ? (
          <RoundButton
            testID={`${props.testIDPrefix}.share`}
            size="small"
            display="secondary"
            title={t('common.share')}
            onPress={() => {
              void shareTextSafe(url);
            }}
          />
        ) : null}
        <RoundButton
          testID={`${props.testIDPrefix}.open`}
          size="small"
          {...(props.openEmphasis === 'secondary'
            ? { display: 'secondary' as const }
            : {})}
          title={t('common.open')}
          onPress={() => {
            void requestOpenExternalUrl(url, {
              serverId: props.serverId,
              expectedAccountId: props.accountId,
            });
          }}
        />
      </View>
    );
  },
);

const styles = StyleSheet.create((theme) => ({
  actions: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
}));
