import { describe, expect, it } from 'vitest';
import type { HostRuntimeControlServiceV1 } from '@happier-dev/agents';

import {
  listCodexRuntimeSkills,
  listCodexRuntimeVendorPlugins,
} from './catalog.js';

function createRuntimeControl(error: Error): HostRuntimeControlServiceV1 {
  return {
    context: { agentId: 'codex' },
    appServer: {
      checkAvailable: async () => ({ ok: true, value: true }),
      request: async () => {
        throw error;
      },
    },
    session: {
      checkConnectedServiceAuthTransportInvalidation: async () => ({ ok: true, value: true }),
      invalidateConnectedServiceAuthTransports: async () => ({ ok: true, value: true }),
    },
    connectedServices: {
      refreshRuntimeAuth: async () => ({ ok: false, code: 'connected_service_refresh_unavailable', error: 'connected_service_refresh_unavailable' }),
    },
    reachability: {
      verifyMaterializedState: async () => ({ ok: false, code: 'resume_reachability_unavailable', error: 'resume_reachability_unavailable' }),
    },
  };
}

describe('Codex app-server runtime catalog control', () => {
  it('does not surface raw runtime-control errors in unsupported catalog diagnostics', async () => {
    const error = new Error('/Users/leeroy/.codex/auth.json contains sk-secret-token');
    const runtimeControl = createRuntimeControl(error);

    const vendorPlugins = await listCodexRuntimeVendorPlugins({
      runtimeControl,
      params: { cwd: '/repo' },
    });
    const skills = await listCodexRuntimeSkills({
      runtimeControl,
      params: { cwd: '/repo' },
    });

    expect(vendorPlugins).toEqual({
      unsupported: true,
      vendorPlugins: [],
      diagnostic: 'codex_app_server_catalog_control_unavailable',
    });
    expect(skills).toEqual({
      unsupported: true,
      skills: [],
      diagnostic: 'codex_app_server_catalog_control_unavailable',
    });
    expect(JSON.stringify({ vendorPlugins, skills })).not.toContain('/Users/leeroy');
    expect(JSON.stringify({ vendorPlugins, skills })).not.toContain('sk-secret-token');
  });
});
