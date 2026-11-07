import * as React from 'react';
import { useTabPanelActivity } from '@happier-dev/plugin-ui';
import { useTriageEvidenceDisclosure, type TriageSourcePanelCommandV1, type TriageSourcePanelHandlerV1 } from './evidenceDisclosure.js';
import { triageSourcePanelIntentKeyV1, type TriageSourcePanelIntentV1, type TriageSourcePanelOperationV1, type TriageSourcePanelResultV1 } from './sourcePanelProtocol.js';

/** Registers the incumbent panel owner, only during its real active interval. */
export function useTriageSourcePanelIntentV1(
  intent: TriageSourcePanelIntentV1,
  invoke: TriageSourcePanelHandlerV1,
  commands: readonly TriageSourcePanelCommandV1[],
) {
  const { panelActions } = useTriageEvidenceDisclosure();
  const { active, activeSignal } = useTabPanelActivity();
  const key = triageSourcePanelIntentKeyV1(intent);
  const latest = React.useRef(invoke);
  React.useLayoutEffect(() => { latest.current = invoke; }, [invoke]);
  React.useLayoutEffect(() => !active ? undefined : panelActions?.bind(key,
    (operation, signal) => latest.current(operation, signal), commands), [active, commands, key, panelActions]);
  return React.useCallback(async (operation: TriageSourcePanelOperationV1): Promise<TriageSourcePanelResultV1> => {
    if (!active || activeSignal.aborted || panelActions === undefined) return { status: 'unavailable' };
    return await panelActions.execute(operation, activeSignal);
  }, [active, activeSignal, panelActions]);
}
