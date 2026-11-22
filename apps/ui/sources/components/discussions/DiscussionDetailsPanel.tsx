import * as React from 'react';

import { usePaneHeaderSlotContent, type PaneHeaderSlotContent } from '@/components/appShell/panes/paneHeaderSlot';
import { useRouter, type Href } from '@/components/appShell/workspace/destinationRoute';
import { buildDiscussionStorageRouteHref } from '@/components/discussions/discussionRoutes';
import {
  DiscussionStoragePane,
  DiscussionStorageRow,
  useDiscussionStorageRead,
  type DiscussionStorageSource,
} from '@/components/storage/discussion/DiscussionStorage';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import type { PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { useSurfaceStateSize } from '@/components/ui/surfaces/surfaceStateSize';
import { t } from '@/text';

const NO_HEADER: PaneHeaderSlotContent = {};

/**
 * The Discussion page's Details tab: the same operations the header's ⋯ menu lists on a phone, as rows.
 * A toggled policy (the check-in) is a switch saying what applies now; the rest are operations, in the
 * menu's own order, so one owner decides what a Discussion offers. Between them, Storage says what the
 * Discussion's files hold (storage-view lab scene 5 A): in the pane it opens the scoped Storage view in place,
 * under a band that leads back to Details; on a phone it pushes that view's page.
 */
export function DiscussionDetailsPanel(
  props: Readonly<{ actions: readonly PageHeaderMenuAction[]; storage: DiscussionStorageSource }>,
): React.ReactElement {
  const phone = useSurfaceStateSize() === 'phone';
  const router = useRouter();
  const { scope, discussionId } = props.storage;
  // One scoped read for the row's total and the view it opens.
  const read = useDiscussionStorageRead(scope, discussionId);
  const [storageOpen, setStorageOpen] = React.useState(false);
  const closeStorage = React.useCallback(() => setStorageOpen(false), []);
  const inPane = storageOpen && !phone;
  const header = React.useMemo<PaneHeaderSlotContent>(() => inPane
    ? { subpage: { title: t('artifacts.browser.storageView.title'), onBack: closeStorage } } : NO_HEADER, [closeStorage, inPane]);
  usePaneHeaderSlotContent(header);
  const openStorage = React.useCallback(() => {
    if (phone) router.push(buildDiscussionStorageRouteHref({ serverId: scope.serverId, discussionId }) as Href);
    else setStorageOpen(true);
  }, [discussionId, phone, router, scope.serverId]);
  if (inPane) return <DiscussionStoragePane source={props.storage} read={read} />;
  const settings = props.actions.filter(
    (action) => action.checked !== undefined || action.category !== undefined,
  );
  const operations = props.actions.filter(
    (action) => action.checked === undefined && action.category === undefined,
  );
  return (
    <ItemList testID="discussion-details-tab">
      {settings.length > 0 ? (
        <ItemGroup>
          {settings.map((action) => (
            <Item
              key={action.id}
              testID={action.testID ? `${action.testID}-row` : undefined}
              title={action.title}
              subtitle={action.subtitle}
              disabled={action.disabled}
              loading={action.loading}
              rightElement={
                action.checked === undefined ? undefined : (
                  <Switch
                    testID={action.testID}
                    value={action.checked}
                    disabled={action.disabled}
                    accessibilityLabel={action.title}
                    onValueChange={() => void action.onSelect()}
                  />
                )
              }
              onPress={
                action.checked === undefined
                  ? () => void action.onSelect()
                  : undefined
              }
              showChevron={false}
            />
          ))}
        </ItemGroup>
      ) : null}
      <DiscussionStorageRow read={read} onPress={openStorage} />
      {operations.length > 0 ? (
        <ItemGroup>
          {operations.map((action) => (
            <Item
              key={action.id}
              testID={action.testID}
              title={action.title}
              subtitle={action.subtitle}
              disabled={action.disabled}
              loading={action.loading}
              destructive={action.destructive}
              onPress={() => void action.onSelect()}
              showChevron={false}
            />
          ))}
        </ItemGroup>
      ) : null}
    </ItemList>
  );
}
