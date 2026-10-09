import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { SessionModelSelectionV1Schema } from '@happier-dev/protocol/providers/model-selection';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { configuration } from '@/configuration';
import { createCliProviderActionExecuteV1 } from './createCliProviderActionDeps';

describe('Provider default preference Action at its Account Settings boundary', () => {
  const originalRequirement = configuration.clientEncryptionRequirement;
  afterEach(() => { vi.restoreAllMocks(); Object.assign(configuration, { clientEncryptionRequirement: originalRequirement }); });

  it('preserves a dispatched one-shot preference write with unknown outcome, without resubmitting it', async () => {
    const serverUrl = 'https://provider-default.test';
    Object.assign(configuration, { clientEncryptionRequirement: 'follow_account' });
    // Only HTTP is replaced. The Provider setter, pure preference transform,
    // Account opener, one-shot CAS and Action execution all remain real.
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      expect(new URL(String(input)).origin).toBe(serverUrl);
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: { untouched: true } }, version: 7 } };
      if (path === PROFILE_TRANSFER_ROUTE_V1) return { status: 200, data: { status: 'absent' } };
      throw new Error(`Unexpected preference read: ${path}`);
    });
    const submitted: unknown[] = [];
    vi.spyOn(axios, 'post').mockImplementation(async (input, body) => {
      expect(new URL(String(input)).origin).toBe(serverUrl);
      expect(new URL(String(input)).pathname).toBe('/v2/account/settings');
      const request = AccountSettingsV2UpdateRequestSchema.parse(body);
      submitted.push(request);
      throw Object.assign(new Error('Dispatched request lost its acknowledgement'), { code: 'ECONNRESET' });
    });
    const executor = createActionExecutor({
      providerActionExecute: createCliProviderActionExecuteV1({ credentials: { token: 'provider-default-token', encryption: null },
        serverId: 'provider-home', serverHttpBaseUrl: serverUrl,
        callMachineAction: async () => { throw new Error('Default preference must not consult a daemon'); },
      }),
    });
    const selection = SessionModelSelectionV1Schema.parse({ v: 1,
      ref: { agentTargetKey: 'agent:codex', providerConnectionId: 'unavailable', modelId: 'model' }, updatedAt: 1 });
    const result = await executor.execute('providers.defaults.set', { agentTargetKey: 'agent:codex', selection },
      { surface: 'cli', authority: 'present_user', serverId: 'provider-home', actionCaller: { kind: 'host' } });
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({ expectedVersion: 7,
      content: { t: 'plain', v: { untouched: true, providerDefaultModelSelectionsByAgentTargetKeyV1: { 'agent:codex': selection } } } });
    expect(result).toMatchObject({ ok: false, errorCode: 'account_settings_mutation_outcome_unknown',
      details: { status: 'outcomeUnknown', lastKnownVersion: 7 } });
  });
});
