import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import {
  WidgetFrame,
  type WidgetFrameStyle,
} from '@/components/widgets/frame/WidgetFrame';
import { useSessionProjectScmSummarySnapshot } from '@/sync/store/hooks';
import { t } from '@/text';
import { openExternalUrl } from '@/utils/url/openExternalUrl';
import { useOpenResource } from '@/utils/url/openResource';

import { resolveLinksSectionRow } from './glanceModels';

const NO_REMOTES: readonly never[] = Object.freeze([]);

/**
 * The Links section (lab crows B): the repository's page, read from the remote git reports for the
 * Session's working copy (`origin` first), and the open pull request the working snapshot carries, opened
 * through the same resource owner as the Git pane. A Session with neither has no Links section.
 */
export function LinksGlance(
  props: Readonly<{
    sessionId: string;
    serverId: string | null;
    frameStyle: WidgetFrameStyle;
    presentation?: 'frame' | 'body';
    menu?: React.ReactNode;
    measurementOnly: boolean;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const snapshot = useSessionProjectScmSummarySnapshot(
    props.sessionId,
    props.serverId,
  );
  const remotes = snapshot?.repo.isRepo
    ? (snapshot.repo.remotes ?? NO_REMOTES)
    : NO_REMOTES;
  const repository = React.useMemo(
    () => resolveLinksSectionRow(remotes),
    [remotes],
  );
  const pullRequest = snapshot?.repo.isRepo
    ? (snapshot.pullRequestStatus?.openPullRequest ?? null)
    : null;
  const { openResource } = useOpenResource({
    sessionId: props.sessionId,
    ...(props.serverId ? { serverId: props.serverId } : {}),
  });
  if (!repository && !pullRequest) return null;
  const externalMark = (
    <Icon
      name="arrow-square-out"
      size={ICON_SIZE.xs}
      color={theme.colors.text.tertiary}
    />
  );
  return (
    <WidgetFrame
      testID={props.testID}
      presentation={props.presentation}
      frameStyle={props.frameStyle}
      placement="companion"
      mark="link"
      title={t('sessionCompanion.sections.links')}
      menu={props.menu}
      body={{
        kind: 'content',
        children: (
          <>
            {repository ? (
              <Item
                testID={`${props.testID}.repository`}
                density="compact"
                accessibilityRole="link"
                icon={
                  <Icon
                    name="git-branch"
                    size={ICON_SIZE.sm}
                    color={theme.colors.text.secondary}
                  />
                }
                title={repository.path}
                rightElement={externalMark}
                {...(props.measurementOnly
                  ? { mode: 'info' as const }
                  : {
                      onPress: () => {
                        void openExternalUrl(repository.url);
                      },
                    })}
              />
            ) : null}
            {pullRequest ? (
              <Item
                testID={`${props.testID}.pullRequest`}
                density="compact"
                accessibilityRole="link"
                icon={
                  <Icon
                    name="git-pull-request"
                    size={ICON_SIZE.sm}
                    color={theme.colors.text.secondary}
                  />
                }
                title={t('sessionCompanion.sections.pullRequest')}
                {...(typeof pullRequest.number === 'number'
                  ? {
                      titleMeta: t('sessionCompanion.sections.pullRequestOpen', {
                        number: pullRequest.number,
                      }),
                    }
                  : {})}
                rightElement={externalMark}
                {...(props.measurementOnly
                  ? { mode: 'info' as const }
                  : {
                      onPress: () => {
                        void openResource({
                          kind: 'pullRequest',
                          url: pullRequest.url,
                        });
                      },
                    })}
              />
            ) : null}
          </>
        ),
      }}
    />
  );
}
