import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { CopyIconButton } from '@/components/ui/copy/CopyIconButton';
import { requestOpenExternalUrl } from '@/utils/url/requestOpenExternalUrl';
import { isTextSharingAvailable, shareTextSafe } from '@/utils/ui/shareText';
import { t } from '@/text';
import { useDeploymentChangePress } from './deploymentActionOutcome';

type ChangePress = ReturnType<typeof useDeploymentChangePress>;
/** A Domain that needs a look offers its own recovery here; the change owner settles it and refreshes the page. */
export type DeploymentLiveAddressCheck = Readonly<{
  run: Parameters<ChangePress['press']>[0];
  review: Parameters<typeof useDeploymentChangePress>[0];
  onSettled: () => void;
}>;

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
      /** Check again, first, when the address's Domain needs a look. */
      checkAgain?: DeploymentLiveAddressCheck | null;
    }>,
  ) {
    const { url } = props;
    return (
      <View style={styles.actions}>
        {props.checkAgain ? <CheckAgain check={props.checkAgain} testID={`${props.testIDPrefix}.checkAgain`} /> : null}
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

function CheckAgain(props: Readonly<{ check: DeploymentLiveAddressCheck; testID: string }>) {
  const { running, press } = useDeploymentChangePress(props.check.review, props.check.onSettled);
  return <RoundButton testID={props.testID} size="small" display="secondary" loading={running} disabled={running}
    title={t('projects.deployments.domainCheckAgain')} onPress={() => { void press(props.check.run); }} />;
}

const styles = StyleSheet.create((theme) => ({
  actions: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
}));
