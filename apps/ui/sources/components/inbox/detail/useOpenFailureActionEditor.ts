import * as React from 'react';
import { usePluginSurfaceDestinationNavigationBinding } from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import { useOptionalAccountNoticeInvestigation } from '@/hooks/inbox/AccountNoticeInvestigationProvider';
import type { HealthNoticeInvestigationOutcome } from './healthNoticeInvestigation';

export type FailureActionEditorRefusal = Extract<HealthNoticeInvestigationOutcome, { kind: 'unavailable' }>;

/** The contributing Action opens its editor through the existing destination navigation. */
export function useOpenFailureActionEditor(
  onRefusal?: (outcome: FailureActionEditorRefusal) => void,
): ((actionId?: string) => void) | null {
  const navigation = usePluginSurfaceDestinationNavigationBinding();
  const owner = useOptionalAccountNoticeInvestigation();
  return React.useMemo(() => navigation === null || owner === null ? null
    : (actionId?: string) => {
      void owner.openEditor(actionId).then(outcome => {
        if (outcome) onRefusal?.(outcome);
      });
    }, [navigation, owner, onRefusal]);
}
