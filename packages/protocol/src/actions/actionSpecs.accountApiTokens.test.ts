import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1,
  ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1,
  ACCOUNT_API_TOKENS_REVOKE_ALL_HTTP_PATH_V1,
  ACCOUNT_API_TOKENS_REVOKE_HTTP_PATH_V1,
} from '../auth/accountApiTokens.js';
import type { ActionId } from './actionIds.js';
import { getActionSpec, PublicActionIdSchema, SignedRootActionIdSchema } from './actionSpecs.js';
import { describeApprovalActionFields } from './actionApprovalPresentation.js';
import { API_TOKEN_FULL_GRANT_V1 } from '../auth/apiTokenGrant.js';
import { resolveActionSurfaceAvailability } from './actionSurfaceAvailability.js';

const operations = [
  ['account.apiTokens.create', 'present_user', ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1],
  ['account.apiTokens.list', 'account_automation', ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1],
  ['account.apiTokens.update', 'present_user', '/v1/auth/api-tokens/update'],
  ['account.apiTokens.revoke', 'present_user', ACCOUNT_API_TOKENS_REVOKE_HTTP_PATH_V1],
  ['account.apiTokens.revokeAll', 'present_user', ACCOUNT_API_TOKENS_REVOKE_ALL_HTTP_PATH_V1],
] as const;

describe('Account API-token Action admission', () => {
  it('admits signed token lifecycle requests while retaining token API exclusion', () => {
    for (const [id] of operations) {
      expect(SignedRootActionIdSchema.safeParse(id).success, id).toBe(true);
      expect(getActionSpec(id).surfaces.api).toBe(false);
      expect(PublicActionIdSchema.safeParse(id).success, id).toBe(false);
    }
    for (const id of ['account.password.enroll', 'account.password.change', 'account.password.remove',
      'account.email.change.request']) {
      expect(SignedRootActionIdSchema.safeParse(id).success, id).toBe(false);
    }
  });

  it('discloses the exact grant, expiry, encryption and unattended access in the creation review', () => {
    const actionArgs = getActionSpec('account.apiTokens.create').inputSchema.parse({
      tokenId: 'dd03e74b-4aae-4a0a-81ee-1c23ddc4525d', label: { content: { t: 'plain', v: 'Wilson trigger' }, recipients: [] },
      expiresAt: '2026-11-20T12:00:00.000Z', authorizeUnattendedTeamAccess: false,
      grant: { ...API_TOKEN_FULL_GRANT_V1, actions: { ids: ['workflow.trigger.run_now'], families: [] },
        automationIds: ['16cce218-b735-46cd-a68a-303c84743527'] },
    });
    const presentation = describeApprovalActionFields({ actionId: 'account.apiTokens.create', actionArgs });
    expect(presentation.unrepresentable).toBeNull();
    expect(presentation.rows).toContainEqual(expect.objectContaining({ path: 'grant', value: JSON.stringify(actionArgs.grant) }));
    expect(presentation.rows).toContainEqual(expect.objectContaining({ path: 'expiresAt', value: actionArgs.expiresAt }));
    expect(presentation.rows).toContainEqual(expect.objectContaining({ path: 'authorizeUnattendedTeamAccess' }));
  });
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
        // The owner excludes creation from Agent/MCP: its new bearer stays in
        // the human UI. Other requests retain ordinary approval admission.
        expect(resolveActionSurfaceAvailability({ actionId: id, surface }).available, `${id} on ${surface}`)
          .toBe(surface === 'plugin' || id !== 'account.apiTokens.create' && (surface === 'agent' || surface === 'mcp'));
      }
    }
  });
});
