import { describe, expect, it, vi } from 'vitest';

import { ApprovalRequestV2Schema, type ApprovalRequest } from '../approvals/approvalRequestV1.js';
import { decideApprovalRequestTransition, settleApprovalRequestActionArgs } from '../approvals/approvalRequestTransition.js';
import type { HomeAccountRowV1 } from '../home/governance/accounts.js';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES } from '../crypto/encryptedDataKeyEnvelopeFormatV1.js';

const roleSetInput = { accountId: 'account-2', homeRole: 'admin' } as const;

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
    profile: { firstName: 'Ada', lastName: null, username: null, avatarUrl: null },
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
      summary: 'Accept Team invitation',
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

  it('admits only the approved directory-source removal mutation to API automation', async () => {
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
    const executor = createActionExecutor({
      homeDomainAction,
      isActionApprovalRequired: () => false,
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

    expect(homeDomainAction).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      actionId: 'teams.directory.sources.remove',
      input: { v: 1, teamId: 'team-1', sourceId: 'source-1' },
      context: expect.objectContaining({
        surface: 'api',
        authority: 'account_automation',
        serverId: 'home-1',
        runtimeAccountId: 'account-1',
      }),
    }));

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
    })).resolves.toEqual({
      ok: false,
      errorCode: 'present_user_required',
      error: 'present_user_required',
    });

    expect(homeDomainAction).toHaveBeenCalledTimes(1);
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
  ] as const)('does not expose %s as an autonomous Agent invocation', async (actionId, input) => {
    const homeDomainAction = vi.fn(async () => ({}));
    const executor = createActionExecutor({
      homeDomainAction,
      isActionApprovalRequired: () => false,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute(actionId, input, {
      surface: 'agent',
      authority: 'account_automation',
      actionCaller: { kind: 'host' },
    })).resolves.toMatchObject({ ok: false, errorCode: 'action_disabled' });
    expect(homeDomainAction).not.toHaveBeenCalled();
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
  ] as const)('returns the immediate one-time result after blocking approval for %s', async (actionId, input, output) => {
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
        request,
      }),
      isApprovalExecutionOriginCurrent: async () => true,
      homeDomainAction,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute(actionId, input, {
      surface: 'agent',
      authority: 'account_automation',
      serverId: 'home-1',
      runtimeAccountId: 'account-1',
      actionRequestId: `request-${actionId}`,
      actionCaller: { kind: 'host' },
    })).resolves.toEqual({ ok: true, result: output });
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
        request,
      }),
      isApprovalExecutionOriginCurrent: async () => scenario !== 'stale',
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
      actionCaller: { kind: 'host' },
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: scenario === 'reject' ? 'approval_rejected' : 'approval_stale',
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
    expect(persisted.at(-1)?.execution).toEqual({
      executedAtMs: expect.any(Number),
      ok: true,
      result: { redacted: true },
    });
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
      isApprovalExecutionOriginCurrent: async () => true,
      isActionApprovalRequired: (actionId: string) => actionId === 'identity.providers.secret.replace',
      homeDomainAction,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('identity.providers.secret.replace', input, {
      surface: 'ui',
      authority: 'present_user',
      serverId: 'home-1',
      runtimeAccountId: 'account-1',
      actionRequestId: 'request-secret-replace',
      actionCaller: { kind: 'host' },
    })).resolves.toMatchObject({
      ok: true,
      result: { kind: 'approval_request_created', artifactId: 'approval-secret-replace' },
    });

    // Deferred replay still needs the raw input while the request is open.
    expect(persisted.at(-1)?.actionArgs).toMatchObject({ clientSecret });

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
