import { ActionsSettingsV1Schema } from './actionSettings.js';
import { describe, expect, it } from 'vitest';
import { ApprovalRequestV2Schema, type ApprovalRequestV2 } from '../approvals/approvalRequestV1.js';
import { decideApprovalRequestTransition } from '../approvals/approvalRequestTransition.js';
import { getActionSpec } from './actionSpecs.js';
import { createActionExecutor } from './actionExecutor.js';
import { resolveApprovalRequestApproveAdmission } from './actionApprovalPresentation.js';
import { ManagedOidcIdentityProviderV1Schema, ManagedIdentityProviderCreateInputV1Schema } from '../identity/providers.js';

const secret = 'synthetic-private-review-value';
const shared = { resourceId: 'reviewed-secret', displayName: 'Deployment token', kind: 'token',
  accountGrants: ['recipient'], teamGrants: [], groupGrants: [] };
const owner = { kind: 'home' };
const identityCreateInput = ManagedIdentityProviderCreateInputV1Schema.parse({ owner,
  displayName: 'Company sign-in', clientSecret: secret,
  config: { v: 1, kind: 'oidc', issuer: 'https://id.example.test', clientId: 'client',
    scopes: 'openid profile email', httpTimeoutSeconds: 30,
    claims: { login: 'sub', email: 'email', groups: 'groups' },
    allow: { usersAllowlist: [], emailDomains: [], groupsAny: [], groupsAll: [] },
    fetchUserInfo: false, storeRefreshToken: false, ui: { buttonColor: null, iconHint: 'oidc' } },
});
const identityResult = ManagedOidcIdentityProviderV1Schema.parse({ v: 1, owner, id: 'identity-provider',
  displayName: identityCreateInput.displayName, enabled: false, firstEnabledAt: null, securityRevision: 4, revision: 4,
  lastSuccessfulTest: null, createdByAccountId: 'account', createdAt: 1, updatedAt: 2,
  kind: 'oidc', config: identityCreateInput.config, secret: { configured: true, health: 'configured' },
});
const cases = [
  { actionId: 'secrets.shared.grants.set' as const, mode: 'revoke-all', input: {
    resourceId: shared.resourceId, expectedRevision: 2, accountGrants: [], teamGrants: [], groupGrants: [],
  } },
  { actionId: 'secrets.shared.grants.set' as const, mode: 'grant-team', input: {
    resourceId: shared.resourceId, expectedRevision: 2, accountGrants: [], teamGrants: ['recipient-team'], groupGrants: [],
  } },
  ...(['plain', 'e2ee'] as const).flatMap(mode => {
    const storedContent = mode === 'plain'
      ? { t: 'plain', v: { v: 1, name: shared.displayName, kind: shared.kind, value: secret } }
      : { t: 'encrypted', c: Buffer.alloc(40, 7).toString('base64') };
    const create = { ...shared, encryptionMode: mode, storedContent };
    return [
      { actionId: 'secrets.shared.create' as const, mode, input: create },
      { actionId: 'secrets.shared.update' as const, mode, input: { resourceId: shared.resourceId,
        expectedRevision: 3, displayName: shared.displayName, kind: shared.kind, storedContent, toMode: mode } },
      { actionId: 'secrets.shared.promote' as const, mode, input: { ...create, expectedSettingsVersion: 2,
        nextSettings: { t: 'plain', v: {} },
        referenceCensus: { accountMode: 'plain', profiles: { referenceGuardRevision: 'absent', rows: [] } } } },
    ];
  }),
  { actionId: 'identity.providers.secret.replace' as const, mode: 'private',
    input: { owner, id: 'identity-provider', expectedRevision: 3, clientSecret: secret } },
  { actionId: 'identity.providers.create' as const, mode: 'private', input: identityCreateInput },
  { actionId: 'home.settings.set' as const, mode: 'private',
    input: { expectedRevision: 3, values: {}, secrets: { WORKOS_API_KEY: { replace: secret } } } },
];

