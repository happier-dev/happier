import * as React from 'react';
import { View } from 'react-native';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { retryableLazy } from '@/components/ui/performance/retryableLazy';
import { Modal } from '@/modal';
import type { CustomModalInjectedProps } from '@/modal/types';
import { t } from '@/text';
import type { QualifiedMachineV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import type { DeploySuggestionCatalogV1, DeploySuggestionRecommendationV1 } from '@happier-dev/protocol/deployments/suggestions/deploySuggestionsV1';

const LazyNewAppScreen = retryableLazy(async () => {
  const module = await import('./NewAppScreen');
  return { default: module.NewAppScreen };
});

/** What the entrance already knows: a Project's Deploy an app opens with that Project's code chosen as Your code. */
export type NewAppSuggestionContext = Readonly<{
  description: string;
  recommendation: DeploySuggestionRecommendationV1;
  catalog: DeploySuggestionCatalogV1;
}>;
export type NewAppContext = Readonly<{ projectSourceId?: string | null; previewEnvironmentId?: string | null; startOn?: 'describe' | null; suggestion?: NewAppSuggestionContext | null }>;

function NewAppDialog(props: CustomModalInjectedProps & Readonly<{ onClone?: (() => void) | null; starterId?: string | null; machine?: QualifiedMachineV1 | null; projectSourceId?: string | null; previewEnvironmentId?: string | null; startOn?: 'describe' | null; suggestion?: NewAppSuggestionContext | null }>) {
  return (
    <React.Suspense fallback={<View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><ActivitySpinner /></View>}>
      <LazyNewAppScreen onClose={props.onClose} setChrome={props.setChrome} onClone={props.onClone} starterId={props.starterId} machine={props.machine}
        projectSourceId={props.projectSourceId} previewEnvironmentId={props.previewEnvironmentId} startOn={props.startOn} suggestion={props.suggestion} />
    </React.Suspense>
  );
}

/**
 * Every Deploy an app (New app) entrance goes through here (Plan 60 §5.1): a dialog over the current page on a
 * computer and a sheet over it on a phone (lab f1src / f1srcp), as tall as its step. `machine` is a "Deploy an app
 * here" door's Machine, kept chosen through the flow. `/projects/new-app` stays the same flow as a page for links.
 */
export function useOpenNewApp(onClone?: (() => void) | null): (starterId?: string | null, machine?: QualifiedMachineV1 | null, context?: NewAppContext) => void {
  return React.useCallback((starterId?: string | null, machine?: QualifiedMachineV1 | null, context?: NewAppContext) => {
    Modal.show({
      component: NewAppDialog,
      props: { onClone: onClone ?? null, starterId: starterId ?? null, machine: machine ?? null, projectSourceId: context?.projectSourceId ?? null, previewEnvironmentId: context?.previewEnvironmentId ?? null, startOn: context?.startOn ?? null, suggestion: context?.suggestion ?? null },
      ...newAppDialogPresentation(!context?.suggestion && context?.startOn !== 'describe'),
    });
  }, [onClone]);
}

/**
 * The New app dialog's presentation, shared with the dev specimen that opens the same dialog over fixtures.
 * `sourceStep`: the dialog opens on the source step, which fills the card's bound once its sections settle, so the card
 * takes that height from its first frame (while the screen's code loads too) instead of growing as they arrive
 * (PAGE-ACCEPT-176 R3-D3). The screen keeps the same choice per step through its own chrome.
 */
export function newAppDialogPresentation(sourceStep = true) {
  return {
    // The draft is the person's writing: a stray click outside never throws it away.
    closeOnBackdrop: false,
    chrome: {
      kind: 'card' as const,
      title: t('newApp.title'),
      testID: 'newApp.dialog',
      scrollHost: sourceStep ? 'body' as const : 'bounded' as const,
      phonePresentation: 'sheet' as const,
      dimensions: { width: 640, maxHeightRatio: 0.88, size: 'lg' as const },
    },
  };
}
