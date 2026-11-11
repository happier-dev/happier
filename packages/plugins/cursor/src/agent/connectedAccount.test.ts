import { describe, expect, it } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';

import { CURSOR_PLUGIN } from '../manifest.js';

describe('Cursor selected native account', () => {
  it('declares one host-owned key delivery and retains same-home native resume', async () => {
    const kit = await createPluginTestkit({ manifest: CURSOR_PLUGIN.manifest, module: CURSOR_PLUGIN });
    try {
      const launch = kit.registration('agents', 'cursor')?.connectedAccountLaunch;
      expect(launch?.environmentUses).toEqual(['CURSOR_API_KEY', 'CURSOR_AUTH_TOKEN', 'AGENT_CLI_CREDENTIAL_STORE'].map(environmentKey => ({ purpose: 'cursor-native', environmentKey })));
      expect(launch?.switchContinuity).toMatchObject({ continuityMode: 'restart_same_home', supportedTransitions: expect.arrayContaining(['connected_to_native', 'connected_to_connected']) });
      const verify = launch?.continuity?.verifyResumeReachable;
      if (!verify) throw new Error('Cursor native resume callback is not registered');
      const sessionFiles = {
        async verifyDeclaredPaths() { throw new Error('An environment-only selection must not relocate native state'); },
        async findDeclaredCandidate() { throw new Error('Native session/load owns session existence'); },
      };
      expect(await verify({ vendorResumeId: 'cursor-native-session-A', sessionFiles })).toEqual({ ok: true });
      expect(await verify({ vendorResumeId: null, sessionFiles })).toMatchObject({ ok: false, reason: 'vendor_resume_id_missing' });
    } finally { await kit.dispose(); }
  });
});
