import * as React from 'react';
import { View } from 'react-native';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { retryableLazy } from '@/components/ui/performance/retryableLazy';
import { Modal } from '@/modal';
import type { CustomModalInjectedProps } from '@/modal/types';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';
import type { QualifiedMachineV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';

const LazyNewAppScreen = retryableLazy(async () => {
  const module = await import('./NewAppScreen');
  return { default: module.NewAppScreen };
});

function NewAppDialog(props: CustomModalInjectedProps & Readonly<{ onClone?: (() => void) | null; starterId?: string | null; machine?: QualifiedMachineV1 | null }>) {
  return (
    <React.Suspense fallback={<View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><ActivitySpinner /></View>}>
      <LazyNewAppScreen onClose={props.onClose} setChrome={props.setChrome} onClone={props.onClone} starterId={props.starterId} machine={props.machine} />
    </React.Suspense>
  );
}

/**
 * Every Deploy an app (New app) entrance goes through here (Plan 60 §5.1): a dialog over the current page on a
 * computer (lab s1 panel), the pushed `/projects/new-app` page on a phone. `machine` is a "Deploy an app here" door's
 * Machine, kept chosen through the flow.
 */
export function useOpenNewApp(onClone?: (() => void) | null): (starterId?: string | null, machine?: QualifiedMachineV1 | null) => void {
  const router = useRouter();
  const phone = useDeviceType() === 'phone';
  return React.useCallback((starterId?: string | null, machine?: QualifiedMachineV1 | null) => {
    if (phone) {
      router.push({ pathname: '/projects/new-app', params: {
        ...(starterId ? { starterId } : {}),
        ...(machine ? { serverId: machine.serverId, machineId: machine.machineId } : {}),
      } } as never);
      return;
    }
    Modal.show({
      component: NewAppDialog,
      props: { onClone: onClone ?? null, starterId: starterId ?? null, machine: machine ?? null },
      // The draft is the person's writing: a stray click outside never throws it away.
      closeOnBackdrop: false,
      chrome: {
        kind: 'card',
        title: t('newApp.title'),
        testID: 'newApp.dialog',
        scrollHost: 'body',
        bodyScroll: 'none',
        dimensions: { width: 640, maxHeightRatio: 0.88, size: 'lg' },
      },
    });
  }, [onClone, phone, router]);
}
