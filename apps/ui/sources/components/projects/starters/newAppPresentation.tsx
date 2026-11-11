import * as React from 'react';
import { View } from 'react-native';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { retryableLazy } from '@/components/ui/performance/retryableLazy';
import { Modal } from '@/modal';
import type { CustomModalInjectedProps } from '@/modal/types';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';

const LazyNewAppScreen = retryableLazy(async () => {
  const module = await import('./NewAppScreen');
  return { default: module.NewAppScreen };
});

function NewAppDialog(props: CustomModalInjectedProps & Readonly<{ onClone?: (() => void) | null; starterId?: string | null }>) {
  return (
    <React.Suspense fallback={<View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><ActivitySpinner /></View>}>
      <LazyNewAppScreen onClose={props.onClose} setChrome={props.setChrome} onClone={props.onClone} starterId={props.starterId} />
    </React.Suspense>
  );
}

/**
 * Every New app entrance goes through here (Plan 60 §5.1): a dialog over the current page on a
 * computer (lab s1 panel), the pushed `/projects/new-app` page on a phone.
 */
export function useOpenNewApp(onClone?: (() => void) | null): (starterId?: string | null) => void {
  const router = useRouter();
  const phone = useDeviceType() === 'phone';
  return React.useCallback(() => {
    if (phone) {
      router.push({ pathname: '/projects/new-app', params: starterId ? { starterId } : {} } as never);
      return;
    }
    Modal.show({
      component: NewAppDialog,
      props: { onClone: onClone ?? null, starterId: starterId ?? null },
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
