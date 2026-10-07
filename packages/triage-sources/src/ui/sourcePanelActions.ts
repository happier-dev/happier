import * as React from 'react';
import { useTabPanelActivity } from '@happier-dev/plugin-ui';
import { useTriageEvidenceDisclosure, type TriageSourcePanelCommandV1, type TriageSourcePanelHandlerV1 } from './evidenceDisclosure.js';
import type { TriageSourcePanelOperationV1, TriageSourcePanelResultV1 } from './sourcePanelProtocol.js';

/** Registers the incumbent panel owner, only during its real active interval. */
export function useTriageSourcePanelIntentV1(
  kind: TriageSourcePanelOperationV1['kind'],
  invoke: TriageSourcePanelHandlerV1,
  commands: readonly TriageSourcePanelCommandV1[],
) {
  const { panelActions } = useTriageEvidenceDisclosure();
  const { active, activeSignal } = useTabPanelActivity();
  const latest = React.useRef(invoke);
  React.useLayoutEffect(() => { latest.current = invoke; }, [invoke]);
  React.useLayoutEffect(() => !active ? undefined : panelActions?.bind(kind,
    (operation, signal) => latest.current(operation, signal), commands), [active, commands, kind, panelActions]);
  return React.useCallback(async (operation: TriageSourcePanelOperationV1): Promise<TriageSourcePanelResultV1> => {
    if (!active || activeSignal.aborted || panelActions === undefined) return { status: 'unavailable' };
    return await panelActions.execute(operation, activeSignal);
  }, [active, activeSignal, panelActions]);
}
