import * as React from 'react';
import { View } from 'react-native';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Modal } from '@/modal';
import type { CustomModalInjectedProps } from '@/modal/types';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';

/** An Open address: a retained draft (`draftId`, `serverId`) or a nonexecuting seed. */
export type ProjectOpenRoute = Readonly<{
  pathname: '/projects/open';
  params: Readonly<Record<string, string>>;
}>;

/**
 * The dialog's frame (lab `p-open` OPEN): wide enough for the source list beside the choices, and a
 * fixed height so narrowing the list never resizes it. The card owner clamps both to the window.
 */
const PROJECT_OPEN_DIALOG_DIMENSIONS = Object.freeze({
  width: 820,
  maxHeightRatio: 0.88,
  size: 'lg' as const,
});

const LazyProjectOpenScreen = React.lazy(async () => {
  const module = await import('./ProjectOpenScreen');
  return { default: module.ProjectOpenScreen };
});

function ProjectOpenDialog(
  props: CustomModalInjectedProps &
    Readonly<{ routeParams: Readonly<Record<string, string>> }>,
) {
  return (
    <React.Suspense
      fallback={
        <View
          style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}
        >
          <ActivitySpinner />
        </View>
      }
    >
      <LazyProjectOpenScreen
        routeParams={props.routeParams}
        onClose={props.onClose}
        setChrome={props.setChrome}
      />
    </React.Suspense>
  );
}

/**
 * Open as a dialog over the current page (plan 11 §2 "Desktop Projects + → … → Open dialog"), on the
 * one card-modal owner. The draft lives in the draft repository under its id, so closing the dialog
 * keeps every choice for the next Open of the same draft.
 */
export function showProjectOpenDialog(route: ProjectOpenRoute): void {
  Modal.show({
    component: ProjectOpenDialog,
    props: { routeParams: route.params },
    closeOnBackdrop: true,
    chrome: {
      kind: 'card',
      title: t('projects.open.title'),
      subtitle: t('projects.open.purpose'),
      testID: 'projects.open.dialog',
      // The two panes own their scrolling; the card keeps its height.
      scrollHost: 'body',
      bodyScroll: 'none',
      dimensions: PROJECT_OPEN_DIALOG_DIMENSIONS,
    },
  });
}

/**
 * Every Open entrance goes through here: a dialog over the current page on a computer, the pushed
 * `/projects/open` page on a phone, where choices push sheets and Back is the cancel.
 */
export function useNavigateToProjectOpen(): (route: ProjectOpenRoute) => void {
  const router = useRouter();
  const phone = useDeviceType() === 'phone';
  return React.useCallback(
    (route: ProjectOpenRoute) => {
      if (phone) {
        router.push(route as never);
        return;
      }
      showProjectOpenDialog(route);
    },
    [phone, router],
  );
}
