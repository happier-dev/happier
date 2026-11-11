import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from '../actionExecutor.js';
import { ApprovalRequestV2Schema, type ApprovalRequest } from '../../approvals/approvalRequestV1.js';
import { NO_TEAM_CAPABILITIES_V1 } from '../../teams/capabilities.js';
import { TeamSummaryV1Schema } from '../../teams/projections.js';

const input = { v: 1, teamId: 'team-product', accountId: 'account-grace', role: 'member',
  historyAccess: 'from_membership' } as const;
const team = TeamSummaryV1Schema.parse({ id: input.teamId, name: 'Product Team', description: null, logo: null,
  archivedAt: null, recovery: null, viewerRole: 'admin', capabilities: NO_TEAM_CAPABILITIES_V1,
  counts: null, admission: { historyChoice: { admin: 'choice', member: 'choice', guest: 'hidden' } },
  policy: { v: 1, sessionCreationPolicy: 'private_default', externalSharingPolicy: 'allowed',
    defaultSessionHistoryAccess: 'from_membership', admissionMode: 'invite_only', authenticationPolicy: null } });

describe('Team member approval identity', () => {
  it.each(['matched', 'different-account', 'unavailable', 'transport-failed'] as const)(
    'captures only the named operands returned by the exact Team-scoped reader: %s', async scenario => {
      const stored: ApprovalRequest[] = [];
      const reads: Array<{ actionId: string; input: unknown; serverId: string | undefined }> = [];
      // Only the Home transport and approval persistence boundaries are replaced.
      const deps = {
        homeDomainAction: async request => {
          reads.push({ actionId: request.actionId, input: request.input, serverId: request.context.serverId });
          if (request.actionId === 'teams.get') {
            if (scenario === 'transport-failed') throw new Error('home-unavailable');
            return team;
          }
          if (request.actionId === 'home.accounts.search') return scenario === 'unavailable'
            ? { ok: false, errorCode: 'home_governance_forbidden', error: 'home_governance_forbidden' }
            : { accounts: [{ accountId: scenario === 'matched' ? input.accountId : 'another-account',
              profile: { name: 'Grace', firstName: null, lastName: null, username: null, avatarUrl: null }, eligible: true }] };
          throw new Error(`unexpected_effect:${request.actionId}`);
        },
        approvalsCreate: async ({ request }) => {
          stored.push(ApprovalRequestV2Schema.parse(request));
          return { artifactId: 'member-approval' };
        },
      } satisfies Pick<ActionExecutorDeps, 'homeDomainAction' | 'approvalsCreate'>;
      const result = await createActionExecutor(deps).execute('teams.members.add', input, {
        surface: 'mcp', authority: 'account_automation', actionCaller: { kind: 'host' },
        serverId: 'exact-home', runtimeAccountId: 'manager', actionRequestId: 'add-grace',
      });
      expect(result).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
      expect(stored).toHaveLength(1);
      expect(stored[0]?.actionArgs).toEqual(input);
      if (scenario === 'matched') {
        expect(stored[0]?.summary).toContain('Grace');
        expect(stored[0]?.summary).toContain('Product Team');
      } else {
        expect(stored[0]?.summary).not.toContain('Grace');
      }
      // One exact Team read and one exact Account picker read, with no mutation before consent.
      expect(reads).toEqual([
        { actionId: 'teams.get', input: { teamId: input.teamId }, serverId: 'exact-home' },
        { actionId: 'home.accounts.search', input: { query: input.accountId,
          scope: { kind: 'team', teamId: input.teamId } }, serverId: 'exact-home' },
      ]);
    });
});
