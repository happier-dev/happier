import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from '../actionExecutor.js';
import { getActionSpec, listActionSpecsForSurface } from '../actionSpecs.js';
import { resolveActionApprovalRouting } from '../actionApprovalPolicy.js';
import { projectApprovalRequestForPublicRead } from '../actionApprovalPresentation.js';
import { bindHomeDomainHttpRequestV1 } from '../homeDomainHttpBinding.js';
import { createDeploymentApprovalScopeResolverV1 } from '../../deployments/deploymentApprovalScopeV1.js';
import { DeploymentPublishInputV1Schema, type DeploymentTemplateInstantiateResultV1 } from '../../deployments/deploymentActionsV1.js';
import { formatSharedSavedSecretRefV1 } from '../../account/settings/savedSecretReferenceV1.js';
import tweetnacl from 'tweetnacl';
import { ApprovalRequestV2Schema, StoredApprovalRequestSchema, requiresExactDaemonApprovalReplay,
  type ApprovalRequestV2 } from '../../approvals/approvalRequestV1.js';
import { decideApprovalRequestTransition, settleApprovalRequestReplayInputs } from '../../approvals/approvalRequestTransition.js';
import { ExternalActionExecutionAuthorizationV1Schema } from '../externalActionApi.js';
import { computeExternalActionRequestEnvelopeDigestV1, isExternalActionAuthorizationBoundToEnvelope,
  signExternalActionApprovalInputV1, verifyExternalActionApprovalInputV1 } from '../externalActionExecutionAuthorization.js';

