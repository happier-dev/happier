import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1,
  ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1,
  ACCOUNT_API_TOKENS_REVOKE_ALL_HTTP_PATH_V1,
  ACCOUNT_API_TOKENS_REVOKE_HTTP_PATH_V1,
} from '../auth/accountApiTokens.js';
import type { ActionId } from './actionIds.js';
import { getActionSpec } from './actionSpecs.js';
import { resolveActionSurfaceAvailability } from './actionSurfaceAvailability.js';

const operations = [
  ['account.apiTokens.create', 'present_user', ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1],
  ['account.apiTokens.list', 'account_automation', ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1],
  ['account.apiTokens.update', 'present_user', '/v1/auth/api-tokens/update'],
  ['account.apiTokens.revoke', 'present_user', ACCOUNT_API_TOKENS_REVOKE_HTTP_PATH_V1],
  ['account.apiTokens.revokeAll', 'present_user', ACCOUNT_API_TOKENS_REVOKE_ALL_HTTP_PATH_V1],
] as const;

describe('Account API-token Action admission', () => {
  it('keeps lifecycle operations on the Account transport with automation request surfaces and no public API', () => {
    for (const [id, authority, path] of operations) {
      const spec = getActionSpec(id as ActionId);
      expect(spec.requiredAuthority).toBe(authority);
      expect(spec.executionPlacement).toBe('account');
      expect(spec.serverTransport).toEqual({ method: 'POST', path });

      for (const surface of ['ui', 'cli'] as const) {
        expect(resolveActionSurfaceAvailability({ actionId: id, surface }).available).toBe(true);
      }
      for (const surface of ['agent', 'mcp', 'voice', 'rpc', 'api', 'plugin'] as const) {
        expect(resolveActionSurfaceAvailability({ actionId: id, surface }).available)
          .toBe(surface === 'agent' || surface === 'mcp' || surface === 'plugin');
      }
    }
  });
});
