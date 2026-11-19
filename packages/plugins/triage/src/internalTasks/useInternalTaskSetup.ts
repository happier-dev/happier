import { useCallback, useState } from 'react';
import { usePluginHostApi } from '@happier-dev/plugin-ui';
import { TriageSourceAdministrationActionResultV1Schema } from '@happier-dev/triage-protocol/v1';

import { useTriageConfiguredSources } from '../ui/configuration/useTriageConfiguredSources.js';
import { INTERNAL_TASK_CONFIGURE_ACTION_ID_V1 } from './identity.js';
import { isInternalTaskConfiguredInstanceV1 } from './source.js';

type SetupWriteState = 'pending' | 'ready' | 'failed';
export type InternalTaskSetupStateV1 = 'loading' | 'unavailable' | 'idle' | SetupWriteState;

/** Setup reads the same active configured rows as source administration; it never scans tasks. */
export function useInternalTaskSetup() {
  const host = usePluginHostApi();
  const configured = useTriageConfiguredSources();
  const [setup, setSetup] = useState<Readonly<{ host: typeof host; state: SetupWriteState }> | null>(null);
  const writeState = setup?.host === host ? setup.state : 'idle';
  const enabled = configured.loaded && configured.sources.some(source => isInternalTaskConfiguredInstanceV1(source.configured));
  const state: InternalTaskSetupStateV1 = enabled ? 'ready'
    : writeState !== 'idle' ? writeState
    : configured.unavailableReason !== null ? 'unavailable'
    : configured.loaded ? 'idle' : 'loading';

  const configure = useCallback(async () => {
    if (state !== 'idle' && state !== 'failed') return;
    setSetup({ host, state: 'pending' });
    const settle = (state: SetupWriteState) => setSetup(current => current?.host === host ? { host, state } : current);
    try {
      const result = TriageSourceAdministrationActionResultV1Schema.parse(await host.executeAction(INTERNAL_TASK_CONFIGURE_ACTION_ID_V1, { v: 1 }));
      settle(result.kind === 'active' || result.kind === 'reused' || result.kind === 'reactivated' ? 'ready' : 'failed');
    } catch { settle('failed'); }
  }, [host, state]);

  return { state, configure, unavailableReason: configured.unavailableReason } as const;
}
