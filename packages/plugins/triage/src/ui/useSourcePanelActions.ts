import * as React from 'react';
import type { PluginEphemeralSharedScope } from '@happier-dev/plugin-sdk';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import { triageSourcePanelActionIdV1, type TriageSourcePanelActionsV1, type TriageSourcePanelCommandV1 } from '@happier-dev/triage-sources/ui';
import { bindTriageMountedSourcePanelAction } from './mountedActions.js';
import { TriageMountedUiResultV1Schema } from '../actions/mountedUiProtocol.js';
import { isHostCancellation } from '../hostCancellation.js';

const NO_COMMANDS: readonly TriageSourcePanelCommandV1[] = Object.freeze([]);

/** The mounted dispatcher retains callbacks/commands only; source controllers retain all selection. */
export function useTriageSourcePanelActionsV1(scope: PluginEphemeralSharedScope | null,
  mountId: string, identity: string | null, active: boolean, hostApi: PluginUiHostApi) {
  const [published, setPublished] = React.useState<Readonly<{
    owner: TriageSourcePanelActionsV1; commands: readonly TriageSourcePanelCommandV1[];
  }> | null>(null);
  const current = React.useRef<TriageSourcePanelActionsV1 | null>(null);
  const actions = React.useMemo<TriageSourcePanelActionsV1>(() => {
    const bindings = new Map<string, readonly TriageSourcePanelCommandV1[]>();
    const owner: TriageSourcePanelActionsV1 = {
      bind(kind, invoke, commands) {
        if (scope === null || !active || identity === null) return () => {};
        const guarded = async (...args: Parameters<typeof invoke>) => current.current === owner
          && !args[1].aborted ? await invoke(...args) : { status: 'unavailable' as const };
        const release = bindTriageMountedSourcePanelAction(scope, mountId, kind, guarded);
        bindings.set(kind, commands);
        setPublished({ owner, commands: [...bindings.values()].flat() });
        return () => {
          release();
          if (bindings.get(kind) === commands) bindings.delete(kind);
          if (current.current === owner) setPublished({ owner, commands: [...bindings.values()].flat() });
        };
      },
      async execute(operation, signal) {
        if (current.current !== owner || !active || identity === null || signal?.aborted) return { status: 'unavailable' };
        try {
          const result = await hostApi.executeAction(triageSourcePanelActionIdV1(operation), { mountId, operation }, { signal });
          const parsed = TriageMountedUiResultV1Schema.safeParse(result);
          return parsed.success ? parsed.data : { status: 'rejected' };
        } catch (error) {
          return { status: isHostCancellation(error, signal) ? 'unavailable' : 'rejected' };
        }
      },
    };
    return owner;
  }, [active, hostApi, identity, mountId, scope]);
  React.useLayoutEffect(() => {
    current.current = actions;
    return () => { if (current.current === actions) current.current = null; };
  }, [actions]);
  return { actions, commands: published?.owner === actions ? published.commands : NO_COMMANDS };
}
