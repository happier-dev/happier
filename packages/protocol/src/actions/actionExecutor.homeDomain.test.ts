import { describe, expect, it, vi } from 'vitest';

import { ApprovalRequestV2Schema, type ApprovalRequest } from '../approvals/approvalRequestV1.js';
import { decideApprovalRequestTransition, settleApprovalRequestActionArgs } from '../approvals/approvalRequestTransition.js';
import type { HomeAccountRowV1 } from '../home/governance/accounts.js';
import { buildApprovalPreviewSummary, createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { getActionSpec } from './actionSpecs.js';
import { resolveApprovalRequestApproveAdmission } from './actionApprovalPresentation.js';
import { ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES } from '../crypto/encryptedDataKeyEnvelopeFormatV1.js';
import { API_TOKEN_FULL_GRANT_V1 } from '../auth/apiTokenGrant.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { NO_TEAM_CAPABILITIES_V1 } from '../teams/capabilities.js';
import { TeamSummaryV1Schema } from '../teams/projections.js';
import type { ActionId } from './actionIds.js';
import { createBlockingApprovalCoordinator } from './blockingApprovalCoordinator.js';

const roleSetInput = { accountId: 'account-2', homeRole: 'admin' } as const;

it('requires the ordinary person confirmation before claiming Personal Home ownership', async () => {
  let effects = 0;
  const executor = createActionExecutor({ homeRuntimeActionExecute: async () => {
    effects++;
    return { ok: true, result: { status: 'task_started', taskId: 'claim-owner' } };
  } });
  const input = getActionSpec('relay.runtime.personal_home.claim').inputSchema.parse({
    purpose: { kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:43123' },
    personalHomeOperation: { accountId: 'owner' } });
  const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
  expect(await executor.execute('relay.runtime.personal_home.claim', input, context))
    .toMatchObject({ ok: false, errorCode: 'action_interactive_review_required' });
  expect(effects).toBe(0);
  expect(await executor.execute('relay.runtime.personal_home.claim', input, {
    ...context, presentUserConfirmation: { actionId: 'relay.runtime.personal_home.claim' },
  })).toMatchObject({ ok: true, result: { status: 'task_started', taskId: 'claim-owner' } });
  expect(effects).toBe(1);
});

/**
 * The in-memory approval Artifacts below stand in for the persistence boundary
 * only: every write still goes through the real Protocol subject/transition
 * owner both Artifact adapters consume, so a settlement the real stores would
 * refuse cannot pass here.
 */
function transitionStoredApproval(stored: ApprovalRequest | null | undefined, request: ApprovalRequest) {
  if (!stored) return { ok: false as const, errorCode: 'not_found', error: 'artifact_not_found' };
  return decideApprovalRequestTransition(stored, request);
}

function homeAccountRow(): HomeAccountRowV1 {
  return {
    accountId: 'account-2',
    homeRole: 'admin' as const,
    status: 'active' as const,
    profile: { name: 'Ada', firstName: 'Ada', lastName: null, username: null, avatarUrl: null },
    createdAt: 1,
    authentication: { signInEmail: null, usableMethodIds: ['key_challenge'] },
    mutationCapabilities: {
      setRole: {
        member: { status: 'available' },
        admin: { status: 'unavailable', reason: 'unchanged' },
        owner: { status: 'available' },
      },
      disable: { status: 'available' },
      reenable: { status: 'unavailable', reason: 'target_not_suspended' },
      delete: { status: 'available' },
      signOutEverywhere: { status: 'available' },
    },
  };
}

describe('createActionExecutor (Home governance and Teams)', () => {
  it('reveals for the person in the app; an Agent/MCP request asks first and only the person\'s Allow displays it once, value-free', async () => {
    const displays: Array<Readonly<{ input: unknown; surface: unknown; authority: unknown }>> = [];
    let portResult: unknown = { status: 'displayed', historyEntryId: 'history-1' };
    const approvals = new Map<string, ApprovalRequest>();
    let settings = ActionsSettingsV1Schema.parse({ v: 1 });
    const executor = createActionExecutor({
      // The app's Saved Secret display and the approval Artifact store are the
      // boundaries; admission, policy, routing, transitions and replay stay real.
      savedSecretRevealAction: async ({ input, context }) => {
        displays.push({ input, surface: context.surface, authority: context.authority });
        return portResult;
      },
      isActionApprovalRequired: (id, context, admittedInput) =>
        isApprovalRequiredByActionsSettings(id, settings, context, undefined, undefined, admittedInput),
      approvalsCreate: async ({ request }) => {
        const artifactId = `reveal-approval-${approvals.size + 1}`;
        approvals.set(artifactId, ApprovalRequestV2Schema.parse(request));
        return { artifactId };
      },
      approvalsGet: async ({ artifactId }) => approvals.get(artifactId) ?? null,
      approvalsUpdate: async ({ artifactId, request }) => {
        const transition = transitionStoredApproval(approvals.get(artifactId), request);
        if (!transition.ok) return transition;
        approvals.set(artifactId, ApprovalRequestV2Schema.parse(request));
        return { ok: true as const };
      },
      isApprovalExecutionOriginCurrent: async () => true,
    } as Partial<ActionExecutorDeps> as ActionExecutorDeps);
    const input = { ref: 'happier:shared-secret:v1:resource', expectedRevision: 3 };
    const reveal = (context: Parameters<typeof executor.execute>[2]) => executor.execute('secrets.shared.reveal' as ActionId, input, context);
    const person = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
      serverId: 'home-1', runtimeAccountId: 'account-1' } as const;

    // Owner-positive: the person's own in-app Reveal stays direct, one display.
    expect(await reveal(person)).toEqual({ ok: true, result: { status: 'displayed', historyEntryId: 'history-1' } });
    expect(displays).toEqual([{ input, surface: 'ui', authority: 'present_user' }]);

    // Agent and MCP requests (host or real Session caller) default to Ask:
    // one value-free Artifact each, nothing displayed, nothing returned.
    const automation = (surface: 'agent' | 'mcp', session: boolean) => ({ surface, authority: 'account_automation' as const,
      serverId: 'home-1', runtimeAccountId: 'account-1', actionRequestId: `request-${surface}-${session}`,
      ...(session ? { defaultSessionId: 'agent-session',
        actionCaller: { kind: 'session' as const, sessionId: 'agent-session', starterDepth: 0, turnDepth: 0 } }
        : { actionCaller: { kind: 'host' as const } }) });
    const requested = [];
    for (const [surface, session] of [['agent', false], ['agent', true], ['mcp', false]] as const) {
      const result = await reveal(automation(surface, session));
      expect(result).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
      requested.push((result as { result: { artifactId: string } }).result.artifactId);
    }
    expect(displays).toHaveLength(1);
    expect(approvals.size).toBe(3);
    for (const artifactId of requested) {
      expect(approvals.get(artifactId)).toMatchObject({ actionId: 'secrets.shared.reveal', actionArgs: input, status: 'open',
        approval: { flow: 'deferred' }, executionOriginV1: { authority: 'account_automation', accountId: 'account-1' } });
    }

    // Agents never answer their own request; nothing is displayed.
    const [agentRequest, sessionRequest, mcpRequest] = requested as [string, string, string];
    expect(await executor.execute('approval.request.decide', { artifactId: agentRequest, decision: 'approve' },
      automation('agent', false))).toMatchObject({ ok: false });
    expect(displays).toHaveLength(1);
    expect(approvals.get(agentRequest)?.status).toBe('open');

    // The person's Allow replays once in their own app as their own display; the
    // requester and the Artifact receive only the value-free outcome.
    expect(await executor.execute('approval.request.decide', { artifactId: mcpRequest, decision: 'approve' }, person))
      .toMatchObject({ ok: true });
    expect(displays).toHaveLength(2);
    expect(displays[1]).toEqual({ input, surface: 'ui', authority: 'present_user' });
    expect(approvals.get(mcpRequest)).toMatchObject({ status: 'executed',
      execution: { result: { status: 'displayed', historyEntryId: 'history-1' } } });
    // A settled Allow runs once; a repeated decision reads the receipt.
    await executor.execute('approval.request.decide', { artifactId: mcpRequest, decision: 'approve' }, person);
    expect(displays).toHaveLength(2);
    expect(approvals.get(mcpRequest)?.status).toBe('executed');

    // A display port that tried to hand the value back cannot cross the result boundary.
    portResult = { status: 'displayed', historyEntryId: 'history-2', value: 'secret-sentinel' };
    const leaked = await executor.execute('approval.request.decide', { artifactId: sessionRequest, decision: 'approve' }, person);
    expect(JSON.stringify(leaked)).not.toContain('secret-sentinel');
    expect(JSON.stringify(approvals.get(sessionRequest))).not.toContain('secret-sentinel');

    // A deliberate Allow preference for the surface skips the Ask (user-changeable default).
    portResult = { status: 'displayed', historyEntryId: 'history-3' };
    settings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'secrets.shared.reveal': ['agent'] } });
    expect(await reveal(automation('agent', true))).toEqual({ ok: true, result: { status: 'displayed', historyEntryId: 'history-3' } });
    expect(approvals.size).toBe(3);

    // An API token never reveals, even with that preference and a full grant: no Artifact, no display.
    const before = displays.length;
    expect(await reveal({ surface: 'api', authority: 'account_automation', actionCaller: { kind: 'host' },
      externalActionCredential: { accountId: 'account-1', principalId: 'token', credentialId: 'token', grant: API_TOKEN_FULL_GRANT_V1 } }))
      .toMatchObject({ ok: false });
    expect(displays).toHaveLength(before);
    expect(approvals.size).toBe(3);
  });
  it.each([
    ['teams.archive', { v: 1, teamId: 'team-1' }, null],
    ['teams.restore', { v: 1, teamId: 'team-1' }, null],
    ['teams.credentials.delete', { resourceId: 'resource-1', expectedRevision: 7 },
      { resourceId: 'resource-1', revision: 8 }],
    ['teams.credentials.limits.delete', { resourceId: 'resource-2', expectedRevision: 11, limitId: 'limit-1' },
      { resourceId: 'resource-2', revision: 12 }],
    ['teams.credentials.externalKeys.revoke',
      { resourceId: 'resource-3', keyId: '123e4567-e89b-42d3-a456-426614174000' },
      { keyId: '123e4567-e89b-42d3-a456-426614174000', revoked: true }],
    ['teams.credentials.externalKeys.revokeAll', { resourceId: 'resource-4' },
      { resourceId: 'resource-4', revokedCount: 2 }],
  ] as const)(
    'discovers %s on MCP and executes its Home intent only after deferred approval', async (actionId, input, result) => {
      const output = result ? getActionSpec(actionId).outputSchema.parse(result) : TeamSummaryV1Schema.parse({
        id: 'team-1', name: 'Research', description: null, logo: null,
        archivedAt: actionId === 'teams.archive' ? 1 : null,
        recovery: null, viewerRole: 'owner', capabilities: NO_TEAM_CAPABILITIES_V1,
        counts: null, admission: { historyChoice: { admin: 'choice', member: 'choice', guest: 'hidden' } },
        policy: { v: 1, sessionCreationPolicy: 'private_default', externalSharingPolicy: 'allowed',
          defaultSessionHistoryAccess: 'from_membership', admissionMode: 'invite_only', authenticationPolicy: null },
      });
      let stored: ApprovalRequest | null = null;
      const effects: unknown[] = [];
      // Only the Home HTTP and approval persistence boundaries are replaced.
      // Discovery, availability, approval routing, transitions and replay stay real.
      const deps = {
        homeDomainAction: async (request) => { effects.push(request); return output; },
        approvalsCreate: async ({ request }) => {
          stored = ApprovalRequestV2Schema.parse(request);
          return { artifactId: 'team-lifecycle-approval' };
        },
        approvalsGet: async () => stored,
        approvalsUpdate: async ({ request }) => {
          const transition = transitionStoredApproval(stored, request);
          if (!transition.ok) return transition;
          stored = ApprovalRequestV2Schema.parse(request);
          return { ok: true as const };
        },
        isApprovalExecutionOriginCurrent: async () => true,
      } satisfies Pick<ActionExecutorDeps, 'homeDomainAction' | 'approvalsCreate' | 'approvalsGet'
        | 'approvalsUpdate' | 'isApprovalExecutionOriginCurrent'>;
      const executor = createActionExecutor(deps as ActionExecutorDeps);
      const context = { surface: 'mcp' as const, authority: 'account_automation' as const,
        serverId: 'home-1', runtimeAccountId: 'account-1', actionRequestId: `request-${actionId}`,
        actionCaller: { kind: 'host' as const } };
      const discovery = await executor.execute('action.spec.search', { query: actionId }, context);
      expect(discovery).toMatchObject({ ok: true, result: { actionSpecs: expect.arrayContaining([
        expect.objectContaining({ id: actionId, safety: 'danger', surfaces: expect.objectContaining({ mcp: true }) }),
      ]) } });
      await expect(executor.execute(actionId, input, context)).resolves.toMatchObject({
        ok: true, result: { kind: 'approval_request_created', artifactId: 'team-lifecycle-approval' },
      });
      expect(effects).toEqual([]);
      expect(stored).toMatchObject({ actionId, actionArgs: input,
        approval: { result: 'required', flow: 'deferred' },
        executionOriginV1: { authority: 'account_automation', surface: 'mcp', accountId: 'account-1' } });
      if (!stored) throw new Error('Missing Team lifecycle approval');
      const decidedAtMs = Date.now();
      const approved = ApprovalRequestV2Schema.parse({ ...stored, status: 'approved', updatedAtMs: decidedAtMs,
        decision: { kind: 'approve', decidedAtMs } });
      expect(transitionStoredApproval(stored, approved)).toMatchObject({ ok: true });
      stored = approved;
      await expect(executor.replayApprovedApprovalRequest({ artifactId: 'team-lifecycle-approval' }))
        .resolves.toMatchObject({ ok: true, result: { status: 'executed' } });
      expect(effects).toMatchObject([{ actionId, input,
        context: { surface: 'mcp', authority: 'account_automation', runtimeAccountId: 'account-1' } }]);
      expect(stored).toMatchObject({ status: 'executed', execution: { result: output } });
    },
  );

  it('returns a one-time external API key to the caller without exposing it to after observers', async () => {
    const key = {
      keyId: '123e4567-e89b-42d3-a456-426614174000',
      resourceId: 'resource-1',
      teamMembershipId: 'membership-1',
      label: 'CI runner',
      displayPrefix: 'hapek_v1_123e4567',
      createdAt: '2026-09-14T10:00:00.000Z',
      lastUsedAt: null,
      expiresAt: null,
      authenticationStatus: 'satisfied',
      canAuthorize: false,
    };
    const output = {
      token: `hapek_v1_${key.keyId}_${'a'.repeat(43)}`,
      key,
    };
    const homeDomainAction = vi.fn(async () => output);
    const observeActionExecution = vi.fn(async () => undefined);
    const executor = createActionExecutor({
      homeDomainAction,
      observeActionExecution,
      interceptActionExecution: async ({ input: actionInput }) => ({ status: 'continue' as const, input: actionInput }),
      isActionApprovalRequired: () => false,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('teams.credentials.externalKeys.create', {
      resourceId: 'resource-1',
      teamMembershipId: 'membership-1',
      label: 'CI runner',
      expiresAt: null,
    }, {
      surface: 'ui',
      authority: 'account_automation',
      actionCaller: { kind: 'host' },
    })).resolves.toEqual({ ok: true, result: output });

    expect(observeActionExecution).toHaveBeenCalledWith(expect.objectContaining({
      result: { ok: true, result: { key } },
    }));
    expect(JSON.stringify(observeActionExecution.mock.calls)).not.toContain(output.token);
  });

  it('keeps shared-secret material executable across deferred approval replay but out of previews and observers', async () => {
    const encryptedDataKey = Buffer.alloc(ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES, 3).toString('base64');
    const input = {
      resourceId: 'secret-1',
      displayName: 'CI token',
      kind: 'token' as const,
      encryptionMode: 'e2ee' as const,
      storedContent: { t: 'encrypted' as const, c: Buffer.alloc(40, 7).toString('base64') },
      accountGrants: ['account-2'],
      teamGrants: [],
      groupGrants: [],
      keyEnvelopes: [{
        recipientAccountId: 'account-2',
        encryptedDataKey,
        recipientContentPublicKeyFingerprint: 'content-key:v1:account-2',
      }],
    };
    let storedRequest: ApprovalRequest | null = null;
    const homeDomainAction = vi.fn(async () => ({ resourceId: 'secret-1', revision: 1 }));
    const observeActionExecution = vi.fn(async () => undefined);
    const executor = createActionExecutor({
      homeDomainAction,
      observeActionExecution,
      interceptActionExecution: async ({ input: actionInput }) => ({ status: 'continue' as const, input: actionInput }),
      isActionApprovalRequired: (actionId) => actionId === 'secrets.shared.create',
      approvalsCreate: async ({ request }: { request: ApprovalRequest }) => {
        storedRequest = ApprovalRequestV2Schema.parse(request);
        return { artifactId: 'approval-secret-1' };
      },
      approvalsGet: async () => storedRequest,
      approvalsUpdate: async ({ request }: { request: ApprovalRequest }) => {
        const transition = transitionStoredApproval(storedRequest, request);
        if (!transition.ok) return transition;
        storedRequest = ApprovalRequestV2Schema.parse(request);
        return { ok: true as const };
      },
      isApprovalExecutionOriginCurrent: async () => true,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('secrets.shared.create', input, {
      surface: 'cli',
      authority: 'account_automation',
      serverId: 'home-1',
      runtimeAccountId: 'account-1',
      actionRequestId: 'request-secret-1',
      actionCaller: { kind: 'host' },
    })).resolves.toMatchObject({
      ok: true,
      result: { kind: 'approval_request_created', artifactId: 'approval-secret-1' },
    });

    expect(storedRequest).toMatchObject({
      actionArgs: input,
      preview: {
        actionId: 'secrets.shared.create',
        actionArgs: {
          resourceId: 'secret-1',
          displayName: 'CI token',
          kind: 'token',
          encryptionMode: 'e2ee',
          accountGrants: ['account-2'],
          teamGrants: [],
          groupGrants: [],
        },
      },
    });
    expect(JSON.stringify((storedRequest as ApprovalRequest | null)?.preview)).not.toContain(input.storedContent.c);
    expect(JSON.stringify((storedRequest as ApprovalRequest | null)?.preview)).not.toContain(encryptedDataKey);

    if (!storedRequest) throw new Error('Expected deferred approval request');
    storedRequest = ApprovalRequestV2Schema.parse({
      ...storedRequest,
      status: 'approved',
      updatedAtMs: 2,
      decision: { kind: 'approve', decidedAtMs: 2 },
    });
    await expect(executor.replayApprovedApprovalRequest({ artifactId: 'approval-secret-1' }))
      .resolves.toMatchObject({ ok: true, result: { status: 'executed' } });

    expect(homeDomainAction).toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'secrets.shared.create',
      input,
    }));
    expect(observeActionExecution).toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'secrets.shared.create',
      input: {
        resourceId: 'secret-1',
        displayName: 'CI token',
        kind: 'token',
        encryptionMode: 'e2ee',
        accountGrants: ['account-2'],
        teamGrants: [],
        groupGrants: [],
      },
    }));
    expect(JSON.stringify(observeActionExecution.mock.calls)).not.toContain(input.storedContent.c);
    expect(JSON.stringify(observeActionExecution.mock.calls)).not.toContain(encryptedDataKey);

    // Settled custody: replay has run, so the durable record keeps only this
    // Action's own observation projection of its input.
    expect((storedRequest as ApprovalRequest | null)?.status).toBe('executed');
    expect((storedRequest as ApprovalRequest | null)?.actionArgs).toEqual({
      resourceId: 'secret-1',
      displayName: 'CI token',
      kind: 'token',
      encryptionMode: 'e2ee',
      accountGrants: ['account-2'],
      teamGrants: [],
      groupGrants: [],
    });
    expect(JSON.stringify(storedRequest)).not.toContain(input.storedContent.c);
    expect(JSON.stringify(storedRequest)).not.toContain(encryptedDataKey);
  });

  it.each(['reject', 'canceled'] as const)(
    'scrubs a %s deferred approval input to the Action observation projection',
    async (outcome) => {
      const privateKey = 'BEGIN-RSA-PRIVATE-KEY-material';
      const input = {
        owner: { kind: 'home' as const },
        githubHost: 'https://github.com',
        githubAppId: '1234',
        githubClientId: 'Iv1.client',
        secrets: { privateKey, clientSecret: 'github-client-secret' },
      };
      const persisted: ApprovalRequest[] = [];
      let stored: ApprovalRequest | null = null;
      const homeDomainAction = vi.fn(async () => ({}));
      const approvalsUpdate = async ({ request }: { request: ApprovalRequest }) => {
        const transition = transitionStoredApproval(stored, request);
        if (!transition.ok) return transition;
        stored = ApprovalRequestV2Schema.parse(request);
        persisted.push(stored);
        return { ok: true as const };
      };
      const executor = createActionExecutor({
        homeDomainAction,
        isActionApprovalRequired: (actionId: string) => actionId === 'identity.githubApps.create',
        approvalsCreate: async ({ request }: { request: ApprovalRequest }) => {
          stored = ApprovalRequestV2Schema.parse(request);
          persisted.push(stored);
          return { artifactId: 'approval-github-app' };
        },
        approvalsGet: async () => stored,
        approvalsUpdate,
        isApprovalExecutionOriginCurrent: async () => true,
      } as unknown as ActionExecutorDeps);

      await expect(executor.execute('identity.githubApps.create', input, {
        surface: 'cli',
        authority: 'present_user',
        serverId: 'home-1',
        runtimeAccountId: 'account-1',
        actionRequestId: 'request-github-app',
        actionCaller: { kind: 'host' },
      })).resolves.toMatchObject({
        ok: true,
        result: { kind: 'approval_request_created', artifactId: 'approval-github-app' },
      });

      expect(persisted.at(-1)?.actionArgs).toMatchObject({ secrets: { privateKey } });

      expect(homeDomainAction).not.toHaveBeenCalled();
      expect(persisted[0]?.status).toBe('open');
      expect(persisted[0]?.actionArgs).toEqual(input);
      expect(JSON.stringify(persisted[0]?.preview)).not.toContain(privateKey);
      if (outcome === 'reject') {
        expect(await executor.execute('approval.request.decide', {
          artifactId: 'approval-github-app', decision: 'reject',
        }, { surface: 'ui', authority: 'present_user', serverId: 'home-1',
          runtimeAccountId: 'account-1', actionCaller: { kind: 'host' },
        })).toMatchObject({ ok: true, result: { status: 'rejected' } });
      } else {
        // Cancellation has no separate Action front door. The Artifact transition owner
        // rejects a cancellation retaining raw input, then admits its canonical settlement.
        const open = persisted[0];
        if (!open) throw new Error('Expected persisted GitHub approval');
        const canceled = { ...open, status: 'canceled' as const, updatedAtMs: open.updatedAtMs + 1 };
        expect(await approvalsUpdate({ request: canceled })).toMatchObject({ ok: false, errorCode: 'subject_mismatch' });
        expect(await approvalsUpdate({ request: { ...canceled, actionArgs: settleApprovalRequestActionArgs(open) } }))
          .toMatchObject({ ok: true });
      }
      expect(homeDomainAction).not.toHaveBeenCalled();
      const settled = persisted.at(-1);
      expect(settled?.status).toBe(outcome === 'reject' ? 'rejected' : 'canceled');
      expect(settled?.actionArgs).toEqual({
        owner: { kind: 'home' },
        githubHost: 'https://github.com',
        githubAppId: '1234',
        githubClientId: 'Iv1.client',
      });
      expect(JSON.stringify(settled)).not.toContain(privateKey);
      expect(JSON.stringify(settled)).not.toContain(input.secrets.clientSecret);
    },
  );

  it('resolves a token-only invitation through the canonical preview before creating an approvable artifact', async () => {
    const token = 'a'.repeat(43);
    let storedRequest: ApprovalRequest | null = null;
    const homeDomainAction = vi.fn(async ({ actionId }: { actionId: string }) => {
      if (actionId === 'teams.invitations.accept.prepareApproval') {
        return {
          outcome: 'ok' as const,
          continuation: {
            v: 1 as const,
            kind: 'post_auth_invitation' as const,
            reference: 'prepared-continuation-reference',
            teamId: 'team-1',
          },
          preview: {
            home: { serverId: 'srv-home-1', displayName: 'Acme Home', storageMode: 'encrypted' as const },
            team: { teamId: 'team-1', name: 'Platform', logo: null, accentSeed: 'team-1' },
            role: 'member' as const,
            historyAccess: 'from_membership' as const,
            state: 'active' as const,
            expiresAt: 20,
            recipientEmailMask: 'a•••@example.com',
          },
        };
      }
      return { outcome: 'joined' as const, teamId: 'team-1' };
    });
    const executor = createActionExecutor({
      homeDomainAction,
      isActionApprovalRequired: (actionId) => actionId === 'teams.invitations.accept',
      approvalsCreate: async ({ request }: { request: ApprovalRequest }) => {
        storedRequest = ApprovalRequestV2Schema.parse(request);
        return { artifactId: 'approval-invitation-1' };
      },
      approvalsGet: async () => storedRequest,
      approvalsUpdate: async ({ request }: { request: ApprovalRequest }) => {
        const transition = transitionStoredApproval(storedRequest, request);
        if (!transition.ok) return transition;
        storedRequest = ApprovalRequestV2Schema.parse(request);
        return { ok: true as const };
      },
      isApprovalExecutionOriginCurrent: async () => true,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('teams.invitations.accept', { v: 1, token }, {
      surface: 'cli',
      authority: 'account_automation',
      serverId: 'home-profile-1',
      runtimeAccountId: 'account-1',
      actionRequestId: 'request-invitation-1',
      actionCaller: { kind: 'host' },
    })).resolves.toMatchObject({
      ok: true,
      result: { kind: 'approval_request_created', artifactId: 'approval-invitation-1' },
    });

    expect(homeDomainAction).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      actionId: 'teams.invitations.accept.prepareApproval',
      input: { v: 1, token },
    }));
    expect(storedRequest).toMatchObject({
      actionId: 'teams.invitations.accept',
      actionArgs: {
        v: 1,
        continuation: {
          v: 1,
          kind: 'post_auth_invitation',
          reference: 'prepared-continuation-reference',
          teamId: 'team-1',
        },
      },
      preview: {
        actionId: 'teams.invitations.accept',
        actionArgs: {
          homeServerId: 'srv-home-1',
          continuation: { teamId: 'team-1' },
          teamName: 'Platform',
          role: 'member',
          historyAccess: 'from_membership',
          state: 'active',
          expiresAt: 20,
          recipientEmailMask: 'a•••@example.com',
        },
      },
    });
    expect(JSON.stringify(storedRequest)).not.toContain(token);

    expect(resolveApprovalRequestApproveAdmission(ApprovalRequestV2Schema.parse(storedRequest))).toMatchObject({
      status: 'available',
    });

    await expect(executor.execute('approval.request.decide', {
      artifactId: 'approval-invitation-1',
      decision: 'approve',
    }, {
      surface: 'cli',
      authority: 'present_user',
    })).resolves.toMatchObject({
      ok: true,
      result: { status: 'executed' },
    });
    expect(homeDomainAction).toHaveBeenLastCalledWith(expect.objectContaining({
      actionId: 'teams.invitations.accept',
      input: {
        v: 1,
        continuation: expect.objectContaining({ reference: 'prepared-continuation-reference' }),
      },
    }));
  });

  it('does not let explicit approval creation override canonical invitation presentation fields', async () => {
    const token = 'd'.repeat(43);
    let storedRequest: ApprovalRequest | null = null;
    const homeDomainAction = vi.fn(async () => ({
      outcome: 'ok' as const,
      continuation: {
        v: 1 as const,
        kind: 'post_auth_invitation' as const,
        reference: 'explicit-prepared-reference',
        teamId: 'team-1',
      },
      preview: {
        home: { serverId: 'srv-home-1', displayName: 'Acme Home', storageMode: 'encrypted' as const },
        team: { teamId: 'team-1', name: 'Platform', logo: null, accentSeed: 'team-1' },
        role: 'member' as const,
        historyAccess: 'from_membership' as const,
        state: 'active' as const,
        expiresAt: 20,
        recipientEmailMask: 'a•••@example.com',
      },
    }));
    const executor = createActionExecutor({
      homeDomainAction,
      approvalsCreate: async ({ request }: { request: ApprovalRequest }) => {
        storedRequest = ApprovalRequestV2Schema.parse(request);
        return { artifactId: 'approval-explicit-invitation-1' };
      },
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('approval.request.create', {
      actionId: 'teams.invitations.accept',
      actionArgs: { v: 1, token },
      summary: `Misleading caller summary ${token}`,
      createdBy: { surface: 'system' },
      preview: {
        actionId: 'session.list',
        actionArgs: { token },
        summary: `Caller-supplied supplemental context ${token}`,
      },
    }, {
      surface: 'mcp',
      authority: 'present_user',
      serverId: 'home-profile-1',
      runtimeAccountId: 'account-1',
      actionRequestId: 'request-explicit-invitation-1',
      actionCaller: { kind: 'host' },
    })).resolves.toMatchObject({
      ok: true,
      result: { artifactId: 'approval-explicit-invitation-1' },
    });

    expect(storedRequest).toMatchObject({
      actionId: 'teams.invitations.accept',
      actionArgs: {
        v: 1,
        continuation: expect.objectContaining({ reference: 'explicit-prepared-reference' }),
      },
      summary: buildApprovalPreviewSummary(getActionSpec('teams.invitations.accept'), { v: 1, token }),
      preview: {
        actionId: 'teams.invitations.accept',
        actionArgs: {
          homeServerId: 'srv-home-1',
          continuation: { teamId: 'team-1' },
          teamName: 'Platform',
          role: 'member',
          historyAccess: 'from_membership',
          state: 'active',
          expiresAt: 20,
          recipientEmailMask: 'a•••@example.com',
        },
      },
    });
    expect((storedRequest as ApprovalRequest | null)?.preview).not.toHaveProperty('summary');
    expect((storedRequest as ApprovalRequest | null)?.summary).not.toContain('Misleading caller');
    expect(JSON.stringify(storedRequest)).not.toContain(token);
    expect(resolveApprovalRequestApproveAdmission(ApprovalRequestV2Schema.parse(storedRequest))).toMatchObject({
      status: 'available',
    });
  });

  it.each(['ui', 'cli', 'rpc', 'mcp'] as const)(
    'refuses approve from the %s decision surface when required context was not presentable',
    async (decisionSurface) => {
      const token = 'b'.repeat(43);
      let storedRequest: ApprovalRequest | null = null;
      const approvalsUpdate = vi.fn(async ({ request }: { request: ApprovalRequest }) => {
        storedRequest = request;
        return { ok: true as const };
      });
      const homeDomainAction = vi.fn(async () => ({ outcome: 'unavailable' as const }));
      const executor = createActionExecutor({
        homeDomainAction,
        isActionApprovalRequired: (actionId) => actionId === 'teams.invitations.accept',
        approvalsCreate: async ({ request }: { request: ApprovalRequest }) => {
          storedRequest = ApprovalRequestV2Schema.parse(request);
          return { artifactId: 'approval-unpresentable-1' };
        },
        approvalsGet: async () => storedRequest,
        approvalsUpdate,
        isApprovalExecutionOriginCurrent: async () => true,
      } as unknown as ActionExecutorDeps);

      await expect(executor.execute('teams.invitations.accept', { v: 1, token }, {
        surface: 'cli',
        authority: 'account_automation',
        serverId: 'home-profile-1',
        runtimeAccountId: 'account-1',
        actionRequestId: 'request-unpresentable-1',
        actionCaller: { kind: 'host' },
      })).resolves.toEqual({
        ok: false,
        errorCode: 'approval_context_unavailable',
        error: 'approval_context_unavailable',
        requestId: 'request-unpresentable-1',
      });
      expect(approvalsUpdate).not.toHaveBeenCalled();
      expect(storedRequest).toBeNull();
      expect(homeDomainAction).toHaveBeenCalledTimes(1);
    },
  );

  it('does not persist a deferred invitation approval after preview cancellation', async () => {
    const token = 'c'.repeat(43);
    const controller = new AbortController();
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'approval-canceled-1' }));
    const homeDomainAction = vi.fn(async ({ actionId }: { actionId: string }) => {
      expect(actionId).toBe('teams.invitations.accept.prepareApproval');
      controller.abort();
      throw Object.assign(new Error('canceled'), { name: 'AbortError' });
    });
    const executor = createActionExecutor({
      homeDomainAction,
      isActionApprovalRequired: (actionId) => actionId === 'teams.invitations.accept',
      approvalsCreate,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('teams.invitations.accept', { v: 1, token }, {
      surface: 'cli',
      authority: 'account_automation',
      serverId: 'home-profile-1',
      runtimeAccountId: 'account-1',
      actionRequestId: 'request-canceled-1',
      actionCaller: { kind: 'host' },
      signal: controller.signal,
    })).resolves.toEqual({
      ok: false,
      errorCode: 'cancelled',
      error: 'cancelled',
      requestId: 'request-canceled-1',
    });
    expect(approvalsCreate).not.toHaveBeenCalled();
  });

  it('routes a validated governance mutation to the one Home family dependency', async () => {
    const controller = new AbortController();
    const homeDomainAction = vi.fn(async () => homeAccountRow());
    const executor = createActionExecutor({
      homeDomainAction,
      isActionApprovalRequired: () => false,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('home.accounts.role.set', roleSetInput, {
      surface: 'ui',
      authority: 'present_user',
      actionCaller: { kind: 'host' },
      signal: controller.signal,
    })).resolves.toEqual({ ok: true, result: homeAccountRow() });

    expect(homeDomainAction).toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'home.accounts.role.set',
      input: roleSetInput,
      signal: controller.signal,
    }));
  });

  it('rejects an input the strict domain schema refuses before reaching the Home', async () => {
    const homeDomainAction = vi.fn(async () => homeAccountRow());
    const executor = createActionExecutor({
      homeDomainAction,
      isActionApprovalRequired: () => false,
    } as unknown as ActionExecutorDeps);

    const result = await executor.execute('home.accounts.role.set', {
      ...roleSetInput,
      homeRole: 'superuser',
    }, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } });

    expect(result.ok).toBe(false);
    expect(homeDomainAction).not.toHaveBeenCalled();
  });

  it('reports a host without the Home family as unsupported rather than silently succeeding', async () => {
    const executor = createActionExecutor({
      isActionApprovalRequired: () => false,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('teams.archive', { v: 1, teamId: 'team-1' }, {
      presentUserConfirmation: { actionId: 'teams.archive' },
      surface: 'ui',
      authority: 'present_user',
      actionCaller: { kind: 'host' },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'unsupported_action',
      error: 'unsupported_action:teams.archive',
    });
  });

  it('carries a Team intent through the same single dependency', async () => {
    const homeDomainAction = vi.fn(async () => ({ outcome: 'joined' as const, teamId: 'team-1' }));
    const executor = createActionExecutor({
      homeDomainAction,
      isActionApprovalRequired: () => false,
    } as unknown as ActionExecutorDeps);

    const token = 'a'.repeat(43);
    await expect(executor.execute('teams.invitations.accept', { v: 1, token }, {
      surface: 'ui',
      authority: 'present_user',
      actionCaller: { kind: 'host' },
    })).resolves.toEqual({ ok: true, result: { outcome: 'joined', teamId: 'team-1' } });

    expect(homeDomainAction).toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'teams.invitations.accept',
      input: { v: 1, token },
    }));
  });

  it('admits explicitly waived directory removal from API automation while refusing sibling mutations', async () => {
    const output = {
      v: 1 as const,
      status: 'removed' as const,
      impact: {
        teamMembershipsRemoved: 0,
        groupMembershipsRemoved: 0,
        groupContributionsRemoved: 0,
        directoryCreatedGroupsRetained: 0,
        nativeMembershipsPreserved: 0,
        nativeGroupContributionsPreserved: 0,
      },
    };
    const homeDomainAction = vi.fn(async () => output);
    const settings = ActionsSettingsV1Schema.parse({ v: 1,
      approvalWaivedSurfaces: { 'teams.directory.sources.remove': ['api'] } });
    const executor = createActionExecutor({
      homeDomainAction,
      isActionApprovalRequired: (actionId, context) => isApprovalRequiredByActionsSettings(actionId, settings, context),
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('teams.directory.sources.remove', {
      v: 1,
      teamId: 'team-1',
      sourceId: 'source-1',
    }, {
      surface: 'api',
      authority: 'account_automation',
      serverId: 'home-1',
      runtimeAccountId: 'account-1',
      actionCaller: { kind: 'host' },
    })).resolves.toEqual({ ok: true, result: output });

    await expect(executor.execute('teams.directory.sources.sync', {
      v: 1,
      teamId: 'team-1',
      sourceId: 'source-1',
    }, {
      surface: 'api',
      authority: 'account_automation',
      serverId: 'home-1',
      runtimeAccountId: 'account-1',
      actionCaller: { kind: 'host' },
    })).resolves.toMatchObject({ ok: false });

    expect(homeDomainAction.mock.calls).toHaveLength(1);
  });

  it.each(['api', 'agent', 'mcp'] as const)('defers directory removal on %s and replays its original principal', async (surface) => {
    const actionId = 'teams.directory.sources.remove' as const;
    const input = { v: 1 as const, teamId: 'team-1', sourceId: 'source-1' };
    let stored: ApprovalRequest | null = null;
    const effectOrigins: unknown[] = [];
    const authorization = {
      v: 1 as const,
      token: 'invocation-authorization',
      binding: {
        serverIdentityId: 'server-1', accountId: 'account-1', principalId: 'account-1',
        credentialId: 'credential-1', grant: API_TOKEN_FULL_GRANT_V1,
        machineId: 'machine-1', custodianAccountId: 'account-1', installationId: 'installation-1',
        actionId, requestId: 'directory-removal-request', requestEnvelopeDigest: 'a'.repeat(43),
        target: { kind: 'machine' as const, machineId: 'machine-1' },
      },
    };
    const deps = {
      homeDomainAction: async ({ context }) => {
        effectOrigins.push(context);
        return { v: 1, status: 'removed', impact: {
          teamMembershipsRemoved: 0, groupMembershipsRemoved: 0, groupContributionsRemoved: 0,
          directoryCreatedGroupsRetained: 0, nativeMembershipsPreserved: 0, nativeGroupContributionsPreserved: 0,
        } };
      },
      approvalsCreate: async ({ request }) => {
        stored = ApprovalRequestV2Schema.parse(request);
        return { artifactId: 'directory-removal-approval' };
      },
      approvalsGet: async () => stored,
      approvalsUpdate: async ({ request }) => {
        const transition = transitionStoredApproval(stored, request);
        if (!transition.ok) return transition;
        stored = ApprovalRequestV2Schema.parse(request);
        return { ok: true };
      },
      isApprovalExecutionOriginCurrent: async () => true,
    } satisfies Pick<ActionExecutorDeps, 'homeDomainAction' | 'approvalsCreate' | 'approvalsGet'
      | 'approvalsUpdate' | 'isApprovalExecutionOriginCurrent'>;
    const executor = createActionExecutor(deps as ActionExecutorDeps);

    await expect(executor.execute(actionId, input, {
      surface, authority: 'account_automation', serverId: 'home-1', runtimeAccountId: 'account-1',
      actionRequestId: 'directory-removal-request', actionCaller: { kind: 'host' },
      ...(surface === 'api' ? {
        externalActionCredential: { accountId: 'account-1', principalId: 'account-1',
          credentialId: 'credential-1', grant: API_TOKEN_FULL_GRANT_V1 },
        externalActionTarget: authorization.binding.target,
        externalActionExecutionAuthorization: authorization,
        signExternalActionApprovalInput: () => 'a'.repeat(86),
      } : {}),
    })).resolves.toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(effectOrigins).toEqual([]);
    expect(stored).toMatchObject({ actionId, actionArgs: input, approval: { flow: 'deferred', result: 'required' },
      executionOriginV1: { authority: 'account_automation', surface, accountId: 'account-1' } });
    if (!stored) throw new Error('Missing directory removal approval');
    stored = ApprovalRequestV2Schema.parse({ ...stored, status: 'approved', updatedAtMs: 2,
      decision: { kind: 'approve', decidedAtMs: 2 } });
    await expect(executor.replayApprovedApprovalRequest({ artifactId: 'directory-removal-approval' }))
      .resolves.toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(effectOrigins).toMatchObject([{ authority: 'account_automation', surface,
      runtimeAccountId: 'account-1', ...(surface === 'api' ? { externalActionExecutionAuthorization: authorization } : {}) }]);
  });

  it('returns a transferable invitation bearer to its direct caller but redacts the shared execution observation', async () => {
    const invitation = {
      id: 'invitation-1',
      teamId: 'team-1',
      state: 'active' as const,
      role: 'member' as const,
      historyAccess: 'from_membership' as const,
      recipientEmailMask: null,
      expiresAt: 2,
      createdAt: 1,
      createdByAccountId: 'account-1',
      acceptedByAccountId: null,
      lastEmailDelivery: null,
    };
    const output = {
      invitation,
      joinUrl: 'https://home.example/join/direct-caller-bearer',
    };
    const observeActionExecution = vi.fn(async () => undefined);
    const executor = createActionExecutor({
      homeDomainAction: vi.fn(async () => output),
      isActionApprovalRequired: () => false,
      interceptActionExecution: async ({ input }) => ({ status: 'continue' as const, input }),
      observeActionExecution,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('teams.invitations.create', {
      v: 1,
      teamId: 'team-1',
      role: 'member',
      historyAccess: 'from_membership',
      recipientEmail: null,
      requestKey: 'request-1',
    }, {
      surface: 'ui',
      authority: 'present_user',
      actionCaller: { kind: 'host' },
    })).resolves.toEqual({ ok: true, result: output });

    expect(observeActionExecution).toHaveBeenCalledWith(expect.objectContaining({
      result: { ok: true, result: { invitation, joinUrl: null } },
    }));
    expect(JSON.stringify(observeActionExecution.mock.calls)).not.toContain('direct-caller-bearer');
  });

  it.each([
    ['teams.invitations.create', {
      v: 1,
      teamId: 'team-1',
      role: 'member',
      historyAccess: 'from_membership',
      recipientEmail: null,
      requestKey: 'request-create',
    }],
    ['teams.invitations.reissue', {
      v: 1,
      teamId: 'team-1',
      invitationId: 'invitation-1',
      recipientEmail: null,
      requestKey: 'request-reissue',
    }],
  ] as const)('keeps %s agent results safe and delivers its live bearer only to the approving UI on every call', async (actionId, input) => {
    const invitation = {
      id: 'invitation-1', teamId: 'team-1', state: 'active' as const,
      role: 'member' as const, historyAccess: 'from_membership' as const,
      recipientEmailMask: null, expiresAt: 2, createdAt: 1,
      createdByAccountId: 'account-1', acceptedByAccountId: null, lastEmailDelivery: null,
    };
    const joinUrl = 'https://home.example/join/live-human-only-bearer';
    const output = actionId === 'teams.invitations.create' ? { invitation, joinUrl }
      : { previous: { ...invitation, state: 'revoked' as const }, replacement: invitation, joinUrl };
    getActionSpec(actionId).inputSchema.parse(input);
    getActionSpec(actionId).outputSchema!.parse(output);
    let stored: ApprovalRequest | null = null;
    const persisted: ApprovalRequest[] = [];
    const homeDomainAction = vi.fn(async () => output);
    const boundary = {
      homeDomainAction,
      approvalsCreate: async ({ request }: { request: ApprovalRequest }) => {
        stored = ApprovalRequestV2Schema.parse(request);
        persisted.push(stored);
        return { artifactId: 'invitation-approval' };
      },
      approvalsGet: async () => stored,
      approvalsUpdate: async ({ request }: { request: ApprovalRequest }) => {
        const transition = transitionStoredApproval(stored, request);
        if (!transition.ok) return transition;
        stored = ApprovalRequestV2Schema.parse(request);
        persisted.push(stored);
        return { ok: true as const };
      },
      isApprovalExecutionOriginCurrent: async () => true,
    } as unknown as ActionExecutorDeps;
    const executor = createActionExecutor(boundary);
    const remoteDecider = createActionExecutor({ ...boundary,
      // Exact-daemon RPC boundary; replay and local custody remain real.
      approvalRequestApprovedReplay: async ({ artifactId, context }) => executor.replayApprovedApprovalRequest({
        artifactId, callerAuthority: context.authority,
      }),
    });
    let completedEffects = 0;

    for (const surface of ['agent', 'mcp'] as const) for (const viaReplay of [false, true]) {
      const requester = { surface, authority: 'account_automation' as const, serverId: 'home-1',
        runtimeAccountId: 'account-1', actionRequestId: `request-${surface}`,
        actionCaller: { kind: 'host' as const } };
      const result = await executor.execute(actionId, input, requester);
      expect(result).toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'invitation-approval' } });
      {
        expect(homeDomainAction).toHaveBeenCalledTimes(completedEffects);
        const deciding = viaReplay ? remoteDecider : executor;
        const decision = await deciding.execute('approval.request.decide', {
          artifactId: 'invitation-approval', decision: 'approve',
        }, { surface: 'ui', authority: 'present_user', serverId: 'home-1', runtimeAccountId: 'account-1',
          actionCaller: { kind: 'host' } });
        completedEffects++;
        expect(JSON.stringify(result).includes(joinUrl)).toBe(false);
        expect(decision).toMatchObject({ ok: true, result: { liveExecution: { ok: true, result: output } } });
        // Approval snapshots are host-internal RPC reads, not another Agent tool.
        const observed = await executor.execute('approval.request.get', { artifactId: 'invitation-approval' },
          { ...requester, surface: 'rpc' });
        expect(observed).toMatchObject({ ok: true });
        expect(JSON.stringify(observed)).not.toContain(joinUrl);
        expect(persisted.at(-1)?.execution).toMatchObject({ ok: true, result: getActionSpec(actionId).projectObservationOutput!(output) });
        const repeat = await executor.execute('approval.request.decide', { artifactId: 'invitation-approval', decision: 'approve' },
          { surface: 'ui', authority: 'present_user', serverId: 'home-1', runtimeAccountId: 'account-1', actionCaller: { kind: 'host' } });
        expect(JSON.stringify(repeat).includes(joinUrl)).toBe(false);
        expect(JSON.stringify(persisted)).not.toContain(joinUrl);
      }
    }
    expect(homeDomainAction).toHaveBeenCalledTimes(4);
  });

  it.each([
    [
      'teams.invitations.preview',
      { v: 1, token: 'a'.repeat(43) },
      'a'.repeat(43),
      { v: 1 },
      {
        outcome: 'ok' as const,
        preview: {
          home: {
            serverId: 'home-1',
            displayName: 'Home',
            storageMode: 'encrypted' as const,
            hosting: null,
          },
          team: { teamId: 'team-1', name: 'Team', logo: null, accentSeed: 'team-1' },
          role: 'member' as const,
          historyAccess: 'from_membership' as const,
          state: 'active' as const,
          expiresAt: 2,
          inviterLabel: null,
          recipientEmailMask: null,
        },
      },
    ],
    [
      'teams.invitations.accept',
      { v: 1, token: 'b'.repeat(43) },
      'b'.repeat(43),
      { v: 1 },
      { outcome: 'joined' as const, teamId: 'team-1' },
    ],
    [
      'teams.invitations.accept',
      {
        v: 1,
        continuation: {
          v: 1,
          kind: 'post_auth_invitation',
          reference: 'oauth_pending_exact',
          teamId: 'team-1',
        },
      },
      'oauth_pending_exact',
      {
        v: 1,
        continuation: {
          v: 1,
          kind: 'post_auth_invitation',
          teamId: 'team-1',
        },
      },
      { outcome: 'joined' as const, teamId: 'team-1' },
    ],
  ] as const)('keeps the %s bearer available to execution but out of its durable observation', async (
    actionId,
    input,
    secret,
    observedInput,
    output,
  ) => {
    const homeDomainAction = vi.fn(async () => output);
    const observeActionExecution = vi.fn(async () => undefined);
    const executor = createActionExecutor({
      homeDomainAction,
      isActionApprovalRequired: () => false,
      interceptActionExecution: async ({ input }) => ({ status: 'continue' as const, input }),
      observeActionExecution,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute(actionId, input, {
      surface: 'api',
      authority: 'account_automation',
      actionCaller: { kind: 'host' },
    })).resolves.toEqual({ ok: true, result: output });

    expect(homeDomainAction).toHaveBeenCalledWith(expect.objectContaining({
      actionId,
      input,
    }));
    expect(observeActionExecution).toHaveBeenCalledWith(expect.objectContaining({
      actionId,
      input: observedInput,
      result: { ok: true, result: output },
    }));
    expect(JSON.stringify(observeActionExecution.mock.calls)).not.toContain(secret);
  });

  it.each([
    [
      'teams.identity.connections.test.start',
      { v: 1, teamId: 'team-1', connectionId: 'connection-1', expectedRevision: 1 },
      { authorizeUrl: 'https://home.example/identity-test', attemptId: 'attempt-1' },
    ],
    [
      'teams.identity.workos.adminPortalLink.create',
      { v: 1, teamId: 'team-1', connectionId: 'connection-1', intent: 'sso' },
      { url: 'https://setup.workos.com/portal' },
    ],
  ] as const)('returns %s through its declared approval custody', async (actionId, input, output) => {
    let storedRequest: ApprovalRequest | null = null;
    const homeDomainAction = vi.fn(async () => output);
    const executor = createActionExecutor({
      approvalsCreate: async ({ request }: { request: ApprovalRequest }) => {
        storedRequest = ApprovalRequestV2Schema.parse(request);
        return { artifactId: `approval-${actionId}` };
      },
      approvalsGet: async () => storedRequest,
      approvalsUpdate: async ({ request }: { request: ApprovalRequest }) => {
        const transition = transitionStoredApproval(storedRequest, request);
        if (!transition.ok) return transition;
        storedRequest = ApprovalRequestV2Schema.parse(request);
        return { ok: true as const };
      },
      approvalsWaitForDecision: async ({ request }: { request: ApprovalRequest }) => ({
        decision: 'approve' as const,
        decisionAuthority: 'present_user' as const,
        request,
      }),
      isApprovalExecutionOriginCurrent: async () => true,
      homeDomainAction,
    } as unknown as ActionExecutorDeps);

    const result = await executor.execute(actionId, input, {
      surface: 'agent',
      authority: 'account_automation',
      serverId: 'home-1',
      runtimeAccountId: 'account-1',
      actionRequestId: `request-${actionId}`,
      defaultSessionMachineId: 'machine-1',
      actionCaller: { kind: 'host' },
    });
    expect(result).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(homeDomainAction).not.toHaveBeenCalled();
    const decision = await executor.execute('approval.request.decide', { artifactId: `approval-${actionId}`, decision: 'approve' },
      { surface: 'ui', authority: 'present_user', serverId: 'home-1', runtimeAccountId: 'account-1',
        actionCaller: { kind: 'host' } });
    expect(decision).toMatchObject({ ok: true, result: { status: 'executed',
      ...(getActionSpec(actionId).approvalResultCustody === 'live_only' ? { liveExecution: { ok: true, result: output } } : {}) } });
    expect(storedRequest).toMatchObject({ execution: { ok: true,
      result: getActionSpec(actionId).approvalResultCustody === 'live_only'
        ? getActionSpec(actionId).projectObservationOutput!(output) : output } });
    expect(homeDomainAction).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ actionId, input }));
  });

  it.each(['reject', 'stale'] as const)('does not execute Team identity automation after %s approval', async (scenario) => {
    let storedRequest: ApprovalRequest | null = null;
    const homeDomainAction = vi.fn(async () => ({ url: 'https://setup.workos.com/portal' }));
    const executor = createActionExecutor({
      approvalsCreate: async ({ request }: { request: ApprovalRequest }) => {
        storedRequest = ApprovalRequestV2Schema.parse(request);
        return { artifactId: `approval-${scenario}` };
      },
      approvalsGet: async () => storedRequest,
      approvalsUpdate: async ({ request }: { request: ApprovalRequest }) => {
        const transition = transitionStoredApproval(storedRequest, request);
        if (!transition.ok) return transition;
        storedRequest = ApprovalRequestV2Schema.parse(request);
        return { ok: true as const };
      },
      approvalsWaitForDecision: async ({ request }: { request: ApprovalRequest }) => ({
        decision: scenario === 'reject' ? 'reject' as const : 'approve' as const,
        decisionAuthority: 'present_user' as const,
        request,
      }),
      isApprovalExecutionOriginCurrent: async ({ reportStale }) => {
        if (scenario !== 'stale') return true;
        reportStale?.('origin_not_current');
        return false;
      },
      homeDomainAction,
    } as unknown as ActionExecutorDeps);

    const result = await executor.execute('teams.identity.workos.adminPortalLink.create', {
      v: 1,
      teamId: 'team-1',
      connectionId: 'connection-1',
      intent: 'sso',
    }, {
      surface: 'agent',
      authority: 'account_automation',
      serverId: 'home-1',
      runtimeAccountId: 'account-1',
      actionRequestId: `request-${scenario}`,
      defaultSessionMachineId: 'machine-1',
      actionCaller: { kind: 'host' },
    });

    expect(result).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    const decision = await executor.execute('approval.request.decide', { artifactId: `approval-${scenario}`, decision: scenario === 'reject' ? 'reject' : 'approve' },
      { surface: 'ui', authority: 'present_user', serverId: 'home-1', runtimeAccountId: 'account-1', actionCaller: { kind: 'host' } });
    expect(decision).toMatchObject({
      ok: scenario === 'reject',
      ...(scenario === 'reject' ? { result: { status: 'rejected' } } : { errorCode: 'approval_stale' }),
    });
    expect(homeDomainAction).not.toHaveBeenCalled();
  });
  it.each([
    [
      'teams.identity.workos.adminPortalLink.create',
      { v: 1, teamId: 'team-1', connectionId: 'connection-1', intent: 'sso' },
      { url: 'https://setup.workos.com/portal?token=portal-bearer' },
      'portal-bearer',
    ],
  ] as const)('keeps the present-user one-time %s result on its live invocation and never writes it to the Artifact', async (actionId, input, liveResult, secret) => {
    const persisted: ApprovalRequest[] = [];
    const homeDomainAction = vi.fn(async () => liveResult);
    const executor = createActionExecutor({
      presentUserActionConfirmation: async () => true,
      approvalsCreate: async ({ request }: { request: ApprovalRequest }) => {
        persisted.push(ApprovalRequestV2Schema.parse(request));
        return { artifactId: `ui-live-only-${actionId}` };
      },
      approvalsGet: async () => persisted.at(-1) ?? null,
      approvalsUpdate: async ({ request }: { request: ApprovalRequest }) => {
        const transition = transitionStoredApproval(persisted.at(-1), request);
        if (!transition.ok) return transition;
        persisted.push(ApprovalRequestV2Schema.parse(request));
        return { ok: true as const };
      },
      approvalsWaitForDecision: async ({ request }: { request: ApprovalRequest }) => ({
        decision: 'approve' as const,
        request,
      }),
      isApprovalExecutionOriginCurrent: async () => true,
      isActionApprovalRequired: () => true,
      homeDomainAction,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute(actionId, input, {
      surface: 'ui',
      authority: 'present_user',
      serverId: 'home-1',
      runtimeAccountId: 'account-1',
      actionRequestId: `request-ui-${actionId}`,
      actionCaller: { kind: 'host' },
    })).resolves.toEqual({ ok: true, result: liveResult });

    expect(homeDomainAction).toHaveBeenCalledOnce();
    expect(persisted).toEqual([]);
    expect(JSON.stringify(persisted)).not.toContain(secret);
  });

  it('scrubs a rejected approval input to the Action observation projection', async () => {
    const clientSecret = 'deferred-client-secret';
    const input = {
      owner: { kind: 'home' as const },
      id: 'provider-1',
      expectedRevision: 3,
      clientSecret,
    };
    const coordinator = createBlockingApprovalCoordinator();
    let signalWaiting!: () => void;
    const waiting = new Promise<void>(resolve => { signalWaiting = resolve; });
    const persisted: ApprovalRequest[] = [];
    let stored: ApprovalRequest | null = null;
    const homeDomainAction = vi.fn(async () => ({}));
    const executor = createActionExecutor({
      approvalsCreate: async ({ request }: { request: ApprovalRequest }) => {
        stored = ApprovalRequestV2Schema.parse(request);
        persisted.push(stored);
        return { artifactId: 'approval-secret-replace' };
      },
      approvalsGet: async () => stored,
      approvalsUpdate: async ({ request }: { request: ApprovalRequest }) => {
        const transition = transitionStoredApproval(stored, request);
        if (!transition.ok) return transition;
        stored = ApprovalRequestV2Schema.parse(request);
        persisted.push(stored);
        return { ok: true as const };
      },
      approvalsResolveBlockingDecision: (args: Parameters<NonNullable<ActionExecutorDeps['approvalsResolveBlockingDecision']>>[0]) => coordinator.resolveBlockingDecision(args),
      approvalsWaitForDecision: async (args: Parameters<NonNullable<ActionExecutorDeps['approvalsWaitForDecision']>>[0]) => {
        const pending = coordinator.waitForDecision(args); signalWaiting(); return pending;
      },
      isApprovalExecutionOriginCurrent: async () => true,
      isActionApprovalRequired: (actionId: string) => actionId === 'identity.providers.secret.replace',
      homeDomainAction,
    } as unknown as ActionExecutorDeps);

    const pending = executor.execute('identity.providers.secret.replace', input, {
      surface: 'cli',
      authority: 'present_user',
      serverId: 'home-1',
      runtimeAccountId: 'account-1',
      actionRequestId: 'request-secret-replace',
      actionCaller: { kind: 'host' },
    });
    expect(await Promise.race([pending.then(result => ({ kind: 'completed', result })),
      waiting.then(() => ({ kind: 'waiting' }))])).toEqual({ kind: 'waiting' });
    // The live invocation owns private input, including while review is open.
    expect(JSON.stringify(persisted)).not.toContain(clientSecret);

    await expect(executor.execute('approval.request.decide', {
      artifactId: 'approval-secret-replace',
      decision: 'reject',
    }, {
      surface: 'ui',
      authority: 'present_user',
      serverId: 'home-1',
      runtimeAccountId: 'account-1',
      actionCaller: { kind: 'host' },
    })).resolves.toMatchObject({ ok: true });

    expect(await pending).toMatchObject({ ok: false, errorCode: 'approval_rejected' });
    coordinator.dispose();
    const settled = persisted.at(-1);
    expect(settled?.status).toBe('rejected');
    expect(settled?.actionArgs).toEqual({
      owner: { kind: 'home' },
      id: 'provider-1',
      expectedRevision: 3,
    });
    expect(JSON.stringify(settled)).not.toContain(clientSecret);
  });
});
