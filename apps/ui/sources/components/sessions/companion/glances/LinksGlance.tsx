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

import { resolveLinksSectionRow } from './glanceModels';

const NO_REMOTES: readonly never[] = Object.freeze([]);

/**
 * The Links section (lab crows B): the repository's page, read from the remote git reports for the
 * Session's working copy (`origin` first). A Session whose remote has no browsable page, or that is not
 * a repository, has no Links section. The pull request row waits for an owner the app can read
 * (`Triage`'s session binding is plugin-owned), so it is not drawn.
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
  if (!repository) return null;
  const url = repository.url;
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
            rightElement={
              <Icon
                name="arrow-square-out"
                size={ICON_SIZE.xs}
                color={theme.colors.text.tertiary}
              />
            }
            {...(props.measurementOnly
              ? { mode: 'info' as const }
              : {
                  onPress: () => {
                    void openExternalUrl(url);
                  },
                })}
          />
        ),
      }}
    />
  );
}
