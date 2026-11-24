import * as React from 'react';
import { type Href } from 'expo-router';
import { useLocalSearchParams, Stack } from '@/components/appShell/workspace/destinationRoute';

import { ApprovalDetailScreen } from '@/components/approvals/ApprovalDetailScreen';
import { NavigationBackChromeProvider, useNavigationBackControl } from '@/components/ui/layout/NavigationBackChrome';
import { usePhoneDestinationBack } from '@/components/ui/layout/usePageBackControl';
import { t } from '@/text';
import { normalizeInternalReturnPath } from '@/utils/path/routeUtils';

const single = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;

export function ApprovalDetailPage() {
  const inheritedBack = useNavigationBackControl();
  // A phone opened straight on an approval (a link, a notification) goes back to the Inbox that lists it.
  const phoneBack = usePhoneDestinationBack('approvals:back', '/inbox');
  const { id, serverId, completionHref, completionFocusFrom, completionFocusTo } = useLocalSearchParams<{
    id: string;
    serverId?: string;
    completionHref?: string;
    completionFocusFrom?: string;
    completionFocusTo?: string;
  }>();
  if (!id) return null;
  const normalizedCompletionHref = (normalizeInternalReturnPath(single(completionHref)) ?? undefined) as Href | undefined;

  const headerTitle = t('approvals.title');
  const screenOptions = React.useMemo(() => {
    return { title: headerTitle } as const;
  }, [headerTitle]);
  const detailProps: React.ComponentProps<typeof ApprovalDetailScreen> = {
    artifactId: id,
    serverId: single(serverId),
    completionHref: normalizedCompletionHref,
    completionFocusFrom: single(completionFocusFrom),
    completionFocusTo: single(completionFocusTo),
  };

  return (
    <>
      <Stack.Screen options={screenOptions} />
      <NavigationBackChromeProvider control={phoneBack ?? inheritedBack}>
        {React.createElement(ApprovalDetailScreen, detailProps)}
      </NavigationBackChromeProvider>
    </>
  );
}
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export { ApprovalDetailPage as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={ApprovalDetailPage} />; }
