import { describe, expect, it } from 'vitest';
import { API_TOKEN_FULL_GRANT_V1 } from '../../auth/apiTokenGrant.js';
import { computeActionInputApprovalDigestV1 } from '../decisionAuthority.js';
import type { ActionExecutorContext } from './types.js';
import { prepareApiTokenDeploymentAuthoring } from './apiTokenDeploymentAuthoring.js';
import { ExternalActionExecutionAuthorizationV1Schema } from '../externalActionApi.js';
import { createProjectAccountRowCipherV1 } from '../../projects/projectAccountRowCipherV1.js';
import { createActionExecutor } from '../actionExecutor.js';
import { ActionsSettingsV1Schema } from '../actionSettings.js';
import { AccountApiTokenSummaryV1Schema } from '../../auth/accountApiTokens.js';
// Collect the real approved-operation owner before timing behavior; its cold transform is not token authoring work.
import './workflowRunActions.js';

const grant = { ...API_TOKEN_FULL_GRANT_V1,
  actions: { families: [], ids: ['deployments.deploy', 'action.operations.get'] },
  targets: { sessions: [], machines: [], environments: ['staging'] } };
const person: ActionExecutorContext = { surface: 'cli', authority: 'present_user',
  actionCaller: { kind: 'host' }, runtimeAccountId: 'person', serverId: 'home', actionRequestId: 'save' };
const host = { nativeAccount: { accountId: 'person', serverId: 'home', isCurrent: async () => true } };