describe('Deployment Action front door', () => {
  it('approves retained Domain removal through durable review without prepared-content input', async () => {
    const input = { serverId: 'home', environmentId: 'production', domainId: 'domain',
      expectedRevision: 4, expectedDomainRevision: 2, requestKey: 'remove-domain' };
    const removed = { ok: true, environmentId: 'production', revision: 5, domain: {
      v: 1, id: 'domain', environmentId: 'production', targetLinkId: 'runtime', revision: 3,
      state: 'removing', contentArtifactId: 'retained-domain-content', contentHeaderVersion: 1,
      contentBodyVersion: 1, createdByAccountId: 'owner', createdAtMs: 1, updatedAtMs: 2,
    } };
    let stored: ApprovalRequestV2 | null = null;
    const effects: unknown[] = [];
    const executor = createActionExecutor({
      // Artifact storage and the installed host are external boundaries. Review,
      // decision, transition and replay run through the real Action owners.
      resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(async () => ({ ok: true,
        environment: { v: 1, id: 'production', serverId: 'home', projectSourceId: 'source', revision: 4,
          owner: { kind: 'account', accountId: 'owner' }, protection: 'nonProduction', purpose: 'standard',
          deployerMode: 'managers', controllerMachineId: 'controller', runtimeTargetLinkId: 'runtime',
          contentArtifactId: 'environment-content', contentHeaderVersion: 1, contentBodyVersion: 1,
          capabilities: { role: 'manager', read: true, deploy: true, manage: true,
            manageBindings: true, manageTargets: true, delete: true },
          createdByAccountId: 'owner', createdAtMs: 1, updatedAtMs: 1 }, targetLinks: [],
      })),
      deploymentAction: async (actionId, admitted) => { effects.push({ actionId, input: admitted }); return removed; },
      approvalsCreate: async ({ request }) => {
        stored = ApprovalRequestV2Schema.parse(structuredClone(request));
        return { artifactId: 'domain-removal-review' };
      },
      approvalsGet: async () => structuredClone(stored),
      approvalsUpdate: async ({ request, expectedStatus }) => {
        if (!stored) throw new Error('Missing stored Domain removal review');
        const next = ApprovalRequestV2Schema.parse(request);
        const transition = decideApprovalRequestTransition(stored, next, { expectedStatus });
        if (!transition.ok) return transition;
        stored = structuredClone(next);
        return { ok: true };
      },
      isApprovalExecutionOriginCurrent: async () => true,
    });
    const context = { surface: 'cli', authority: 'account_automation', actionCaller: { kind: 'host' },
      serverId: 'home', serverIdentityId: 'srv_home', runtimeAccountId: 'owner', actionRequestId: 'remove-domain' } as const;
    expect(await executor.execute('deployments.domains.remove', input, context)).toMatchObject({
      ok: true, result: { kind: 'approval_request_created' },
    });
    expect(ApprovalRequestV2Schema.parse(stored).actionArgs).toEqual(input);
    expect(effects).toEqual([]);
    const decided = await executor.execute('approval.request.decide', {
      artifactId: 'domain-removal-review', decision: 'approve',
    }, { ...context, surface: 'ui', authority: 'present_user' });
    expect(decided, JSON.stringify(decided)).toMatchObject({ ok: true,
      result: { status: 'executed', execution: { ok: true, result: removed } },
    });
    expect(effects).toEqual([{ actionId: 'deployments.domains.remove', input }]);
    expect(getActionSpec('deployments.environments.update').inputHints?.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'contentArtifactId', required: true }),
      expect.objectContaining({ path: 'contentHeaderVersion', required: true }),
      expect.objectContaining({ path: 'contentBodyVersion', required: true }),
    ]));
  });
  it.each(['prepared', 'durableAsk'] as const)('rechecks the reviewed template facts before effects through %s', async path => {
    const input = { mode: 'apply', serverId: 'home', machineId: 'target', projectSourceId: 'source',
      templateRef: { sourceId: 'apps', itemId: 'database', version: '1', ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } },
      environment: { kind: 'create', name: 'Database', requestKey: 'create-database', protection: 'nonProduction',
        purpose: 'standard', deployerMode: 'managers', controllerMachineId: 'target' },
      target: { kind: 'new', installationId: 'installed' }, destination: { kind: 'stored' }, bindings: [] };
    for (const change of ['capacity', 'defaultsRevision', 'observationTime'] as const) {
      let effects = 0;
      let stored: ApprovalRequestV2 | undefined;
      let observedBytes: number | null = 1024;
      let observedAt = 100;
      let defaultsRevision = 1;
      // The installed daemon preparation/effect and Artifact/host-observation
      // ports are boundaries here. CLI composition separately exercises the real
      // registry, defaults reader and template preparation behind those ports.
      const deps = {
        resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(async () => { throw new Error('New Environment'); }),
        prepareDeploymentTemplateInstantiation: async ({ input: admitted }) => ({ input: admitted, preview: {
          templateRef: admitted.templateRef, profiles: [], services: ['db'], bindings: [], generatedSecrets: [], domains: [],
          creationDefaults: { values: { retainPreviousDeployments: 0 }, sources: { retainPreviousDeployments: 'project' } },
          creationDefaultsBasis: { projectSourceId: 'source', sourceRevision: 1, projectDefaultsRevision: defaultsRevision, content: null },
          capacity: [{ resource: 'memoryBytes', minimumBytes: 2048, observedBytes, observedAt,
            state: observedBytes === null ? 'unknown' : 'shortfall' }],
        } }),
        deploymentTemplateInstantiate: async () => {
          effects += 1;
          return { kind: 'applied' as const, environmentId: 'created', revision: 1, targetLinkId: 'runtime',
            definition: { kind: 'stored' as const, contentRevision: 1, composeDigest: `sha256:${'b'.repeat(64)}` }, savedSecrets: [] };
        },
        approvalsCreate: async ({ request }) => { stored = ApprovalRequestV2Schema.parse(structuredClone(request)); return { artifactId: 'review' }; },
        approvalsGet: async () => stored ?? null,
        approvalsUpdate: async ({ request }) => { stored = ApprovalRequestV2Schema.parse(request); return { ok: true as const }; },
        isApprovalExecutionOriginCurrent: async () => true,
      } satisfies Pick<ActionExecutorDeps, 'resolveEnvironmentApprovalScope' | 'prepareDeploymentTemplateInstantiation'
        | 'deploymentTemplateInstantiate' | 'approvalsCreate' | 'approvalsGet' | 'approvalsUpdate' | 'isApprovalExecutionOriginCurrent'>;
      const executor = createActionExecutor(deps as ActionExecutorDeps);
      const context = { surface: path === 'prepared' ? 'ui' as const : 'cli' as const,
        authority: path === 'prepared' ? 'present_user' as const : 'account_automation' as const,
        actionCaller: { kind: 'host' as const }, serverId: 'home', serverIdentityId: 'srv_home',
        runtimeAccountId: 'account', actionRequestId: `template-${change}`, executionRunTargetMachineId: 'target' };
      const prepared = await executor.prepare('deployments.templates.instantiate', input, context);
      if (path === 'prepared') expect(prepared.kind).toBe('ready');
      else {
        const open = ApprovalRequestV2Schema.parse(stored);
        expect(open.preview).toMatchObject({ deploymentReview: { capacity: [{ observedBytes: 1024 }] } });
        const approved = ApprovalRequestV2Schema.parse({ ...open, status: 'approved', updatedAtMs: open.updatedAtMs + 1,
          decision: { kind: 'approve', authority: 'present_user', decidedAtMs: open.updatedAtMs + 1 } });
        expect(decideApprovalRequestTransition(open, approved)).toMatchObject({ ok: true });
        stored = approved;
      }
      if (change === 'capacity') observedBytes = null;
      else if (change === 'defaultsRevision') defaultsRevision = 2;
      else observedAt = 200;
      const result = path === 'prepared' && prepared.kind === 'ready' ? await prepared.invocation.run()
        : await executor.replayApprovedApprovalRequest({ artifactId: 'review', callerAuthority: 'present_user',
          currentAccount: { accountId: 'account', serverId: 'home', serverIdentityId: 'srv_home' } });
      if (change === 'observationTime') {
        expect.soft(effects).toBe(1);
        expect.soft(path === 'prepared' ? result : stored?.execution).toMatchObject({ ok: true });
      } else {
        expect.soft(effects).toBe(0);
        expect.soft(path === 'prepared' ? result : stored?.execution).toMatchObject({ ok: false, errorCode: 'approval_stale' });
      }
    }
  });

  it('retains acknowledged template effects and an unknown secret candidate in an Action failure', async () => {
    const input = { mode: 'apply', serverId: 'home', machineId: 'target', projectSourceId: 'source',
      templateRef: { sourceId: 'apps', itemId: 'database', version: '1', ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } },
      environment: { kind: 'create', name: 'Database', requestKey: 'create-database', protection: 'nonProduction',
        purpose: 'standard', deployerMode: 'managers', controllerMachineId: 'target' },
      target: { kind: 'new', installationId: 'installed' }, destination: { kind: 'stored' }, bindings: [] };
    const partial = { kind: 'partial', phase: 'generation', errorCode: 'outcome_unknown', environmentId: 'created', revision: 2,
      savedSecrets: [{ name: 'FIRST_PASSWORD', phase: 'runtime', source: { kind: 'secret',
        ref: formatSharedSavedSecretRefV1('acknowledged'), resourceRevision: 1 } }],
      unknownSecret: { name: 'SECOND_PASSWORD', phase: 'runtime', ref: formatSharedSavedSecretRefV1('unknown-candidate') },
    } satisfies Extract<DeploymentTemplateInstantiateResultV1, { kind: 'partial' }>;
    let failBeforeEffect = false;
    // Protocol dispatches the reached host's result; its platform/HTTP owner
    // supplies this boundary. The real schema, scope and approval policy run.
    const deps = {
      resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(async () => { throw new Error('New Environment has no existing metadata'); }),
      deploymentTemplateInstantiate: async () => failBeforeEffect
        ? { ok: false as const, errorCode: 'target_mismatch', error: 'target_mismatch' } : partial,
    } satisfies Pick<ActionExecutorDeps, 'resolveEnvironmentApprovalScope' | 'deploymentTemplateInstantiate'>;
    const executor = createActionExecutor(deps as ActionExecutorDeps);
    const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId: 'home', runtimeAccountId: 'account', actionCaller: { kind: 'host' as const } };
    expect(await executor.execute('deployments.templates.instantiate', input, context))
      .toEqual({ ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown', details: partial });
    failBeforeEffect = true;
    expect(await executor.execute('deployments.templates.instantiate', input, context))
      .toEqual({ ok: false, errorCode: 'target_mismatch', error: 'target_mismatch' });
  });

  it.each(['terminal', 'session'] as const)('keeps the original %s deployment root and signed prepared inputs distinct through durable Ask', async actor => {
    const actionId = 'deployments.promote';
    const originalInput = { serverId: 'home', environmentId: 'production', expectedRevision: 4,
      targetLinkId: 'production-runtime', expectedTargetLinkRevision: 2, requestKey: 'promote-a',
      contentArtifactId: 'original-receipt', contentHeaderVersion: 1, contentBodyVersion: 1,
      sourceEnvironmentId: 'staging', sourceDeploymentId: 'receipt-a', sourceExpectedRevision: 3,
      sourceExpectedDeploymentRevision: 2, artifact: 'image', destinationContent: {
        contentArtifactId: 'original-destination', contentHeaderVersion: 1, contentBodyVersion: 1 } };
    const preparedInput = { ...originalInput, contentArtifactId: 'reviewed-receipt', destinationContent: {
      contentArtifactId: 'reviewed-destination', contentHeaderVersion: 1, contentBodyVersion: 1 } };
    const target = { kind: 'machine' as const, machineId: 'controller' };
    const envelope = { v: 1 as const, requestId: 'original-promote', target, input: originalInput };
    const caller = { kind: 'session' as const, sessionId: 'proposer', starterDepth: 0, turnDepth: 0 };
    const sessionActionOrigin = { v: 1, caller, sourceTurnId: 'proposing-turn', callerPermissionMode: 'default',
      requestId: envelope.requestId };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-admitted-root', binding: {
      accountId: 'requester', authentication: { kind: actor === 'session' ? 'account' : 'terminal', tokenEpoch: 1 }, custodianAccountId: 'requester',
      serverIdentityId: `srv_${'a'.repeat(32)}`, machineId: target.machineId, installationId: 'controller-installation',
      accountEncryptionMode: 'plain', actionId, requestId: envelope.requestId,
      ...(actor === 'session' ? { sessionActionOrigin,
        sessionActionSource: { machineId: target.machineId, installationId: 'controller-installation' } } : {}),
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), target } });
    const keys = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(27));
    let stored: ApprovalRequestV2 | undefined;
    // Only Artifact persistence is substituted. Origin capture, input signing,
    // strict replay decoding and durable transition rules remain real.
    const deps = {
      approvalsCreate: async ({ request }) => {
        stored = ApprovalRequestV2Schema.parse(JSON.parse(JSON.stringify(request)));
        return { artifactId: 'promote-approval' };
      },
    } satisfies Pick<ActionExecutorDeps, 'approvalsCreate'>;
    // This focused persistence/transport fixture does not mount unrelated host domains.
    const executor = createActionExecutor(deps as ActionExecutorDeps);
    expect(await executor.execute('approval.request.create', { actionId, actionArgs: preparedInput,
      summary: 'Promote reviewed images', createdBy: { surface: 'system' } }, {
      surface: actor === 'session' ? 'agent' : 'cli', authority: 'account_automation',
      actionCaller: actor === 'session' ? caller : { kind: 'host' },
      ...(actor === 'session' ? { defaultSessionId: caller.sessionId, callerPermissionMode: 'default',
        sessionInputSource: { sourceSessionId: caller.sessionId, sourceTurnId: sessionActionOrigin.sourceTurnId, via: 'action' as const } } : {}),
      serverId: 'home', serverIdentityId: authorization.binding.serverIdentityId, runtimeAccountId: 'requester',
      actionRequestId: envelope.requestId, externalActionExecutionAuthorization: authorization, externalActionTarget: target,
      originalActionEnvelope: envelope, signExternalActionApprovalInput: request => signExternalActionApprovalInputV1({
        actionId: request.actionId, input: request.input, target: request.target,
        authorizationToken: request.authorization.token, privateKey: keys.secretKey }),
    })).toEqual({ ok: true, result: { artifactId: 'promote-approval' } });
    const open = ApprovalRequestV2Schema.parse(stored);
    expect(open.executionOriginV1.originalActionEnvelope).toEqual(envelope);
    const approved = ApprovalRequestV2Schema.parse({ ...open, status: 'approved', updatedAtMs: open.updatedAtMs + 1,
      decision: { kind: 'approve', authority: 'present_user', decidedAtMs: open.updatedAtMs + 1 } });
    expect(decideApprovalRequestTransition(open, approved)).toMatchObject({ ok: true });
    const resumed = StoredApprovalRequestSchema.parse(JSON.parse(JSON.stringify(approved)));
    expect(requiresExactDaemonApprovalReplay(resumed)).toBe(true);
    expect(resumed.actionArgs).toEqual(preparedInput);
    const origin = resumed.v === 2 ? resumed.executionOriginV1 : undefined;
    expect(origin?.originalActionEnvelope).toEqual(envelope);
    expect(origin?.externalActionExecutionAuthorization).toEqual(authorization);
    if (!origin?.originalActionEnvelope || !origin.externalActionInputSignature) throw new Error('Replay proof was not retained');
    expect(isExternalActionAuthorizationBoundToEnvelope(authorization.binding,
      { actionId, machineId: target.machineId, envelope: origin.originalActionEnvelope })).toBe(true);
    expect(ApprovalRequestV2Schema.safeParse({ ...resumed, executionOriginV1: { ...origin,
      originalActionEnvelope: { ...envelope, input: preparedInput } } }).success).toBe(false);
    const proof = { authorizationToken: authorization.token, actionId, target,
      publicKey: keys.publicKey, signature: origin.externalActionInputSignature };
    expect(verifyExternalActionApprovalInputV1({ ...proof, input: resumed.actionArgs })).toBe(true);
    expect(verifyExternalActionApprovalInputV1({ ...proof, input: originalInput })).toBe(false);
    expect(projectApprovalRequestForPublicRead(resumed)).not.toHaveProperty('executionOriginV1.originalActionEnvelope');
    const settled = { ...settleApprovalRequestReplayInputs(resumed), status: 'failed' as const,
      updatedAtMs: resumed.updatedAtMs + 1,
      execution: { ok: false, executedAtMs: resumed.updatedAtMs + 1, errorCode: 'target_unavailable', error: 'target_unavailable' } };
    expect(decideApprovalRequestTransition(resumed, settled)).toMatchObject({ ok: true });
    expect(settled.v === 2 ? settled.executionOriginV1.originalActionEnvelope : undefined).toBeUndefined();
  });

  it('prepares one exact Publish through DF host admission before handing off to the Workflow boundary', async () => {
    const content = { contentArtifactId: 'reviewed', contentHeaderVersion: 1, contentBodyVersion: 1 };
    const input = { serverId: 'home', requestKey: 'publish-a', hostMachineId: 'parent-host',
      project: { kind: 'existing', projectSourceId: 'source', sourceRevision: 1 },
      definition: { kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}` },
      destination: { kind: 'ownServer', machines: [{ machineId: 'runtime', installationId: 'installed' }],
        controllerMachineId: 'controller', buildMachineId: 'builder' },
      environment: { kind: 'existing', environmentId: 'staging', expectedRevision: 1 },
      preparedChildren: { deploy: { serverId: 'home', environmentId: 'staging', expectedRevision: 1,
        requestKey: 'deploy-a', targetLinkId: 'runtime-link', expectedTargetLinkRevision: 1, ...content } } };
    const admitted = DeploymentPublishInputV1Schema.parse(input);
    const receipt = { kind: 'started' as const, operationRef: { serverId: 'home', machineId: 'parent-host', operationId: 'workflow-parent' } };
    let dispatched: unknown;
    let createdHost = false;
    // The installed Workflow/Machine adapter is the process boundary. The real
    // schema, DF host admission, generic approval and semantic dispatcher run here.
    const deps = {
      prepareDeploymentPublish: async () => ({ input: admitted, preview: { summary: 'Reviewed publish' },
        host: { machines: [{ machineId: 'parent-host', online: true }], createdMachineIds: createdHost ? ['parent-host'] : [] } }),
      deploymentPublish: async (value: unknown) => { dispatched = value; return receipt; },
    } satisfies Pick<ActionExecutorDeps, 'prepareDeploymentPublish' | 'deploymentPublish'>;
    const executor = createActionExecutor(deps as ActionExecutorDeps);
    const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId: 'home', runtimeAccountId: 'account',
      actionCaller: { kind: 'host' as const } };
    expect(await executor.execute('deployments.publish', input, context)).toEqual({ ok: true, result: receipt });
    expect(dispatched).toEqual(input);
    createdHost = true;
    dispatched = undefined;
    expect(await executor.execute('deployments.publish', input, context)).toMatchObject({ ok: false, errorCode: 'machine_unavailable' });
    expect(dispatched).toBeUndefined();
    expect(await createActionExecutor({} as ActionExecutorDeps).execute('deployments.publish', input, context))
      .toMatchObject({ ok: false, errorCode: 'deployment_unavailable' });
  });

  it('hands off personal Prepare only through authenticated workspace context, without a child approval waiver', async () => {
    const input = { projectSourceId: 'source', sourceRevision: 1,
      repository: { kind: 'github', deployment: 'https://github.com', repository: 'owner/repo' },
      baseCommit: 'a'.repeat(40), workspace: { kind: 'workspace-ref', serverId: 'home', id: 'workspace' } };
    const spec = getActionSpec('deployments.prepare');
    expect(spec.inputSchema.parse(input)).toEqual(input);
    for (const invalid of [{ ...input, approved: true }, { ...input, serverId: 'home' },
      { ...input, workspace: { ...input.workspace, rootPath: '/actor/path' } }, { ...input, baseCommit: 'main' }]) {
      expect(spec.inputSchema.safeParse(invalid).success).toBe(false);
    }
    const result = { kind: 'handedOff' as const, sessionRef: { serverId: 'home', sessionId: 'proposal-session' } };
    let handedOff: unknown;
    const deps = {
      resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(async () => {
        throw new Error('Personal Prepare must not fetch an invented Environment.');
      }),
      // This is the authenticated target-daemon handoff boundary, not a Session/SCM implementation.
      deploymentPrepare: async (value: unknown) => { handedOff = value; return result; },
    } satisfies Pick<ActionExecutorDeps, 'resolveEnvironmentApprovalScope' | 'deploymentPrepare'>;
    const executor = createActionExecutor(deps as ActionExecutorDeps);
    const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId: 'home', runtimeAccountId: 'account',
      actionCaller: { kind: 'host' as const } };
    expect(await executor.execute('deployments.prepare', input, context)).toEqual({ ok: true, result });
    expect(handedOff).toEqual(input);
    handedOff = undefined;
    expect(await executor.execute('deployments.prepare', { ...input, workspace: { ...input.workspace, serverId: 'foreign' } }, context))
      .toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
    expect(handedOff).toBeUndefined();
    expect(await executor.execute('deployments.prepare', input, { ...context, runtimeAccountId: undefined }))
      .toMatchObject({ ok: false, errorCode: 'admission_unavailable' });
    expect(handedOff).toBeUndefined();
  });

  it('registers one reviewed Publish composition without a storage transport', () => {
    const spec = listActionSpecsForSurface('agent').find(row => String(row.id) === 'deployments.publish');
    expect(spec, 'P40 registers Publish; P60 composes through the existing Workflow owner').toBeDefined();
    if (!spec) return;
    expect(spec).toMatchObject({ safety: 'danger', sideEffectClass: 'write', executionPlacement: 'account',
      approvalPolicy: { uiConfirmation: 'direct' } });
    expect(spec.serverTransport).toBeUndefined();
    expect(spec.operation).toMatchObject({ version: 1, visibility: 'activity', progress: 'reported' });
    expect(resolveActionApprovalRouting({ actionId: spec.id, spec, context: { surface: 'agent' } }).required).toBe(true);
    expect(resolveActionApprovalRouting({ actionId: spec.id, spec, context: { surface: 'ui',
      authority: 'present_user', actionCaller: { kind: 'host' } } }).required).toBe(false);
    expect(spec.inputSchema.safeParse({ actions: [{ actionId: 'anything', input: {} }], approved: true }).success).toBe(false);
    for (const surface of ['ui', 'cli', 'agent', 'mcp'] as const) {
      expect(listActionSpecsForSurface(surface).filter(row => String(row.id) === 'deployments.publish')).toHaveLength(1);
    }
  });

  it('registers bounded native reads without a server-storage route or default approval', () => {
    const service = { kind: 'deployment', machineId: 'runtime', environmentId: 'staging',
      environmentInstanceId: 'instance', composeService: 'web', serviceId: 'instance/web' };
    const target = { serverId: 'home', environmentId: 'staging', deploymentId: 'active',
      targetLinkId: 'runtime-link', machineId: 'runtime', installationId: 'installed' };
    for (const [id, input] of [
      ['deployments.health.read', { ...target, service }],
      ['deployments.drift.read', { ...target, expectedRevision: 3, service }],
      ['deployments.logs.read', { ...target, kind: 'runtime', service,
        cursor: { sourceRevision: 'native-occurrence', token: 'native-cursor' } }],
    ] as const) {
      const spec = listActionSpecsForSurface('agent').find(row => String(row.id) === id);
      expect(spec, `${id} must be registered at the existing deployment read seam`).toBeDefined();
      if (!spec) continue;
      for (const surface of ['ui', 'cli', 'agent', 'mcp'] as const) {
        expect(listActionSpecsForSurface(surface).filter(row => String(row.id) === id)).toHaveLength(1);
      }
      expect(spec.inputSchema.parse(input)).toEqual(input);
      expect(spec.inputSchema.safeParse({ ...input, environmentId: 'other' }).success).toBe(false);
      expect(spec.inputSchema.safeParse({ ...input, repair: true }).success).toBe(false);
      expect(spec).toMatchObject({ safety: 'safe', sideEffectClass: 'read', approvalScope: 'environment',
        executionPlacement: 'account' });
      expect(spec.serverTransport).toBeUndefined();
      expect(spec.operation).toBeUndefined();
      expect(resolveActionApprovalRouting({ actionId: spec.id, spec, context: { surface: 'agent' } }).required).toBe(false);
      expect(spec.outputSchema.safeParse({ ok: false, error: 'deployment_unavailable' }).success).toBe(true);
    }
  });

  it('registers one strict controller setter through the existing storage transport and approval scope', () => {
    const id = 'deployments.environments.controller.set';
    const spec = listActionSpecsForSurface('agent').find(row => String(row.id) === id);
    expect(spec, 'controller reassignment must use the canonical Environment Action family').toBeDefined();
    if (!spec) return;
    for (const surface of ['ui', 'cli', 'agent', 'mcp'] as const) {
      expect(listActionSpecsForSurface(surface).filter(row => String(row.id) === id)).toHaveLength(1);
    }
    const input = { serverId: 'home', environmentId: 'staging', expectedRevision: 3, controllerMachineId: 'new-controller' };
    expect(spec.inputSchema.parse(input)).toEqual(input);
    for (const patch of [{ controllerMachineId: '' }, { expectedRevision: 0 },
      { contentArtifactId: 'actor-content' }, { patch: { buildMachineId: 'builder' } }, { machineResults: [] }]) {
      expect(spec.inputSchema.safeParse({ ...input, ...patch }).success).toBe(false);
    }
    expect(spec).toMatchObject({ executionPlacement: 'account', safety: 'danger', sideEffectClass: 'write',
      approvalScope: 'environment', approvalPolicy: { uiConfirmation: 'direct' } });
    expect(spec.operation).toBeUndefined();
    expect(resolveActionApprovalRouting({ actionId: spec.id, spec, context: { surface: 'agent' } }).required).toBe(true);
    expect(resolveActionApprovalRouting({ actionId: spec.id, spec,
      context: { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } }).required).toBe(false);
    expect(spec.serverTransport).toMatchObject({ method: 'POST', path: '/v1/deployments/environments/:environmentId/controller' });
    expect(bindHomeDomainHttpRequestV1({ transport: spec.serverTransport!, inputSchema: spec.inputSchema, input }))
      .toEqual({ method: 'POST', path: '/v1/deployments/environments/staging/controller', body: input });
    expect(spec.inputHints?.fields?.map(field => field.path)).toEqual(expect.arrayContaining(['expectedRevision', 'controllerMachineId']));
    expect(spec.inputHints?.fields?.some(field => field.path.startsWith('content'))).toBe(false);
  });

  it('registers one irreversible general teardown front door with no preview alias', () => {
    const spec = listActionSpecsForSurface('cli').find(candidate => String(candidate.id) === 'deployments.teardown');
    expect(spec, 'general teardown must use the canonical Action family').toBeDefined();
    expect(spec!.serverTransport?.path).toBe('/v1/deployments/environments/:environmentId/teardown');
    expect(spec!.irreversible).toBe(true);
    expect(listActionSpecsForSurface('cli').some(candidate => String(candidate.id) === 'deployments.previews.cleanup')).toBe(false);
  });
  it('retains the typed unavailable result when a requested deployment effect is unsupported', () => {
    expect(getActionSpec('deployments.rollback').outputSchema.safeParse({ ok: false, error: 'unsupported_action' }).success).toBe(true);
  });
  it('admits storage-only rollout cancellation without requiring content or a controller operation', async () => {
    const spec = listActionSpecsForSurface('agent').find(row => row.id === 'deployments.cancel');
    expect(spec, 'Stop this rollout must reach the canonical Action family while its controller is offline').toBeDefined();
    if (!spec) return;
    const input = { serverId: 'home', environmentId: 'production', deploymentId: 'running-rollout', expectedReceiptRevision: 4 };
    expect(spec.inputSchema.safeParse(input).success).toBe(true);
    expect(listActionSpecsForSurface('agent').filter(row => row.id === 'deployments.cancel')).toHaveLength(1);
    for (const patch of [{ contentArtifactId: 'actor-authored-member-facts' }, { contentHeaderVersion: 1 },
      { contentBodyVersion: 1 }, { content: { t: 'plain', v: { machineResults: [] } } }, { machineResults: [] }, { state: 'cancelled' }]) {
      expect(spec.inputSchema.safeParse({ ...input, ...patch }).success).toBe(false);
    }
    expect(spec.inputHints?.fields?.some(field => field.path.startsWith('content'))).toBe(false);
    expect(resolveActionApprovalRouting({ actionId: spec.id, spec, context: { surface: 'agent' } }).required).toBe(true);
    expect(spec.serverTransport?.path).toBe('/v1/deployments/environments/:environmentId/deployments/:deploymentId/transitions');
    const acknowledged = { ok: true as const, environmentId: 'production', revision: 7,
      deploymentId: 'running-rollout', deploymentRevision: 5, state: 'outcome_unknown' as const };
    // The authenticated HTTP/daemon transport is the system boundary here;
    // schema admission and present-person approval use their real owners.
    const executor = createActionExecutor({
      resolveEnvironmentApprovalScope: async () => ({ scope: { kind: 'environment', environmentId: 'production' } }),
      deploymentAction: async (id, admitted) => {
      expect(id).toBe('deployments.cancel');
      expect(admitted).toEqual(input);
      return acknowledged;
    } } as ActionExecutorDeps);
    expect(await executor.execute('deployments.cancel', input, { surface: 'ui', authority: 'present_user', serverId: 'home' }))
      .toEqual({ ok: true, result: acknowledged });
  });
  it('admits promotion only with the reviewed destination candidate and exact source receipt', () => {
    const spec = listActionSpecsForSurface('cli').find(candidate => candidate.id === 'deployments.promote');
    expect(spec, 'promotion must enter the canonical Action front door').toBeDefined();
    const input = { serverId: 'home', environmentId: 'production', expectedRevision: 4,
      targetLinkId: 'production-runtime', expectedTargetLinkRevision: 2, requestKey: 'promote-a',
      contentArtifactId: 'promoted-receipt', contentHeaderVersion: 1, contentBodyVersion: 1,
      sourceEnvironmentId: 'staging', sourceDeploymentId: 'receipt-a', sourceExpectedRevision: 3,
      sourceExpectedDeploymentRevision: 2, artifact: 'image', destinationContent: {
        contentArtifactId: 'production-candidate', contentHeaderVersion: 1, contentBodyVersion: 1 } };
    expect(spec!.inputSchema.parse(input)).toEqual(input);
    expect(spec!.inputSchema.safeParse({ ...input, destinationContent: undefined }).success).toBe(false);
    expect(spec!.inputSchema.safeParse({ ...input, artifact: 'automatic' }).success).toBe(false);
  });
  it('keeps an exact optional pre-migration backup selector on the one rollback Action', () => {
    const input = { serverId: 'home', environmentId: 'staging', expectedRevision: 1, requestKey: 'rollback-a',
      targetLinkId: 'runtime', expectedTargetLinkRevision: 1, deploymentId: 'receipt-a',
      contentArtifactId: 'candidate', contentHeaderVersion: 1, contentBodyVersion: 1 };
    const schema = getActionSpec('deployments.rollback').inputSchema;
    expect(schema.parse({ ...input, restoreBackupId: 'backup-before-migration' })).toEqual({ ...input,
      restoreBackupId: 'backup-before-migration' });
    expect(schema.parse(input)).toEqual(input);
    expect(schema.safeParse({ ...input, restoreBackupId: '' }).success).toBe(false);
  });
  it('registers one Prepare handoff with direct person consent and agent Ask', () => {
    // P60 must co-land the handoff producer before this planned id can join the union.
    const actionId = 'deployments.prepare' as Parameters<typeof getActionSpec>[0];
    const spec = getActionSpec(actionId);

    expect(spec.safety).toBe('danger');
    expect(spec.sideEffectClass).toBe('write');
    expect(spec.approvalPolicy?.uiConfirmation).toBe('direct');
    for (const surface of ['ui', 'agent', 'mcp', 'cli'] as const) {
      expect(listActionSpecsForSurface(surface).filter(candidate => candidate.id === actionId)).toHaveLength(1);
    }
    // Prepare reaches the target daemon through original Action dispatch;
    // Machine placement does not invent an unregistered raw RPC method.
    expect(spec.surfaces.rpc).toBe(false);
    expect(resolveActionApprovalRouting({ actionId, spec, context: { surface: 'ui',
      authority: 'present_user', actionCaller: { kind: 'host' } } }).required).toBe(false);
    expect(resolveActionApprovalRouting({ actionId, spec, context: { surface: 'agent' } }).required).toBe(true);
  });

  it('pins the same native review for an explicitly requested durable approval', async () => {
    const input = { serverId: 'home', environmentId: 'staging', expectedRevision: 1, requestKey: 'deploy-a',
      targetLinkId: 'runtime', expectedTargetLinkRevision: 1, contentArtifactId: 'candidate',
      contentHeaderVersion: 1, contentBodyVersion: 1 };
    const reviewed = { ...input, contentArtifactId: 'reviewed-candidate' };
    let persisted: unknown;
    // The durable Artifact writer is the system boundary; generic approval and
    // deployment preparation admission remain the real canonical owners.
    const executor = createActionExecutor({
      prepareDeploymentAction: async () => ({ input: reviewed, preview: { images: ['pinned-image'] } }),
      approvalsCreate: async ({ request }) => { persisted = request; return { artifactId: 'deployment-approval' }; },
    } as ActionExecutorDeps);
    expect(await executor.execute('approval.request.create', { actionId: 'deployments.deploy', actionArgs: input,
      summary: 'Deploy', createdBy: { surface: 'system' } }, { surface: 'ui', authority: 'present_user',
      serverId: 'home', serverIdentityId: 'home', runtimeAccountId: 'account', actionRequestId: 'explicit-deploy',
      actionCaller: { kind: 'host' } })).toMatchObject({ ok: true });
    expect(persisted).toMatchObject({ actionArgs: reviewed, preview: { deploymentReview: { images: ['pinned-image'] } } });
  });
  it('retains the installed host reviewed Artifact before effect admission', async () => {
    const input = { serverId: 'home', environmentId: 'staging', expectedRevision: 1, requestKey: 'deploy-a',
      targetLinkId: 'runtime', expectedTargetLinkRevision: 1, contentArtifactId: 'candidate',
      contentHeaderVersion: 1, contentBodyVersion: 1 };
    const reviewed = { ...input, contentArtifactId: 'reviewed-candidate' };
    let dispatched: unknown;
    // The installed host port crosses the native Docker/SCM and authenticated Artifact boundaries.
    const executor = createActionExecutor({
      prepareDeploymentAction: async request => {
        expect(request.input).toEqual(input);
        return { input: reviewed, preview: { summary: 'Deploy the reviewed image vector.' } };
      },
      resolveEnvironmentApprovalScope: async () => ({ scope: { kind: 'environment', environmentId: 'staging' } }),
      deploymentAction: async (_id, admitted) => {
        dispatched = admitted;
        return { ok: true, environmentId: 'staging', revision: 2,
          deploymentId: 'receipt-a', deploymentRevision: 2, state: 'succeeded' };
      },
    } as ActionExecutorDeps);
    expect(await executor.execute('deployments.deploy', input, { surface: 'ui', authority: 'present_user', serverId: 'home' }))
      .toMatchObject({ ok: true, result: { deploymentId: 'receipt-a' } });
    expect(dispatched).toEqual(reviewed);
  });
  // Activate with P41/P42's admitted candidate producer and its live finite-exec consumer.
  it('admits an exact receipt selector without caller-owned Environment context', () => {
    const receipt = getActionSpec('deployments.receipts.get');
    expect(receipt.inputSchema.safeParse({ serverId: 'home', deploymentId: 'candidate' }).success).toBe(true);
    expect(receipt.inputSchema.safeParse({ serverId: 'home', environmentId: 'staging', deploymentId: 'candidate' }).success).toBe(true);
    expect(receipt.inputSchema.safeParse({ serverId: 'home', deploymentId: 'candidate', projectSourceId: 'forged' }).success).toBe(false);
  });

  it('executes storage and deployment intents through the registered strict Action family', async () => {
    const artifacts = { contentArtifactId: 'private-content', contentHeaderVersion: 1, contentBodyVersion: 1 };
    const intent = { serverId: 'home', environmentId: 'staging', expectedRevision: 1, requestKey: 'deploy-a',
      targetLinkId: 'runtime', expectedTargetLinkRevision: 1, ...artifacts };
    const requests = [
      ['deployments.environments.create', { serverId: 'home', projectSourceId: 'source', requestKey: 'create',
        protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', controllerMachineId: 'guest', ...artifacts },
        { ok: true, environmentId: 'staging', revision: 1 }],
      ['deployments.environments.update', { serverId: 'home', environmentId: 'staging', expectedRevision: 1, ...artifacts },
        { ok: true, environmentId: 'staging', revision: 2 }],
      ['deployments.environments.controller.set', { serverId: 'home', environmentId: 'staging', expectedRevision: 1,
        controllerMachineId: 'new-controller' }, { ok: true, environmentId: 'staging', revision: 2 }],
      ['deployments.targets.link', { serverId: 'home', environmentId: 'staging', expectedRevision: 1, requestKey: 'link',
        role: 'runtime', targetId: 'own-server', machines: [{ machineId: 'guest', installationId: 'installation' }], ...artifacts },
        { ok: true, environmentId: 'staging', revision: 2, targetLinkId: 'runtime', targetLinkRevision: 1 }],
      ['deployments.deploy', intent, { ok: true, environmentId: 'staging', revision: 3,
        deploymentId: 'receipt-a', deploymentRevision: 2, state: 'succeeded' }],
      ['deployments.rollback', { ...intent, requestKey: 'rollback-a', deploymentId: 'receipt-a' },
        { ok: true, environmentId: 'staging', revision: 4, deploymentId: 'receipt-rollback', deploymentRevision: 2, state: 'succeeded' }],
    ] as const;
    // HTTP/daemon dispatch is this owner's genuine system boundary.
    const deps = { resolveEnvironmentApprovalScope: async () => ({ scope: { kind: 'environment' as const, environmentId: 'staging' } }),
      deploymentAction: async (id, input) => {
      const row = requests.find(row => row[0] === id);
      expect(input).toEqual(row?.[1]);
      return row![2];
    } } satisfies Pick<ActionExecutorDeps, 'deploymentAction' | 'resolveEnvironmentApprovalScope'>;
    const executor = createActionExecutor(deps as ActionExecutorDeps);
    for (const [id, input, expected] of requests) {
      const spec = getActionSpec(id);
      expect(resolveActionApprovalRouting({ actionId: id, spec, context: { surface: 'agent' } }).required).toBe(true);
      expect(listActionSpecsForSurface('cli').some(row => row.id === id)).toBe(true);
      expect(await executor.execute(id, input, { surface: 'ui', serverId: 'home',
        authority: 'present_user' })).toEqual({ ok: true, result: expected });
    }
  });
});
