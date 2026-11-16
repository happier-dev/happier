import { expect, it, vi } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { ConnectedAccountAuthenticationContext, ConnectedAccountReadContext, ConnectedAccountCredentialStore } from '@happier-dev/plugin-sdk/connected-accounts';
import * as entry from './index.js';

it.each(['http', 'ambiguous403', 'ambiguous403health', 'transport', 'codeless', 'credentials'] as const)('retains supabase %s failure facts without credential echoes', async boundary => {
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry });
  try {
    const runtime = kit.registration('connectedAccountDescriptors', 'supabase');
    if (!runtime || !runtime.status) throw new Error('Missing account runtime');
    const mode = runtime.authentication.modes.token;
    if (mode?.kind !== 'manual') throw new Error('Missing manual mode');
    const httpStatus = boundary === 'ambiguous403' || boundary === 'ambiguous403health' ? 403 : 429;
    const request = vi.fn(async () => ({ status: httpStatus, headers: {}, body: new TextEncoder().encode('private-echo') }));
    if (boundary === 'transport') request.mockRejectedValueOnce(Object.assign(new Error('private-echo'), { code: 'ENOTFOUND' }));
    if (boundary === 'codeless') request.mockRejectedValueOnce(new Error('private-echo'));
    const set = vi.fn(async () => {});
    const credentials: ConnectedAccountCredentialStore = {
      async get() { if (boundary === 'credentials') throw new PluginError({ code: 'credential_unavailable', message: 'private-echo' }); return 'private-echo'; },
      set, async delete() {},
    };
    // Only host transport and credential persistence are supplied at their real boundaries.
    const http = createPluginHttpFixture({ request });
    const services = new Proxy({} as ConnectedAccountReadContext['services'], {
      get(_target, key) { if (key === 'http') return http; throw new Error('Unexpected host service'); },
    });
    const service = { pluginId: entry.manifest.id, localId: 'supabase' };
    const context: ConnectedAccountAuthenticationContext = {
      plugin: { id: entry.manifest.id, version: entry.manifest.version },
      contribution: { id: 'supabase', qualifiedId: `${entry.manifest.id}/supabase` },
      surface: 'ui', invokedAtMs: 1, service, attempt: { kind: 'connect', attemptId: 'attempt' },
      configuration: { target: { kind: 'attempt', attemptId: 'attempt', service, modeId: 'token' }, revision: '1',
        values: { organizationSlug: 'org-example' }, async getSecret() { return null; } },
      services, signal: new AbortController().signal, attemptCredentials: credentials,
    };
    const result = boundary === 'credentials' || boundary === 'ambiguous403health'
      ? await runtime.status({ ...context, account: { service, accountId: 'connected' }, credentials })
      : await mode.complete({ fields: { token: 'private-echo' } }, context);
    const isHttpFailure = boundary === 'http' || boundary === 'ambiguous403' || boundary === 'ambiguous403health';
    const code = isHttpFailure ? 'supabase_unavailable' : boundary === 'transport' ? 'ENOTFOUND'
      : boundary === 'credentials' ? 'credential_unavailable' : 'action_failed';
    expect(result).toMatchObject({ status: 'unavailable', diagnostic: { code,
      details: { failureCause: isHttpFailure ? { httpStatus } : { errorCode: boundary === 'codeless' ? null : code } } } });
    if (boundary === 'http') expect(result).toMatchObject({ diagnostic: { details: { failureClass: 'rateLimit' } } });
    expect(set).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('private-echo');
  } finally { await kit.dispose(); }
});
