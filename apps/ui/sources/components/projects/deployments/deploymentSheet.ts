import type * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';

import { Modal } from '@/modal';
import type {
  CustomModalCallerProps,
  CustomModalComponentType,
} from '@/modal/types';

/**
 * The one card sheet the Environment's dialogs open in (Link a machine, Add platform target, Delete/Unlink,
 * Restore): a wide card on desktop, a sheet on a phone, its footer from `ModalCardFooterActions`.
 */
export function showDeploymentSheet<C extends CustomModalComponentType<any>>(
  input: Readonly<{
    component: C;
    props: CustomModalCallerProps<React.ComponentProps<C>>;
    title: string;
    testID: string;
    /** A sheet whose step has an effect in flight (Restore) keeps the backdrop from closing it. */
    closeOnBackdrop?: boolean;
    /** A virtualized body owns its scroll viewport. */
    bodyScroll?: 'none' | 'auto';
    scrollHost?: 'bounded' | 'body';
  }>,
): void {
  Modal.show({
    component: input.component,
    props: input.props,
    chrome: {
      kind: 'card',
      title: input.title,
      testID: input.testID,
      phonePresentation: 'sheet',
      scrollHost: input.scrollHost ?? 'bounded',
      bodyScroll: input.bodyScroll ?? 'auto',
      dimensions: {
        width: HAPPIER_PAGE_METRICS.dialogWidthPx.wide,
        maxHeightRatio: 0.9,
        size: 'md',
      },
    },
    closeOnBackdrop: input.closeOnBackdrop ?? true,
  });
}

/** The sheet body: card chrome pads only its header and footer, so the body aligns with the title's edge. */
export const deploymentSheetStyles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.space.s16,
    paddingHorizontal: theme.space.s16,
    paddingBottom: theme.space.s16,
  },
  lead: {
    color: theme.colors.text.secondary,
  },
}));