describe('token Automatic authoring', () => {
  it('authors the exact CI token update as a reviewed Move child without another person decision', async () => {
    const value = { tokenId: '11111111-1111-4111-8111-111111111111',
      grant: { ...grant, deployApproval: 'automatic' as const } };
    const child = { action: 'account.apiTokens.update' as const, role: 'ci-reapproval', input: value };
    const input = { serverId: 'home', sourceId: 'source', expectedRevision: 1, teamId: 'team', requestKey: 'move-ci' };
    let authored: unknown;
    const executor = createActionExecutor({
      prepareHostReviewedChildren: async request => request.actionId === 'projects.sources.moveToTeam' ? { children: [child] } : null,
      projectSourcesMoveToTeam: async (_input, context) => {
        const result = await context.hostReviewedChild!.invoke(child);
        return result.ok ? { kind: 'partial', childOperations: [] } : result;
      },
      // Token persistence/HTTP is the boundary; the Action and consent author run real.
      accountApiTokensUpdateAction: async ({ input, context }) => {
        authored = (await prepareApiTokenDeploymentAuthoring({ actionId: child.action, value: input, context, host })).body;
        return { apiToken: AccountApiTokenSummaryV1Schema.parse({ tokenId: value.tokenId, label: 'CI',
          displayPrefix: 'hap_v1_11111111', createdAt: '2026-10-30T00:00:00Z', lastUsedAt: null, expiresAt: null,
          hasEncryptionAccess: false, hasUnattendedTeamAccess: true, grant: value.grant,
          parentTokenId: null, activeChildCount: 0, embedConfig: null }) };
      },
    });
    expect(await executor.execute('projects.sources.moveToTeam', input, {
      ...person, actionRequestId: 'move-ci', actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: {} }),
      presentUserConfirmation: { actionId: 'projects.sources.moveToTeam', accountId: 'person', serverId: 'home',
        requestId: 'move-ci', inputDigest: computeActionInputApprovalDigestV1('projects.sources.moveToTeam', input) },
    })).toEqual({ ok: true, result: { kind: 'partial', childOperations: [] } });
    expect(authored).toEqual(value);
  });

  it.each(['account.apiTokens.create', 'account.apiTokens.update'] as const)('%s saves a deliberate choice without opening Environment content', async actionId => {
    const base = { tokenId: '11111111-1111-4111-8111-111111111111', label: 'CI' };
    for (const fields of [
      { grant: { ...grant, deployApproval: 'automatic' as const } },
      { grant, deployment: { serverId: 'home', environmentId: 'staging', deployApproval: 'automatic' as const } },
    ]) {
      const value = { ...base, ...fields };
      const prepare = (context: ActionExecutorContext) => prepareApiTokenDeploymentAuthoring({ actionId, value, context, host });
      expect((await prepare(person)).body).toMatchObject({ grant: { deployApproval: 'automatic' } });
      for (const context of [
        { ...person, authority: 'account_automation' as const },
        { ...person, authority: undefined },
        { ...person, surface: 'agent' as const, actionCaller: { kind: 'agent' as const } },
        { ...person, approvedActionReplay: { artifactId: 'old' } },
        { ...person, externalActionCredential: { accountId: 'person', principalId: 'person', credentialId: 'api-token', grant } },
      ]) await expect(prepare(context)).rejects.toMatchObject({ code: 'approval_required' });
      await expect(prepareApiTokenDeploymentAuthoring({ actionId, value, context: person,
        host: { nativeAccount: { ...host.nativeAccount, isCurrent: async () => false } } }))
        .rejects.toMatchObject({ code: 'approval_required' });
      await expect(prepareApiTokenDeploymentAuthoring({ actionId, value, context: person }))
        .rejects.toMatchObject({ code: 'approval_required' });
      for (const kind of ['account', 'terminal'] as const) {
        const authorization = { ...ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'signed-root', binding: {
          accountId: 'person', authentication: { kind, tokenEpoch: 0 },
          serverIdentityId: 'home', machineId: 'machine', installationId: 'installation', custodianAccountId: 'person',
          actionId, requestId: 'save', requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: 'machine' },
        } }), requesterAccountProjection: {
          accountId: 'person', serverId: 'home', accountEncryptionMode: 'plain' as const,
          projectAccountRowCipher: createProjectAccountRowCipherV1({ mode: 'plain', material: null, randomBytes: length => new Uint8Array(length) }),
          isCurrent: async () => true, readArtifact: async () => null,
        } };
        await expect(prepare({ ...person, authority: 'account_automation', externalActionExecutionAuthorization: authorization }))
          .rejects.toMatchObject({ code: 'approval_required' });
      }
      const artifactId = 'approved';
      expect((await prepare({ ...person, authority: 'account_automation', actionCaller: { kind: 'agent' },
        approvedActionReplay: { artifactId }, presentUserApproval: { artifactId, actionId, requestId: 'save',
          decidingAccountId: 'decider', inputDigest: computeActionInputApprovalDigestV1(actionId, value) } })).body)
        .toMatchObject({ grant: { deployApproval: 'automatic' } });
    }
  });

  it('makes Ask the absence of consent and rejects conflicting Environment authoring', async () => {
    const value = { tokenId: '11111111-1111-4111-8111-111111111111', grant,
      deployment: { serverId: 'home', environmentId: 'staging', deployApproval: 'ask' as const } };
    const prepared = await prepareApiTokenDeploymentAuthoring({ actionId: 'account.apiTokens.update', value, context: {} });
    expect(prepared.body.grant).not.toHaveProperty('deployApproval');
    expect(prepared.body).not.toHaveProperty('deploymentConsent');
    await expect(prepareApiTokenDeploymentAuthoring({ actionId: 'account.apiTokens.update',
      value: { ...value, deployment: { ...value.deployment, environmentId: 'other', deployApproval: 'automatic' } }, context: person }))
      .rejects.toMatchObject({ code: 'credential_scope_denied' });
  });

  it('consumes the initial default while matching approval against the original omitted-mode input', async () => {
    const value = { tokenId: '11111111-1111-4111-8111-111111111111', deployment: { serverId: 'home', environmentId: 'staging' } };
    const artifactId = 'approved-default';
    const context: ActionExecutorContext = { ...person, authority: 'account_automation', actionCaller: { kind: 'agent' },
      approvedActionReplay: { artifactId }, presentUserApproval: { artifactId, actionId: 'account.apiTokens.update', requestId: 'save',
        decidingAccountId: 'person', inputDigest: computeActionInputApprovalDigestV1('account.apiTokens.update', value) } };
    const prepared = await prepareApiTokenDeploymentAuthoring({ actionId: 'account.apiTokens.update', value, context,
      host: { initialDeployApproval: 'automatic' } });
    expect(prepared.body).toMatchObject({ deployment: { deployApproval: 'automatic' } });
    expect(prepared.body.grant).toBeUndefined();
  });
});
