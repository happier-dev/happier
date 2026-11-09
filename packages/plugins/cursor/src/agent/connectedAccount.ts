import type { AgentConnectedAccountLaunchContributionV1 } from '@happier-dev/plugin-sdk/agents/runtime';

import { CURSOR_API_KEY_ENV } from './auth/status.js';
import { resolveCursorResumeAction } from './resume/session.js';

export const CURSOR_NATIVE_PURPOSE_ID = 'cursor-native';

/** The host materializes the selected key once; both ACP opens retain that environment. */
export const CURSOR_CONNECTED_ACCOUNT_LAUNCH = {
  environmentUses: [{ purpose: CURSOR_NATIVE_PURPOSE_ID, environmentKey: CURSOR_API_KEY_ENV }],
  switchContinuity: {
    continuityMode: 'restart_same_home',
    supportedTransitions: ['native_to_connected', 'connected_to_native', 'connected_to_connected', 'same_connected_group'],
  },
  continuity: {
    generationApplicationScope: 'per_session_runtime',
    async verifyResumeReachable({ vendorResumeId }) {
      // Key selection never relocates native state. Cursor's existing session/load
      // remains the existence authority, as in the native-default resume path.
      return resolveCursorResumeAction({ cursorSessionId: vendorResumeId }).action === 'load'
        ? { ok: true }
        : { ok: false, reason: 'vendor_resume_id_missing' };
    },
  },
} satisfies AgentConnectedAccountLaunchContributionV1;