describe('confidential Action review declarations', () => {
  it.each(cases)('reviews $actionId ($mode) without displaying material or losing executable operands', async ({ actionId, mode, input: rawInput }) => {
    const input = getActionSpec(actionId).inputSchema.parse(rawInput);
    const liveInput = actionId === 'identity.providers.create' || actionId === 'identity.providers.secret.replace'
      || actionId === 'home.settings.set';
    let stored: ApprovalRequestV2 | undefined;
    const effects: unknown[] = [];
    const observations: unknown[] = [];
    const executor: ReturnType<typeof createActionExecutor> = createActionExecutor({
      // Only persistence, Home verification and the final native effect are
      // boundaries. The actual preparation, review, decision and CAS run here.
      approvalsCreate: async ({ request }) => {
        stored = ApprovalRequestV2Schema.parse(JSON.parse(JSON.stringify(request)));
        return { artifactId: 'confidential-review' };
      },
      approvalsGet: async () => structuredClone(stored),
      // The original invocation's decision transport acknowledges delivery;
      // the real executor still owns the approval CAS and retained execution.
      approvalsResolveBlockingDecision: async () => ({ resolved: true }),
      // The decision observer is the transport boundary; the live invocation
      // retains the supplied credential while this person answers its request.
      approvalsWaitForDecision: async ({ request }) => {
        expect(JSON.stringify(stored)).not.toContain(secret);
        expect(await executor.execute('approval.request.decide', { artifactId: 'confidential-review', decision: 'approve' }, context))
          .toMatchObject({ ok: true, result: { status: 'approved' } });
        return { decision: 'approve', decisionAuthority: 'present_user', request: stored ?? request };
      },
      approvalsUpdate: async ({ request, expectedStatus }) => {
        if (!stored) throw new Error('Missing review request');
        const next = ApprovalRequestV2Schema.parse(request);
        const transition = decideApprovalRequestTransition(stored, next, { expectedStatus });
        if (!transition.ok) return transition;
        stored = structuredClone(next);
        return { ok: true };
      },
      readActionsSettings: context => ActionsSettingsV1Schema.parse({ v: 1, actions: { [actionId]: { approvalRequiredSurfaces: [context.surface] } } }),
      isApprovalExecutionOriginCurrent: async () => true,
      homeDomainAction: async request => {
        effects.push(request.input);
        if (actionId.startsWith('identity.providers.')) return identityResult;
        if (actionId === 'home.settings.set') return { revision: 4, startedAt: null, entries: [] };
        return actionId === 'secrets.shared.promote' ? { resourceId: shared.resourceId, settingsVersion: 3 }
          : { resourceId: shared.resourceId, revision: 4 };
      },
      observeActionExecution: async observation => { observations.push(observation); },
    });
    const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
      serverId: 'home', serverIdentityId: 'stable-home', runtimeAccountId: 'account', actionRequestId: 'review-request' } as const;
    // CLI policy review exercises both durable operands and live-only custody;
    // the person's own UI press uses its separate native confirmation.
    const invokingContext = { ...context, surface: 'cli', authority: 'account_automation',
      defaultSessionMachineId: 'controller' } as const;
    const initial = await executor.execute(actionId, input, invokingContext);
    expect(initial, initial.ok ? undefined : initial.errorCode).toMatchObject(liveInput ? { ok: true } : { ok: true, result: { kind: 'approval_request_created' } });
    const request = ApprovalRequestV2Schema.parse(stored);
    if (liveInput) expect(JSON.stringify(request)).not.toContain(secret);
    else expect(request.actionArgs).toEqual(input);
    const admission = resolveApprovalRequestApproveAdmission(request);
    expect(admission).toMatchObject({ status: 'available' });
    const visiblePaths = admission.presentation.rows.map(row => row.path);
    if (actionId === 'secrets.shared.grants.set') {
      for (const path of ['accountGrants', 'teamGrants', 'groupGrants']) {
        expect(admission.presentation.rows).toContainEqual(expect.objectContaining({ kind: 'value', path,
          value: path === 'teamGrants' && mode === 'grant-team' ? 'recipient-team' : '[]' }));
      }
    }
    expect(visiblePaths).not.toContain('clientSecret');
    expect(visiblePaths).not.toContain('storedContent');
    expect(visiblePaths).not.toContain('keyEnvelopes');
    expect(visiblePaths).toContain(actionId === 'identity.providers.create' ? 'displayName'
      : actionId === 'identity.providers.secret.replace' ? 'id'
      : actionId === 'home.settings.set' ? 'expectedRevision' : 'resourceId');
    expect(JSON.stringify(request.preview)).not.toContain(secret);
    expect(JSON.stringify(admission.presentation)).not.toContain(secret);
    if (!liveInput) expect(effects).toEqual([]);
    const decided = liveInput ? initial
      : await executor.execute('approval.request.decide', { artifactId: 'confidential-review', decision: 'approve' }, context);
    const execution = ApprovalRequestV2Schema.parse(stored).execution;
    expect(decided, execution && !execution.ok ? execution.errorCode : undefined)
      .toMatchObject(liveInput ? { ok: true } : { ok: true, result: { status: 'executed' } });
    expect(effects).toEqual([input]);
    expect(JSON.stringify(observations)).not.toContain(secret);
    expect(JSON.stringify(stored)).not.toContain(secret);
  });
});
