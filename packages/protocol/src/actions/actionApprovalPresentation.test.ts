import { describe, expect, it } from 'vitest';

import { describeApprovalActionFields, projectApprovalExecutionForObservation, projectApprovalRequestForPublicRead, projectTargetActionApprovalInput, resolveApprovalRequestApproveAdmission, resolveApprovalVisualPreview } from './actionApprovalPresentation.js';
import { ApprovalRequestV1Schema, ApprovalRequestV2Schema, type ApprovalRequestV2 } from '../approvals/approvalRequestV1.js';
import { ActionOperationCredentialUseV1Schema } from './actionExecutionResult.js';
import { ActionSpecSchema, getActionSpec } from './actionSpecs.js';
import { readActionSchemaTopLevelFieldNames } from './actionCliProjection.js';
import { MACHINE_PRESET_ACTION_IDS_V1 } from '../machines/managed/machinePresetActionIdsV1.js';
import { MANAGED_MACHINE_ACTION_IDS_V1 } from '../machines/managed/actionIdsV1.js';
import { MACHINE_POOL_ACTION_IDS_V1 } from '../machines/pools/actionsV1.js';
import { readBuiltInSettingDeclarationV1 } from './settings/settingsDeclarations.js';
import { skillFileFromBytesV1 } from '../prompts/library/skills/skillZipV1.js';
import type { ActionId } from './actionIds.js';
import { decideApprovalRequestTransition, settleApprovalRequestActionArgs } from '../approvals/approvalRequestTransition.js';
import { describeApprovalRequestFields } from './actionApprovalPresentation.js';
import { createPluginInstallationReviewFixture } from '../testing/pluginInstallationReviewFixture.js';
import { TargetActionApprovalRequestV1Schema } from '../approvals/targetActionApprovalRequestV1.js';
import { TriageStartEntrySessionInputV1Schema } from '../../../plugins/triage/src/actions/entrySessionProtocol.js';
import { createTriageSelectedPrStartApprovalInput } from '../../../plugins/triage/src/sessions/testkit/entrySessionTestkit.test-support.js';
import { SharedSavedSecretRefV1Schema } from '../machines/managed/providerFactsV1.js';
import { computeWorkspaceSyncPolicyDigest } from '../sessions/control/handoff/workspaceSyncSchemas.js';

describe('approval field presentation', () => {
  it.each(['open', 'executed'] as const)('withholds private replay authority from %s built-in and target Ask observations', status => {
    const actionId = 'machines.managed.delete';
    const target = { kind: 'machine' as const, machineId: 'controller' };
    const executionOriginV1 = {
      v: 1, authority: 'account_automation', surface: 'cli', caller: { kind: 'host' },
      serverId: 'home', serverIdentityId: 'srv_home', accountId: 'owner', machineId: 'controller',
      actionId, requestId: 'delete-request', target,
      externalActionInputSignature: 'a'.repeat(86),
      externalActionExecutionAuthorization: { v: 1, token: 'synthetic-scoped-authorization', binding: {
        serverIdentityId: 'srv_home', accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 },
        machineId: 'controller', custodianAccountId: 'owner', installationId: 'installation',
        actionId, requestId: 'delete-request', requestEnvelopeDigest: 'a'.repeat(43), target,
      } },
    };
    const base = {
      status, createdAtMs: 1, updatedAtMs: status === 'open' ? 1 : 3,
      createdBy: { surface: 'cli' }, requestedSurface: 'cli', summary: 'Delete machine', executionOriginV1,
      ...(status === 'executed' ? { decision: { kind: 'approve', decidedAtMs: 2 },
        execution: { executedAtMs: 3, ok: true, effectAttempted: true, result: { kind: 'accepted' } } } : {}),
    };
    const builtIn = ApprovalRequestV2Schema.parse({ ...base, v: 2, actionId,
      actionArgs: { homeId: 'home', managedId: 'managed', when: 'now', expectedRevision: 2,
        intent: 'delete', reviewedDependencies: true } });
    const plugin = TargetActionApprovalRequestV1Schema.parse({ ...base, v: 1, kind: 'plugin_target_action',
      qualifiedActionId: 'example.machine/actions/delete',
      executionOriginV1: { ...executionOriginV1, actionId: 'action.invoke',
        externalActionExecutionAuthorization: { ...executionOriginV1.externalActionExecutionAuthorization,
          binding: { ...executionOriginV1.externalActionExecutionAuthorization.binding, actionId: 'action.invoke' } } },
      sourceCustody: { kind: 'development', registeredRootId: 'machine-root' },
      policyFingerprint: 'a'.repeat(64), subjectFingerprint: 'b'.repeat(64),
      input: { managedId: 'managed' }, secretInputPaths: [],
    });
    for (const request of [builtIn, plugin]) {
      const publicRead = projectApprovalRequestForPublicRead(request);
      expect(publicRead).toMatchObject({ status, summary: 'Delete machine',
        executionOriginV1: { requestId: 'delete-request', target } });
      const serialized = JSON.stringify(publicRead);
      expect(serialized).not.toContain('externalActionExecutionAuthorization');
      expect(serialized).not.toContain('externalActionInputSignature');
      expect(serialized).not.toContain('synthetic-scoped-authorization');
      expect(request.executionOriginV1).toHaveProperty('externalActionExecutionAuthorization');
      expect(request.executionOriginV1).toHaveProperty('externalActionInputSignature');
    }
  });
  it.each([
    ['machines.managed.power.set', 'now', 'stop', 'Stop'],
    ['machines.managed.delete', 'after-idle', 'delete', 'Delete'],
  ] as const)('carries declared option label keys into %s review without rewriting its operands', (actionId, when, intent, label) => {
    const actionArgs = { homeId: 'srv_home', managedId: 'managed-guest', intent, when,
      ...(when === 'now' ? { expectedRevision: 3 } : {}), ...(intent === 'delete' ? { reviewedDependencies: true } : {}) };
    const presentation = describeApprovalActionFields({ actionId, actionArgs });
    expect(presentation.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'when', value: when === 'now' ? 'Now' : 'After idle',
        selectedOptions: [{ label: when === 'now' ? 'Now' : 'After idle', labelKey: `actionPresentation.options.${when === 'now' ? 'now' : 'afterIdle'}` }] }),
      expect.objectContaining({ path: 'intent', value: label, selectedOptions: [{ label, labelKey: `actionPresentation.options.${intent}` }] }),
    ]));
    expect(actionArgs.when).toBe(when);
    expect(actionArgs.intent).toBe(intent);
  });
  it('names a managed Start target with its own Home-qualified reference without changing approved operands', () => {
    const actionArgs = { homeId: 'srv_home', managedId: 'managed-guest', intent: 'start', when: 'now', expectedRevision: 1 };
    const presentation = describeApprovalActionFields({ actionId: 'machines.managed.power.set', actionArgs });
    expect(presentation.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'managedId', reference: { kind: 'managedMachine', id: 'managed-guest', homeId: 'srv_home' } }),
    ]));
    expect(actionArgs).toEqual({ homeId: 'srv_home', managedId: 'managed-guest', intent: 'start', when: 'now', expectedRevision: 1 });
  });
  it('reads a managed review Home by its name and keeps its concurrency revision in Technical details', () => {
    const presentation = describeApprovalActionFields({ actionId: 'machines.managed.power.set',
      actionArgs: { homeId: 'srv_home', managedId: 'managed-guest', intent: 'stop', when: 'now', expectedRevision: 3 } });
    expect(presentation.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'homeId', reference: { kind: 'home', id: 'srv_home' } }),
      expect.objectContaining({ path: 'expectedRevision', technical: true }),
    ]));
    expect(presentation.rows.find(row => row.kind === 'value' && row.path === 'intent')).not.toHaveProperty('technical');
  });
  it('preserves the V2 pre-effect fact in the public terminal receipt', () => {
    const request = ApprovalRequestV2Schema.parse({
      v: 2,
      status: 'failed',
      createdAtMs: 1,
      updatedAtMs: 3,
      createdBy: { surface: 'cli' },
      actionId: 'session.list',
      actionArgs: {},
      summary: 'List sessions',
      executionOriginV1: {
        v: 1,
        authority: 'account_automation',
        caller: { kind: 'host' },
        requestId: 'request-a',
        surface: 'cli',
        serverId: 'home',
        actionId: 'session.list',
      },
      decision: { kind: 'approve', decidedAtMs: 2 },
      execution: {
        executedAtMs: 3,
        effectAttempted: false,
        ok: false,
        errorCode: 'approval_context_unavailable',
        error: 'approval_context_unavailable',
      },
    });

    expect(projectApprovalExecutionForObservation(request)).toMatchObject({ effectAttempted: false });
  });

  it('preserves admitted current target receipt metadata without disclosing legacy V1 actor claims', () => {
    const use = ActionOperationCredentialUseV1Schema.parse({
      v: 1, kind: 'connected_account', label: 'Release GitHub', owner: { kind: 'account', accountId: 'alice' },
      service: { pluginId: 'acme.github', localId: 'github' },
      why: { kind: 'purpose_binding', purpose: { consumer: { pluginId: 'acme.alpha', localId: 'run' }, purpose: 'write' }, target: 'account' },
      currentness: { kind: 'current_at_materialization' },
    });
    const execution = { executedAtMs: 3, ok: true, effectAttempted: true, result: { ok: true }, operationCredentialUses: [use] };
    const target = TargetActionApprovalRequestV1Schema.parse({
      v: 1, kind: 'plugin_target_action', status: 'executed', createdAtMs: 1, updatedAtMs: 3,
      createdBy: { surface: 'cli' }, requestedSurface: 'cli', qualifiedActionId: 'acme.alpha/actions/run',
      input: { value: 'x' }, secretInputPaths: [], sourceCustody: { kind: 'development', registeredRootId: 'root-7' },
      policyFingerprint: 'b'.repeat(64), subjectFingerprint: 'a'.repeat(64), summary: 'Run',
      decision: { kind: 'approve', decidedAtMs: 2 }, execution,
    });
    expect(projectApprovalRequestForPublicRead(target)).toMatchObject({ execution });
    expect(projectApprovalExecutionForObservation({ ...target, execution: { ...execution, details: { message: 'private-plugin-detail' } } }))
      .not.toHaveProperty('details');
    const notAttempted = TargetActionApprovalRequestV1Schema.parse({ ...target, status: 'failed',
      execution: { executedAtMs: 3, ok: false, effectAttempted: false, errorCode: 'approval_stale', error: 'approval_stale' },
    });
    expect(projectApprovalRequestForPublicRead(notAttempted)).toMatchObject({ execution: notAttempted.execution });

    const legacy = ApprovalRequestV1Schema.parse({
      v: 1, status: 'executed', createdAtMs: 1, updatedAtMs: 3, createdBy: { surface: 'cli' },
      actionId: 'session.list', actionArgs: {}, summary: 'List sessions',
      decision: { kind: 'approve', decidedAtMs: 2 }, execution,
      kind: 'plugin_target_action',
    });
    expect(projectApprovalExecutionForObservation(legacy)).toEqual({ executedAtMs: 3, ok: true, result: { ok: true } });
    expect(projectApprovalRequestForPublicRead(legacy)).toMatchObject({
      execution: { executedAtMs: 3, ok: true, result: { ok: true } },
    });
    expect(projectApprovalExecutionForObservation(legacy)).not.toHaveProperty('operationCredentialUses');
  });

  it('projects document references for every Artifact operation with an artifactId', () => {
    const spec = getActionSpec('artifact.public_link.create');
    const actionArgs = spec.inputSchema.parse({ artifactId: 'release-notes' });
    const presentation = describeApprovalActionFields({ actionId: spec.id, actionArgs });
    expect(presentation.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'value', path: 'artifactId', reference: { kind: 'artifact', id: 'release-notes' } }),
    ]));
  });
  it('discloses nested confidential operands by declared label and preserves exact public JSON', () => {
    const input = { rows: [{ releaseTag: 'private-release', target: ' endpoint ', enabled: false, count: 42,
      credential: { _isSecretValue: true, value: 'private-carrier' } }], token: 'public-routing-token' };
    const secretInputPaths = ['rows.[].releaseTag'];
    const projection = projectTargetActionApprovalInput(input, secretInputPaths);
    expect(projection).not.toBeNull();
    const request = TargetActionApprovalRequestV1Schema.parse(JSON.parse(JSON.stringify({
      v: 1, kind: 'plugin_target_action', status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'agent' }, requestedSurface: 'agent', qualifiedActionId: 'acme.publisher/actions/publish',
      sourceCustody: { kind: 'development', registeredRootId: 'publisher-root' },
      policyFingerprint: 'a'.repeat(64), subjectFingerprint: 'b'.repeat(64), summary: 'Publish',
      input: projection!.input, secretInputPaths, secretInputLabels: { 'rows.[].releaseTag': 'Release credential' },
      approvalInputCustody: 'live_only',
    })));
    expect(JSON.stringify(request)).not.toContain('private');
    const admission = resolveApprovalRequestApproveAdmission(request);
    expect(admission).toMatchObject({ status: 'available', presentation: { rows: expect.arrayContaining([
      { kind: 'value', path: 'input.rows.0.releaseTag', title: 'Release credential', value: '', valueFormat: 'confidential' },
      { kind: 'value', path: 'input.token', title: 'Token', value: '"public-routing-token"' },
      expect.objectContaining({ path: 'input.rows', value: JSON.stringify([{ releaseTag: '[REDACTED]',
        target: ' endpoint ', enabled: false, count: 42, credential: { _isSecretValue: true } }]) }),
    ]) } });
    expect(JSON.stringify(admission)).not.toContain('private');
  });

  it('marks a destructive Session target for expanded identity presentation', () => {
    expect(describeApprovalActionFields({
      actionId: 'session.delete',
      actionArgs: { sessionId: 'cmv9jgd3q016xmcvegf6icb89' },
    }).rows).toContainEqual(expect.objectContaining({
      path: 'sessionId',
      reference: {
        kind: 'session',
        id: 'cmv9jgd3q016xmcvegf6icb89',
        presentation: 'destructive_target',
      },
    }));
  });

  it.each([
    ['attach', 'new-manager', null],
    ['replace', 'new-manager', 'previous-manager'],
    ['detach', null, 'previous-manager'],
  ] as const)('names every Session operand in a manager %s review without changing null or exact input', (_operation, managerSessionId, expectedManagerSessionId) => {
    const spec = getActionSpec('session.manager.set');
    const actionArgs = spec.inputSchema.parse({ sessionId: 'managed-session', managerSessionId, expectedManagerSessionId });
    const presentation = describeApprovalActionFields({ actionId: spec.id, actionArgs });

    expect(presentation.unrepresentable).toBeNull();
    for (const [path, id] of Object.entries(actionArgs)) {
      if (id === null) {
        expect(presentation.rows.some(row => row.path === path)).toBe(false);
      } else {
        expect(presentation.rows).toContainEqual(expect.objectContaining({
          kind: 'value', path, value: id, reference: { kind: 'session', id },
        }));
      }
    }
    expect(actionArgs).toEqual({ sessionId: 'managed-session', managerSessionId, expectedManagerSessionId });
  });

  it('discloses and admits the real Triage selected-PR credential identity', () => {
    const input = createTriageSelectedPrStartApprovalInput();
    const presentation = describeApprovalRequestFields({
      kind: 'plugin_target_action', input, secretInputPaths: [],
    });
    expect(presentation.unrepresentable).toBeNull();
    expect(presentation.rows).toContainEqual(expect.objectContaining({
      path: 'input.prepareReviewWorkspaceSelection', value: JSON.stringify(input.prepareReviewWorkspaceSelection),
    }));
    // The live declaration, rather than a guessed field name, owns the binding.
    expect(TriageStartEntrySessionInputV1Schema.safeParse(input).success).toBe(true);
  });

  it.each([
    { input: { releaseTag: 'private-effect', benign: null }, secretInputPaths: ['releaseTag'] },
    { input: { credentials: { repository: '/private/effect' }, benign: {} }, secretInputPaths: ['credentials'] },
    { input: { target: { _isSecretValue: true, value: 'private-effect' }, benign: false }, secretInputPaths: [] },
    { input: { rows: [{ target: 'private-effect', enabled: true }] }, secretInputPaths: ['rows.[].target'] },
  ])('withholds plugin approval when an operand is redacted despite readable input: $input', ({ input, secretInputPaths }) => {
    const request = TargetActionApprovalRequestV1Schema.parse({
      v: 1, kind: 'plugin_target_action', status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'agent' }, requestedSurface: 'agent', qualifiedActionId: 'acme.publisher/actions/publish',
      sourceCustody: { kind: 'development', registeredRootId: 'publisher-root' },
      policyFingerprint: 'a'.repeat(64), subjectFingerprint: 'b'.repeat(64), summary: 'Publish',
      input, secretInputPaths,
    });
    const admission = resolveApprovalRequestApproveAdmission(request);
    expect(JSON.stringify(admission.presentation)).not.toContain('private');
    expect(admission).toMatchObject({ status: 'unavailable', reason: 'context_unavailable' });
  });

  it('discloses Saved Secret identity and every effect operand regardless of diagnostic key spelling', () => {
    const input = { savedSecret: SharedSavedSecretRefV1Schema.parse({ kind: 'shared_resource', resourceId: 'saved-key-1' }),
      credentials: { repository: '/work/effect' }, token: 'source-routing-token' };
    const presentation = describeApprovalRequestFields({ kind: 'plugin_target_action', input, secretInputPaths: [] });
    expect(presentation.unrepresentable).toBeNull();
    for (const [key, value] of Object.entries(input)) {
      expect(presentation.rows).toContainEqual(expect.objectContaining({ path: `input.${key}`, value: JSON.stringify(value) }));
    }
  });

  it.each([
    ['null', null], ['false', false], ['42', 42], ['{"target":"release"}', { target: 'release' }],
    ['[1,2]', [1, 2]], ['', ' '],
  ])('preserves plugin operand type and exact JSON identity for %j versus %j', (left, right) => {
    const present = (value: unknown) => describeApprovalRequestFields({
      kind: 'plugin_target_action', input: { value }, secretInputPaths: [],
    });
    const first = present(left);
    const second = present(right);
    expect(first.unrepresentable).toBeNull();
    expect(second.unrepresentable).toBeNull();
    expect(first.rows).not.toEqual(second.rows);
    for (const [value, presentation] of [[left, first], [right, second]] as const) {
      expect(presentation.rows).toContainEqual(expect.objectContaining({ path: 'input.value', value: JSON.stringify(value) }));
    }
  });

  it('discloses the exact plugin arguments and redacts credentials through the shared approval owner', () => {
    const base = TargetActionApprovalRequestV1Schema.parse({
      v: 1, kind: 'plugin_target_action', status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'agent' }, requestedSurface: 'agent',
      qualifiedActionId: 'acme.publisher/actions/releases/publish',
      sourceCustody: { kind: 'development', registeredRootId: 'publisher-root' },
      policyFingerprint: 'a'.repeat(64), subjectFingerprint: 'b'.repeat(64), summary: 'Publish release',
      input: { repository: '/work/release', releaseTag: ' v1.2.3 ',
        arguments: ['--publish', { dryRun: false, count: 0, optional: null }],
        secretToken: 'private-token', credentials: { password: 'private-password' },
        opaque: { value: 'private-declared' },
        rows: [{ value: 'private-array', target: 'public-target' }],
        saved: { _isSecretValue: true, value: 'private-carrier' } },
    });
    const request = { ...base, secretInputPaths: ['secretToken', 'credentials', 'opaque.value', 'rows.[].value'] };
    expect(TargetActionApprovalRequestV1Schema.parse(request).secretInputPaths).toEqual(request.secretInputPaths);
    const admission = resolveApprovalRequestApproveAdmission(request);
    expect(admission.status).toBe('unavailable');
    expect(admission.presentation.rows).toContainEqual(expect.objectContaining({ path: 'input.releaseTag', value: JSON.stringify(' v1.2.3 ') }));
    const presentation = JSON.stringify(admission.presentation);
    expect(presentation).toContain('/work/release');
    expect(presentation).toContain('--publish');
    expect(presentation).toContain('false');
    expect(presentation).not.toContain('private-token');
    expect(presentation).not.toContain('private-password');
    expect(presentation).not.toContain('private-carrier');
    expect(presentation).not.toContain('private-declared');
    expect(presentation).not.toContain('private-array');
    expect(presentation).toContain('public-target');
    expect(resolveApprovalRequestApproveAdmission(base)).toMatchObject({ status: 'unavailable', reason: 'context_unavailable' });
    expect(resolveApprovalRequestApproveAdmission({ ...request, input: { _isSecretValue: true, value: 'private' } }))
      .toMatchObject({ status: 'unavailable', reason: 'context_unavailable' });
    expect(describeApprovalRequestFields({ ...request, input: { unexpected: undefined } }).unrepresentable)
      .not.toBeNull();
  });

  it.each([undefined, 'own-trigger'])('admits an ordinary Automation pause review with trigger %s', (triggerId) => {
    const actionId = 'workflow.trigger.update' as const;
    const actionArgs = getActionSpec(actionId).inputSchema.parse({
      automationId: 'bd7da11a-909b-497a-98de-b878cd2d0e24', expectedRevision: 1,
      ...(triggerId ? { triggerId } : {}), patch: { enabled: false },
    });
    const request = ApprovalRequestV2Schema.parse({
      v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1, createdBy: { surface: 'cli' },
      actionId, actionArgs, preview: { actionId, actionArgs }, summary: 'Pause own Automation',
      executionOriginV1: { v: 1, authority: 'account_automation', caller: { kind: 'host' },
        requestId: 'own-pause-request', surface: 'cli', serverId: 'home', actionId },
    });
    const admission = resolveApprovalRequestApproveAdmission(request);
    expect(admission.status).toBe('available');
    expect(admission.presentation.rows).toContainEqual(expect.objectContaining({
      path: 'patch', value: JSON.stringify({ enabled: false }),
    }));
    expect(admission.presentation.rows).toContainEqual(expect.objectContaining({
      path: 'automationId', value: actionArgs.automationId,
    }));
    if (triggerId) expect(admission.presentation.rows).toContainEqual(expect.objectContaining({
      path: 'triggerId', value: triggerId,
    }));
  });

  it('admits plugin install approval only with the daemon-evaluated install disclosure', () => {
    const actionArgs = { path: '/plugins/acme.example', kind: 'path' as const };
    const base = ApprovalRequestV2Schema.parse({
      v: 2,
      status: 'open',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'agent' },
      actionId: 'plugins.install',
      actionArgs,
      summary: 'Install plugin',
      executionOriginV1: {
        v: 1,
        authority: 'account_automation',
        caller: { kind: 'host' },
        requestId: 'plugin-install-request',
        surface: 'agent',
        serverId: 'home',
        actionId: 'plugins.install',
      },
    });

    expect(resolveApprovalRequestApproveAdmission({
      ...base,
      preview: {
        actionId: 'plugins.install',
        actionArgs,
        pluginInstall: { permissionsDisclosure: 'pendingDaemonEvaluation' },
      },
    })).toMatchObject({
      status: 'unavailable',
      reason: 'context_unavailable',
      details: { path: 'preview.pluginInstall.pendingReview' },
    });

    const review = createPluginInstallationReviewFixture({
      requiredHostAccess: [{
        id: 'network',
        capability: 'network',
        reason: 'Call the service.',
        authorizationClass: 'cooperativeDisclosure',
        normalizedScope: { targets: [{ kind: 'fixedOrigin', origin: 'https://example.test' }] },
      }],
    });
    const admission = resolveApprovalRequestApproveAdmission({
      ...base,
      preview: {
        actionId: 'plugins.install',
        actionArgs,
        pluginInstall: {
          permissionsDisclosure: 'daemonEvaluated',
          pendingReview: {
            kind: 'reviewRequired',
            reviewKind: 'installation',
            pendingChangeId: 'pending-plugin-install',
            reason: 'firstInstall',
            currentVersion: null,
            authorityExpansion: [],
            review,
          },
        },
      },
    });

    expect(admission).toMatchObject({ status: 'available' });
    expect(admission.presentation.rows).toContainEqual(expect.objectContaining({
      path: 'preview.pluginInstall.pendingReview.review',
      title: 'Daemon-evaluated install and trust disclosure',
      entries: expect.arrayContaining([
        expect.objectContaining({ label: 'Plugin id', value: 'acme.example' }),
        expect.objectContaining({ label: 'Required host access', value: null }),
        expect.objectContaining({ label: 'Capability', value: 'network' }),
      ]),
    }));
  });

  it('admits the neighboring capabilities families without disclosing live-only secret values', () => {
    const entry = { id: 'mcp-a', name: 'mcp-a', transport: 'stdio', stdio: { command: 'mcp-tool', args: [] }, env: {}, createdAt: 1, updatedAt: 1 };
    const file = skillFileFromBytesV1('SKILL.md', new TextEncoder().encode('---\nname: review\n---\nReview.'), 0o644);
    const cases: readonly (readonly [ActionId, unknown])[] = [
      ['skills.create', { name: 'review', files: [file] }],
      ['skills.update', { skillId: 'skill-a', expectedRevision: '1:1', files: [] }],
      ['skills.duplicate', { skillId: 'skill-a' }], ['skills.delete', { skillId: 'skill-a', expectedRevision: '1:1' }],
      ['skills.install', { source: { kind: 'upload', files: [file] } }],
      ['skills.found.adopt', { machineId: 'machine-a', items: [{ name: 'review', path: '/skills/review' }] }],
      ['skills.export', { skillIds: ['skill-a'] }], ['skills.updates.apply', { skillId: 'skill-a', expectedRevision: '1:1', choices: {} }],
      ['skills.machine.install', { machineId: 'machine-a', skillId: 'skill-a' }],
      ['skills.machine.uninstall', { machineId: 'machine-a', skillId: 'skill-a' }],
      ['mcp.servers.tools.set', { serverId: 'mcp-a', tools: { search: 'ask' } }],
      ['mcp.servers.create', { entry, expectedRevision: 1 }], ['mcp.servers.create', { entries: [{ entry }], expectedRevision: 1 }],
      ['mcp.servers.update', { entry, expectedRevision: 1 }],
      ['mcp.servers.duplicate', { serverId: 'mcp-a' }],
      ['mcp.servers.delete', { serverId: 'mcp-a', expectedRevision: 1, removeBindings: true }],
      ['mcp.servers.import', { source: { kind: 'paste', text: '{}' }, dryRun: true }],
      ['mcp.found.adopt', { machineId: 'machine-a', items: [] }],
      ['mcp.servers.signIn.start', { serverId: 'mcp-a', stepUp: true }],
      ['registries.sources.create', { url: 'https://example.test/registry.json' }],
      ['registries.sources.update', { sourceId: 'source-a', enabled: false }],
      ['registries.sources.token.set', { sourceId: 'source-a', token: null }],
      ['registries.sources.delete', { sourceId: 'source-a' }],
      ['secrets.create', { name: 'Private', value: 'private-secret-sentinel' }],
      ['secrets.update', { secretId: 'secret-a', value: 'private-secret-sentinel', expectedUpdatedAt: 1 }],
      ['secrets.delete', { secretId: 'secret-a', expectedUpdatedAt: 1 }],
      ['agents.acp.backends.get', { backendId: 'agent-a' }],
      ['agents.acp.backends.delete', { backendId: 'agent-a' }],
      ['agents.acp.backends.installFromRegistry', { fromRegistry: { sourceId: 'source-a', itemId: 'agent-a', version: '1.0.0' }, installOn: ['machine-a'] }],
    ];
    const failures: unknown[] = [];
    for (const [actionId, raw] of cases) {
      const spec = getActionSpec(actionId);
      const admitted = spec.inputSchema.parse(raw);
      const observed = spec.projectObservationInput?.(admitted) ?? admitted;
      const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
        createdBy: { surface: 'cli' }, actionId, actionArgs: spec.approvalInputCustody === 'live_only' ? observed : admitted,
        preview: { actionId, actionArgs: spec.approvalInputCustody === 'live_only' && spec.approvalPresentation?.inputSchema
          ? spec.approvalPresentation.projectInput?.(admitted) : observed }, summary: spec.title,
        executionOriginV1: { v: 1, authority: 'account_automation', caller: { kind: 'host' }, requestId: 'neighbor-request',
          surface: 'cli', serverId: 'home', actionId } });
      const admission = resolveApprovalRequestApproveAdmission(request);
      if (admission.status !== 'available') failures.push({ actionId, admission });
      expect(JSON.stringify(admission.presentation), actionId).not.toContain('private-secret-sentinel');
      expect(JSON.stringify(settleApprovalRequestActionArgs(request)), actionId).not.toContain('private-secret-sentinel');
      if (actionId === 'registries.sources.create') expect(admission.presentation.rows).toContainEqual(
        expect.objectContaining({ title: 'Address', value: 'https://example.test/registry.json' }));
      if (actionId === 'registries.sources.delete') expect(admission.presentation.rows).toContainEqual(
        expect.objectContaining({ title: 'Registry', reference: { kind: 'registrySource', id: 'source-a' } }));
    }
    expect(failures).toEqual([]);
  });
  it.each([
    { kind: 'command', command: 'coding-agent', args: [] },
    { kind: 'npm', package: 'coding-agent', version: '1.0.0', args: [] },
    { kind: 'uv', package: 'coding-agent', version: '1.0.0', command: 'coding-agent', args: [] },
    { kind: 'archive', version: '1.0.0', assetsByPlatform: { 'linux-x64': { archiveUrl: 'https://example.test/agent.tar.gz', executableSubpath: 'agent' } }, args: [] },
  ])('admits the actual $kind Agent launch rather than requiring a command-only operand', launch => {
    const spec = getActionSpec('agents.acp.backends.upsert');
    const actionArgs = spec.inputSchema.parse({ backend: { id: 'review-agent', name: 'review-agent', title: 'Review agent', launch } });
    const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'cli' }, actionId: spec.id, actionArgs, summary: spec.title,
      executionOriginV1: { v: 1, authority: 'account_automation', caller: { kind: 'host' }, requestId: 'agent-request',
        surface: 'cli', serverId: 'home', actionId: spec.id } });
    const admission = resolveApprovalRequestApproveAdmission(request);
    expect(admission).toMatchObject({ status: 'available' });
    expect(JSON.stringify(admission.presentation.rows)).toContain(launch.kind);
    expect(admission.presentation.rows).toContainEqual(expect.objectContaining({ path: 'backend.id', technical: true }));
    expect(admission.presentation.rows).toContainEqual(expect.objectContaining({ title: 'Agent', value: 'Review agent' }));
    expect(admission.presentation.rows).toContainEqual(expect.objectContaining({ title: 'Launch', entries: expect.arrayContaining([
      expect.objectContaining({ label: 'Method' }),
    ]) }));
  });
  it.each([['skill', 'skill'], ['mcp_server', 'mcpServer']] as const)('names the %s an Agent asks to turn on for its session, not its id', (kind, referenceKind) => {
    const fields = describeApprovalActionFields({ actionId: 'session.capabilities.set',
      actionArgs: { sessionId: 'session-a', kind, id: 'item-a', state: 'on', reason: 'Link the fix' } });
    expect(fields.rows).toContainEqual(expect.objectContaining({ path: 'id', reference: { kind: referenceKind, id: 'item-a' } }));
    expect(describeApprovalActionFields({ actionId: 'session.capabilities.set',
      actionArgs: { sessionId: 'session-a', kind: 'native_skill', id: 'pdf', state: 'on' } }).rows)
      .toContainEqual(expect.objectContaining({ path: 'id', value: 'pdf' }));
    expect(describeApprovalActionFields({ actionId: 'session.capabilities.set',
      actionArgs: { sessionId: 'session-a', kind: 'native_skill', id: 'pdf', state: 'on' } }).rows.find(row => row.path === 'id'))
      .not.toHaveProperty('reference');
  });
  it.each(['skills.rules.set', 'mcp.rules.set'] as const)('admits %s with the exact reviewed items and Machine change', actionId => {
    const spec = getActionSpec(actionId);
    const actionArgs = spec.inputSchema.parse({ items: [actionId === 'skills.rules.set' ? { skillId: 'skill-a' } : { serverId: 'mcp-a' }],
      change: { kind: 'write', write: { place: { t: 'machine', machineId: 'machine-a' }, state: 'on' } } });
    const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'cli' }, requestedSurface: 'cli', actionId, actionArgs, summary: spec.title,
      preview: { actionId, actionArgs: spec.projectObservationInput?.(actionArgs) },
      executionOriginV1: { v: 1, authority: 'account_automation', caller: { kind: 'host' }, requestId: 'rules-request',
        surface: 'cli', serverId: 'home', actionId } });
    const admission = resolveApprovalRequestApproveAdmission(request);
    expect(admission).toMatchObject({ status: 'available' });
    const executing = ApprovalRequestV2Schema.parse({ ...request, status: 'executing',
      decision: { kind: 'approve', decidedAtMs: 2 }, updatedAtMs: 2 });
    const settled = ApprovalRequestV2Schema.parse({ ...executing, status: 'executed', updatedAtMs: 3,
      actionArgs: settleApprovalRequestActionArgs(executing), execution: { executedAtMs: 3, ok: true } });
    expect(decideApprovalRequestTransition(executing, settled)).toEqual({ ok: true, changed: true });
    expect(describeApprovalRequestFields(settled)).toEqual(admission.presentation);
    expect(settleApprovalRequestActionArgs(settled)).toEqual(actionArgs);
    expect(admission.presentation.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: actionId === 'skills.rules.set' ? 'Skill' : 'MCP server', reference: {
        kind: actionId === 'skills.rules.set' ? 'skill' : 'mcpServer', id: actionId === 'skills.rules.set' ? 'skill-a' : 'mcp-a' } }),
      expect.objectContaining({ title: 'Where', reference: { kind: 'machine', id: 'machine-a' } }),
      expect.objectContaining({ title: 'Change', value: 'Turn on' }),
    ]));
    expect(resolveApprovalRequestApproveAdmission({ ...request, actionArgs: { items: actionArgs.items } }))
      .toMatchObject({ status: 'unavailable', reason: 'context_unavailable' });
    expect(() => settleApprovalRequestActionArgs({ ...request, actionArgs: { items: actionArgs.items } })).not.toThrow();
    for (const [state, label] of [['off', 'Turn off'], ['inherit', 'Use inherited rules']] as const) {
      const input = spec.inputSchema.parse({ items: actionArgs.items, change: {
        kind: 'write', write: { place: { t: 'allMachines' }, state },
      } });
      expect(describeApprovalActionFields({ actionId, actionArgs: input }).rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ title: 'Where', value: 'Everywhere' }), expect.objectContaining({ title: 'Change', value: label }),
      ]));
    }
    const replacement = spec.inputSchema.parse({ items: actionArgs.items, change: { kind: 'replace', rules: [] } });
    expect(describeApprovalActionFields({ actionId, actionArgs: replacement }).rows).toContainEqual(
      expect.objectContaining({ title: 'Replacement rules', entries: [{ label: 'Change', value: 'Remove all rules', depth: 0 }] }));
  });
  it('keeps saved-group library ids in technical detail and names a stored rename request', () => {
    const input = getActionSpec('widgets.fragment.update').inputSchema.parse({
      account: { serverId: 'home', accountId: 'owner' }, artifactId: 'opaque-library-id', patch: { name: 'Capacity and PRs' },
    });
    const presentation = describeApprovalActionFields({ actionId: 'widgets.fragment.update', actionArgs: input });
    expect(presentation.unrepresentable).toBeNull();
    expect(presentation.rows.find(row => row.path === 'artifactId')).toMatchObject({ technical: true });
    expect(getActionSpec('widgets.fragment.update').approvalPresentation?.summary(input)).toContain('Capacity and PRs');
  });
  it('reviews skill write operands independently of their deliberately narrow observation previews', () => {
    const file = skillFileFromBytesV1('SKILL.md', new TextEncoder().encode('---\nname: review\n---\nReview exactly this.'), 0o644);
    const cases = [
      ['skills.create', { name: 'review', files: [file], where: { kind: 'replace', rules: [] } }],
      ['skills.update', { skillId: 'skill', expectedRevision: '1:1', files: [{ kind: 'upsert', file }, { kind: 'remove', path: 'old.md' }] }],
      ['skills.install', { source: { kind: 'upload', files: [file] }, where: { kind: 'replace', rules: [] } }],
    ] as const;
    for (const [actionId, raw] of cases) {
      const spec = getActionSpec(actionId);
      const actionArgs = spec.inputSchema.parse(raw);
      // The same authored contract and summary call used by the live preview reader.
      ActionSpecSchema.parse(spec);
      expect(spec.approvalPresentation?.summary(actionArgs)).toBeNull();
      const presentation = describeApprovalActionFields({ actionId, actionArgs,
        preview: { actionId, actionArgs: spec.projectObservationInput?.(actionArgs) } });
      expect(presentation.unrepresentable, actionId).toBeNull();
      expect(JSON.stringify(presentation.rows), actionId).toContain('Review exactly this.');
      if (actionId === 'skills.update') expect(JSON.stringify(presentation.rows)).toContain('old.md');
      else expect(presentation.rows).toContainEqual(expect.objectContaining({ path: 'where', value: JSON.stringify(raw.where) }));
    }
  });
  it('names a declared setting while preserving the exact proposed value and anchor', () => {
    const anchor = 'delegation.workDepthLimit';
    const declaration = readBuiltInSettingDeclarationV1(anchor)!;
    const input = { anchor, value: 3 };
    expect(getActionSpec('settings.set').approvalPresentation?.summary(input))
      .toBe(`Change “${declaration.title}” to 3.`);
    expect(describeApprovalActionFields({ actionId: 'settings.set', actionArgs: input }))
      .toMatchObject({ unrepresentable: null, rows: [
        { path: 'anchor', value: anchor, reference: { kind: 'setting', id: anchor } },
        { path: 'value', value: '3' },
      ] });
    const structured = { kind: 'example', nested: [false, null, ' unchanged '] };
    const presentation = describeApprovalActionFields({ actionId: 'settings.set', actionArgs: { anchor, value: structured } });
    expect(presentation.rows.find(row => row.path === 'value')).toMatchObject({ value: JSON.stringify(structured) });
    expect(getActionSpec('settings.reset').approvalPresentation?.summary({ anchor }))
      .toBe(`Reset “${declaration.title}” to its default.`);
    expect(getActionSpec('settings.set').approvalPresentation?.summary({ anchor: 'unknown.setting', value: 3 })).toBeNull();
  });
  it('reads a theme choice as the choice it makes, not as profile ids, timestamps and schema versions', () => {
    const profile = { schemaVersion: 1, id: 'custom-2', name: 'Custom theme 2', createdAt: '2026-10-16T08:00:00.000Z',
      updatedAt: '2026-10-16T08:00:00.000Z', base: { light: 'light', dark: 'dark' }, overrides: { light: {}, dark: {} } };
    const activation = { anchor: 'appearance.themeMode', value: { activation: { profileId: 'custom-2', profileMode: 'light', profile } } };
    expect(getActionSpec('settings.set').approvalPresentation?.summary(activation)).toBe('Use “Custom theme 2” for light mode.');
    const presentation = describeApprovalActionFields({ actionId: 'settings.set', actionArgs: activation });
    expect(presentation.unrepresentable).toBeNull();
    expect(presentation.rows.find(row => row.path === 'value')).toMatchObject({ value: 'Use “Custom theme 2” for light mode' });
    expect(JSON.stringify(presentation.rows)).not.toMatch(/2026-10-16|schemaVersion/);
    expect(getActionSpec('settings.set').approvalPresentation?.summary({ anchor: 'appearance.themeMode', value: 'dark' }))
      .toBe('Switch to dark mode.');
    expect(getActionSpec('settings.set').approvalPresentation?.summary({ anchor: 'appearance.themeMode',
      value: { activation: { profileId: 'premiumDark', profileMode: 'dark' } } })).toBe('Use “Premium dark” for dark mode.');
  });
  it('reads a Board visual by its title and destination, with its identity only in technical details', () => {
    const presentation = describeApprovalActionFields({ actionId: 'session.board.item.upsert', actionArgs: {
      itemId: '1e3cb262-opaque', expectedItemRevision: null, destination: 'board',
      item: { v: 1, title: 'Daily usage', frame: 'card', height: { mode: 'auto', fallback: 'regular' },
        source: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Usage' } } } },
    } });
    expect(presentation.unrepresentable).toBeNull();
    expect(presentation.rows.find(row => row.path === 'itemId')).toMatchObject({ technical: true });
    expect(presentation.rows.find(row => row.path === 'destination')).toMatchObject({ value: 'Board', title: 'Destination' });
    expect(presentation.rows.filter(row => row.kind === 'value' && !row.technical).map(row => row.value))
      .not.toContain('1e3cb262-opaque');
  });
  it('declares Provider operands as references and keeps empty setup data out of the reading', () => {
    const presentation = describeApprovalActionFields({ actionId: 'providers.connections.create_contribution', actionArgs: {
      action: 'createContribution', connectionId: 'pc_new', contributionKey: 'happier.provider.deepseek/deepseek',
      displayName: 'Work source', savedSecretId: null, enable: true,
      deployment: { kind: 'managedLocal', purposeBindingDefaults: {} },
    } });
    expect(presentation.unrepresentable).toBeNull();
    expect(presentation.rows.find(row => row.path === 'connectionId')).toMatchObject({
      reference: { kind: 'providerConnection', id: 'pc_new', displayName: 'Work source' },
    });
    expect(presentation.rows.find(row => row.path === 'contributionKey')).toMatchObject({
      reference: { kind: 'providerContribution', id: 'happier.provider.deepseek/deepseek' },
    });
    expect(presentation.rows.find(row => row.path === 'enable')).toMatchObject({ valueFormat: 'boolean' });
    expect(presentation.rows.some(row => row.path === 'action' && row.kind === 'value' && !row.technical)).toBe(false);
  });
  it.each([
    ['prompts.stack.update', { surface: 'coding', expectedRevision: 4,
      intent: { kind: 'set_budget', entryId: 'entry-a', maxChars: 3001 } }],
    ['remote_hosts.connect', { hostId: 'home-host', expectedRevision: 4 }],
  ] as const)('admits %s with its complete invocation and intentionally narrower observation', (actionId, raw) => {
    const spec = getActionSpec(actionId);
    const actionArgs = spec.inputSchema.parse(raw);
    const preview = { actionId, actionArgs: spec.projectObservationInput?.(actionArgs) };
    const request: ApprovalRequestV2 = { v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'system' }, actionId, actionArgs, preview, summary: spec.title,
      executionOriginV1: { v: 1, authority: 'account_automation', caller: { kind: 'host' }, requestId: 'request-a',
        surface: 'ui', serverId: 'home', actionId } };
    const admission = resolveApprovalRequestApproveAdmission(ApprovalRequestV2Schema.parse(request));
    expect(admission).toMatchObject({ status: 'available' });
    if (actionId === 'prompts.stack.update') {
      expect(preview.actionArgs).not.toHaveProperty('intent');
      expect(admission.presentation.rows).toContainEqual(expect.objectContaining({
        kind: 'value', path: 'intent', value: JSON.stringify(raw.intent),
      }));
    }
    expect(resolveApprovalRequestApproveAdmission(ApprovalRequestV2Schema.parse({ ...request, actionArgs: null })))
      .toMatchObject({ status: 'unavailable', reason: 'context_unavailable' });
    const { expectedRevision: _revision, ...missingRevision } = actionArgs;
    expect(resolveApprovalRequestApproveAdmission(ApprovalRequestV2Schema.parse({ ...request, actionArgs: missingRevision })))
      .toMatchObject({ status: 'unavailable', reason: 'context_unavailable' });
    if (actionId === 'prompts.stack.update') {
      const { intent: _intent, ...missingIntent } = actionArgs;
      expect(resolveApprovalRequestApproveAdmission(ApprovalRequestV2Schema.parse({ ...request, actionArgs: missingIntent })))
        .toMatchObject({ status: 'unavailable', reason: 'context_unavailable' });
    }
  });
  it('reviews the full saved profile even when its observer preview deliberately contains only identity', () => {
    const profile = { v: 2, id: 'profile-a', name: 'Payments release workspace', createdAt: 1, updatedAt: 2,
      placement: { fixed: { serverId: 'home-a', machineId: 'machine-a' }, directory: '/tmp/checkout-service' } };
    const actionArgs = { id: profile.id, expectedRevision: 'absent', profile };
    const spec = getActionSpec('launch_profiles.save');
    expect(spec.inputSchema.safeParse(actionArgs).success).toBe(true);
    const observed = spec.projectObservationInput?.(actionArgs);
    expect(JSON.stringify(observed)).not.toContain(profile.name);
    const presentation = describeApprovalActionFields({ actionId: spec.id, actionArgs,
      preview: { actionId: spec.id, actionArgs: observed } });
    expect(presentation.unrepresentable).toBeNull();
    expect(presentation.rows).toContainEqual(expect.objectContaining({ path: 'expectedRevision', value: 'absent' }));
    const row = presentation.rows.find(row => row.path === 'profile');
    expect(row).toMatchObject({ kind: 'value', value: JSON.stringify(profile), entries: expect.arrayContaining([
      expect.objectContaining({ label: 'Name', value: profile.name }),
      expect.objectContaining({ label: 'Directory', value: '/tmp/checkout-service' }),
    ]) });
  });

  it('presents supplied operands even when an Action has no form field hints', () => {
    const presentation = describeApprovalActionFields({ actionId: 'launch_profiles.favorite.set',
      actionArgs: { id: 'profile-a', favorite: false } });
    expect(presentation.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'id', value: 'profile-a' }),
      expect.objectContaining({ path: 'favorite', value: 'false' }),
    ]));
  });

  it('reviews a private Account security choice without adding it to shared observations', () => {
    const spec = getActionSpec('account.security.terminalPresentUser.set');
    const actionArgs = { policy: 'allowed' };
    expect(spec.projectObservationInput?.(actionArgs)).toEqual({});
    expect(describeApprovalActionFields({ actionId: spec.id, actionArgs,
      preview: { actionId: spec.id, actionArgs: {} } })).toMatchObject({ unrepresentable: null,
        rows: [expect.objectContaining({ path: 'policy', value: 'allowed' })] });
  });

  it('refuses an approval when its reviewed input cannot be presented', () => {
    const request: ApprovalRequestV2 = { v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'cli' }, actionId: 'launch_profiles.save', actionArgs: { id: 'profile-a' }, summary: 'Save profile',
      executionOriginV1: { v: 1, authority: 'account_automation', caller: { kind: 'host' }, requestId: 'request-a',
        surface: 'cli', serverId: 'home', actionId: 'launch_profiles.save' } };
    for (const actionId of ['launch_profiles.save', 'launch_profiles.enabled.set'] as const) {
      expect(resolveApprovalRequestApproveAdmission({ ...request, actionId,
        executionOriginV1: { ...request.executionOriginV1, actionId } }))
        .toMatchObject({ status: 'unavailable', reason: 'context_unavailable' });
    }
  });
  it('lets the widget Action own a human approval summary with names instead of raw structure', () => {
    const input = {
      surface: {
        serverId: 'srv_home',
        accountId: '5e3a0581-6f3d-4e73-bf40-383db0be6c3e',
        owner: { kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'qaf1-usage' },
      },
      instance: {
        v: 1,
        id: 'qaf1-usage-b',
        definition: { kind: 'artifact', artifactId: 'a2881e01' },
        bindings: {},
        displayName: 'Qaf1 Usage b',
      },
      size: 'small',
    };

    expect(getActionSpec('widgets.item.add').approvalPresentation?.summary(input)).toBe(
      'Add “Qaf1 Usage b” (small) to Usage · Main area.',
    );
  });

  it('uses captured widget and page names while keeping plugin routing operands technical', () => {
    const surface = { serverId: 'home', accountId: 'account', owner: {
      kind: 'pluginArea', pluginId: 'examples.widget-areas', pageId: 'overview', area: 'pinned',
    } };
    const widgetPresentation = { widgetName: 'Directory count', pageName: 'Widget areas', areaName: 'Pinned' };
    for (const actionId of ['widgets.item.add', 'widgets.item.remove'] as const) {
      const actionArgs = actionId === 'widgets.item.add'
        ? { surface, instance: { v: 1, id: 'copy', definition: { kind: 'installed', surface: { pluginId: 'examples.widget-areas', localId: 'count' } }, bindings: {} } }
        : { ref: { surface, instanceId: 'copy' } };
      expect(getActionSpec(actionId).approvalPresentation?.summary(actionArgs, { widgetPresentation }))
        .toContain('“Directory count”');
      expect(getActionSpec(actionId).approvalPresentation?.summary(actionArgs, { widgetPresentation }))
        .toContain('Widget areas · Pinned');
      const entries = describeApprovalActionFields({ actionId, actionArgs }).rows.flatMap(row => row.kind === 'value' ? row.entries ?? [] : []);
      for (const value of ['examples.widget-areas', 'overview', 'pinned']) {
        expect(entries.filter(entry => entry.value?.includes(value))).not.toEqual([]);
        expect(entries.filter(entry => entry.value?.includes(value)).every(entry => entry.technical)).toBe(true);
      }
    }
  });

  it('reads adding a saved widget by what it is and the network it gets, not by its routing operands', () => {
    const input = { surface: { serverId: 'home', accountId: 'account', owner: { kind: 'home' } },
      instance: { v: 1, id: 'qa-html-instance', definition: { kind: 'artifact', artifactId: '8807a622' }, bindings: {},
        networkOverride: { network: 'none' } } };
    expect(getActionSpec('widgets.item.add').approvalPresentation?.summary(input)).toBe('Add a saved widget to Home.');
    const rows = describeApprovalActionFields({ actionId: 'widgets.item.add', actionArgs: input }).rows;
    const at = rows.findIndex(row => row.path === 'instance');
    expect(rows[at + 1]).toMatchObject({ kind: 'value', title: 'Network', value: 'No network access' });
    // Said once: the override's raw members leave the readable instance entries.
    const instance = rows[at];
    if (instance?.kind !== 'value') throw new Error('Missing instance reading');
    expect(instance.entries?.filter(entry => entry.value === 'none')).toEqual([expect.objectContaining({ technical: true })]);
    // Nothing readable remains in it, so the whole row moves to Details rather than standing as a bare title.
    expect(instance).toMatchObject({ technical: true });
    // A group that only says what kind it is reads as one line ("Owner  Home"), not a heading over "Kind".
    const surface = rows.find(row => row.path === 'surface');
    if (surface?.kind !== 'value') throw new Error('Missing surface reading');
    expect(surface.entries?.filter(entry => entry.label === 'Owner' || entry.label === 'Kind'))
      .toEqual([{ label: 'Owner', value: 'Home', depth: 0 }]);
  });

  it('names a copied group and its widgets while keeping routing identities behind Details', () => {
    const input = { surface: { serverId: 'home', accountId: 'account', owner: { kind: 'home' } },
      group: { kind: 'group', id: 'opaque-group', title: 'Capacity and PRs copy', width: 'full',
        frameStyle: 'card', dividers: 'hairline', children: [
          { kind: 'widget', instance: { v: 1, id: 'opaque-capacity', definition: { kind: 'builtin', id: 'usage_capacity' }, bindings: {} } },
          { kind: 'widget', instance: { v: 1, id: 'opaque-prs', displayName: 'New in PRs & Issues',
            definition: { kind: 'installed', surface: { pluginId: 'happier.triage', localId: 'latest' } }, bindings: {} } },
        ] } };
    expect(getActionSpec('widgets.group.add').approvalPresentation?.summary(input))
      .toBe('Add “Capacity and PRs copy” to Home with Capacity · New in PRs & Issues.');
    const row = describeApprovalActionFields({ actionId: 'widgets.group.add', actionArgs: input }).rows.find(row => row.path === 'group');
    if (row?.kind !== 'value') throw new Error('Missing group reading');
    expect(row.entries?.filter(entry => ['opaque-group', 'opaque-capacity', 'opaque-prs', 'happier.triage', 'latest'].includes(entry.value ?? '')))
      .toEqual(expect.arrayContaining([expect.objectContaining({ value: 'opaque-group', technical: true }),
        expect.objectContaining({ value: 'happier.triage', technical: true })]));
  });

  it('summarizes saving a group as its named content rather than its Artifact operands', () => {
    const input = { account: { serverId: 'home', accountId: 'account' }, artifactId: 'opaque-fragment', fragment: {
      name: 'Release checks', inputs: { fields: [] }, inputSchema: { type: 'object' }, group: {
        width: 'full', frameStyle: 'card', dividers: 'hairline', children: [{ kind: 'widget', instance: {
          v: 1, definition: { kind: 'builtin', id: 'usage_capacity' }, bindings: { label: { kind: 'value', value: { id: 'my-visible-id' } } },
        } }],
      },
    } };
    expect(getActionSpec('widgets.fragment.create').approvalPresentation?.summary(input))
      .toBe('Save “Release checks” to Your widgets with Capacity.');
    const fields = describeApprovalActionFields({ actionId: 'widgets.fragment.create', actionArgs: input });
    expect(fields.rows.find(row => row.path === 'artifactId')).toMatchObject({ technical: true });
    const fragment = fields.rows.find(row => row.path === 'fragment');
    if (fragment?.kind !== 'value') throw new Error('Missing fragment review');
    expect(fragment.entries?.find(entry => entry.value === 'my-visible-id')).not.toHaveProperty('technical');
  });

  it('gives a structured JSON value readable labelled entries beside its exact literal', () => {
    const intent = { kind: 'create', board: { title: 'Launch plan', boardId: null, tags: ['ui', 'qa'], items: [{ title: 'Ship' }] } };
    const presentation = describeApprovalActionFields({ actionId: 'boards.apply', actionArgs: { intent } });
    const row = presentation.rows.find((candidate) => candidate.path === 'intent');
    // The literal stays exact (admission and copy read it); people read the entries.
    expect(row).toMatchObject({ kind: 'value', value: JSON.stringify(intent) });
    expect(row && row.kind === 'value' ? row.entries : undefined).toEqual([
      { label: 'Kind', value: 'Create', depth: 0 },
      { label: 'Board', value: null, depth: 0 },
      { label: 'Title', value: 'Launch plan', depth: 1 },
      // An unset value stays exact in the literal and reads under Technical details.
      { label: 'Board id', value: 'null', depth: 1, technical: true },
      { label: 'Tags', value: 'ui, qa', depth: 1 },
      { label: 'Items', value: null, depth: 1 },
      { label: '1', value: null, depth: 2 },
      { label: 'Title', value: 'Ship', depth: 3 },
    ]);
  });

  it('names Home and Account references, reads kinds and sizes as words, and keeps versions and empty values aside', () => {
    const surface = { serverId: 'srv_home', accountId: '5e3a0581-6f3d-4e73-bf40-383db0be6c3e',
      owner: { kind: 'corePage', pageId: 'usage', area: 'main' }, layoutId: 'qaf1-usage' };
    const instance = { v: 1, id: 'qaf1-usage-b', definition: { kind: 'artifact', artifactId: 'a2881e01' }, bindings: {}, displayName: 'Usage b' };
    const presentation = describeApprovalActionFields({ actionId: 'widgets.item.add', actionArgs: { surface, instance, size: 'small' } });
    const entries = (path: string) => {
      const row = presentation.rows.find((candidate) => candidate.path === path);
      return row && row.kind === 'value' ? row.entries : undefined;
    };
    // References read by their names; target ids stay in view; versions and empty values stay present, aside.
    expect(entries('surface')).toEqual([
      { label: 'Server id', value: 'srv_home', depth: 0, reference: { kind: 'home', id: 'srv_home' } },
      { label: 'Account id', value: '5e3a0581-6f3d-4e73-bf40-383db0be6c3e', depth: 0,
        reference: { kind: 'account', id: '5e3a0581-6f3d-4e73-bf40-383db0be6c3e' } },
      // A small kind-led group of plain values reads as one line, not a heading over Kind / Page id / Area.
      { label: 'Owner', value: 'Core page · Usage · Main', depth: 0 },
      { label: 'Layout id', value: 'qaf1-usage', depth: 0 },
    ]);
    expect(entries('instance')).toEqual([
      { label: 'V', value: '1', depth: 0, technical: true },
      { label: 'Id', value: 'qaf1-usage-b', depth: 0, technical: true },
      { label: 'Definition', value: null, depth: 0 },
      { label: 'Kind', value: 'Artifact', depth: 1, technical: true },
      { label: 'Artifact id', value: 'a2881e01', depth: 1, technical: true },
      { label: 'Bindings', value: '{}', depth: 0, technical: true },
      { label: 'Display name', value: 'Usage b', depth: 0 },
    ]);
    // A chosen option reads by its label, as the form that set it.
    expect(presentation.rows.find((candidate) => candidate.path === 'size')).toMatchObject({ value: 'Small' });
  });

  it('keeps a target id argument in view, so an approval shows exactly what it acts on', () => {
    const presentation = describeApprovalActionFields({ actionId: 'widgets.group.create', actionArgs: {
      surface: { serverId: 'srv_home', accountId: 'acct-1' }, groupId: 'usage-group', title: 'Usage' } });
    const row = presentation.rows.find((candidate) => candidate.path === 'groupId');
    expect(row).toEqual({ kind: 'value', path: 'groupId', title: 'Group id', value: 'usage-group' });
  });

  it('reads a Browser view command by its target, with its correlation ids and plumbing in technical details', () => {
    const presentation = describeApprovalActionFields({ actionId: 'browser.view.open', actionArgs: {
      commandId: 'cmd-1', browserSessionId: 'session-1', viewId: 'view-1', kind: 'openView',
      target: { targetId: 'target-1', kind: 'externalUrl', url: 'http://127.0.0.1:4000' }, platform: 'web', focus: true } });
    const technical = presentation.rows.filter((row) => row.kind === 'value' && row.technical).map((row) => row.path).sort();
    expect(technical).toEqual(['browserSessionId', 'commandId', 'focus', 'kind', 'platform', 'viewId']);
    const target = presentation.rows.find((row) => row.path === 'target');
    expect(target).toMatchObject({ kind: 'value' });
    expect(target?.kind === 'value' && target.technical).toBeFalsy();
    const members = target?.kind === 'value' ? target.entries ?? [] : [];
    expect(members.filter((entry) => entry.technical).map((entry) => entry.value)).toEqual(['target-1']);
    expect(members.find((entry) => entry.label === 'Url')).toMatchObject({ value: 'http://127.0.0.1:4000' });
    expect(members.find((entry) => entry.label === 'Url')?.technical).toBeFalsy();
  });

  it('shows custom Provider target, endpoint and proposed template without credential or header values', () => {
    const actionArgs = { action: 'createCustom', connectionId: 'pc_review', enable: true, savedSecretId: 'private-secret-reference',
      template: { v: 1, name: 'Review source', endpointTemplates: [{ id: 'messages', protocol: 'anthropic',
        baseUrl: 'http://127.0.0.1:46435/v1', publicHeaders: { 'x-private': 'private-header-value' },
        capabilities: { streaming: 'unknown', toolRoundTrips: 'unknown', statefulResponses: 'unknown', reasoningControls: 'unknown' } }],
        credential: { kind: 'apiKey', required: true, transports: [{ id: 'api-key', protocols: ['anthropic'], uses: ['runtime'],
          destination: { kind: 'httpHeader', name: 'x-api-key', format: 'raw' } }] },
        catalog: { source: 'manual', manualModelPolicy: 'allowed' } }, manualModels: [] };
    const presentation = describeApprovalActionFields({ actionId: 'providers.connections.create_custom', actionArgs });
    expect(presentation.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'connectionId', value: 'pc_review' }),
      expect.objectContaining({ path: 'template.name', value: 'Review source' }),
      expect.objectContaining({ path: 'template.endpointTemplates.[].baseUrl', value: 'http://127.0.0.1:46435/v1' }),
      expect.objectContaining({ path: 'template.endpointTemplates.[].protocol', value: 'anthropic' }),
      expect.objectContaining({ path: 'template.credential', value: expect.stringContaining('"required":true') }),
    ]));
    expect(JSON.stringify(presentation)).not.toMatch(/private-secret-reference|private-header-value/);
    expect(presentation.unrepresentable).toBeNull();
    const spec = getActionSpec('providers.connections.create_custom');
    const admitted = spec.inputSchema.parse(actionArgs);
    const observed = spec.projectObservationInput?.(admitted);
    expect(JSON.stringify(observed)).not.toMatch(/private-secret-reference|private-header-value/);
    const fromPreview = describeApprovalActionFields({ actionId: spec.id, actionArgs: admitted,
      preview: { actionId: spec.id, actionArgs: observed } });
    expect(fromPreview).toEqual(presentation);
  });

  it('shows exact gateway slot replacement and explicit placement/helper clears', () => {
    const purposeBindingDefaults = { upstream: { kind: 'group', service: { pluginId: 'example.auth', localId: 'subscription' }, groupId: 'pool-new' } };
    const presentation = describeApprovalActionFields({ actionId: 'providers.connections.update', actionArgs: {
      action: 'update', connectionId: 'pc_gateway', expectedRevision: 2, displayName: 'Shared gateway',
      deployment: { kind: 'managedLocal', purposeBindingDefaults }, gatewayPlacement: null, claudeHelperModels: null,
    } });
    expect(presentation.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'displayName', value: 'Shared gateway' }),
      expect.objectContaining({ path: 'deployment.purposeBindingDefaults', value: JSON.stringify(purposeBindingDefaults) }),
      expect.objectContaining({ path: 'gatewayPlacement', value: 'null' }),
      expect.objectContaining({ path: 'claudeHelperModels', value: 'null' }),
    ]));
    expect(presentation.unrepresentable).toBeNull();
  });

  it('shows Connected account label clearing and exact pool targets', () => {
    const account = { service: { pluginId: 'example.auth', localId: 'subscription' }, accountId: 'account-a' };
    const presentation = describeApprovalActionFields({ actionId: 'connectedServices.accounts.rename', actionArgs: { account, label: '' } });
    expect(presentation.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'account', value: JSON.stringify(account) }),
      expect.objectContaining({ path: 'label', value: '\"\"' }),
    ]));
  });

  it('keeps exact deletion targets and endpoint reset visible without exposing credential-bearing URLs', () => {
    expect(describeApprovalActionFields({ actionId: 'providers.connections.delete', actionArgs: {
      action: 'delete', connectionId: 'pc_remove',
    } }).rows).toContainEqual(expect.objectContaining({ path: 'connectionId', value: 'pc_remove' }));
    const endpoint = { action: 'setEndpointOverride', connectionId: 'pc_review', expectedRevision: 3,
      scope: 'account', endpointTemplateId: 'messages', baseUrl: null };
    expect(describeApprovalActionFields({ actionId: 'providers.connections.endpoint.set', actionArgs: endpoint }).rows)
      .toContainEqual(expect.objectContaining({ path: 'baseUrl', value: 'null' }));
    for (const baseUrl of ['https://user:recognizable-secret@example.test/v1',
      'https://example.test/v1?api_key=recognizable-secret', 'https://example.test/v1#recognizable-secret']) {
      const spec = getActionSpec('providers.connections.endpoint.set');
      const observed = spec.projectObservationInput?.({ ...endpoint, baseUrl });
      expect(JSON.stringify(observed)).not.toContain('recognizable-secret');
      expect(describeApprovalActionFields({ actionId: spec.id, actionArgs: { ...endpoint, baseUrl } }).rows)
        .not.toContainEqual(expect.objectContaining({ path: 'baseUrl' }));
    }
  });

  it('shows draft Test and contributed endpoint overrides from their real admitted input shapes', () => {
    const spec = getActionSpec('providers.probe');
    const draft = spec.inputSchema.parse({ kind: 'draft', draftConnectionId: 'pc_draft', machineId: 'computer',
      template: { v: 1, name: 'Draft source', endpointTemplates: [{ id: 'messages', protocol: 'anthropic',
        baseUrl: 'http://127.0.0.1:46435/v1', capabilities: { streaming: 'unknown', toolRoundTrips: 'unknown',
          statefulResponses: 'unknown', reasoningControls: 'unknown' } }], catalog: { source: 'manual', manualModelPolicy: 'allowed' } },
      savedSecretId: null, actionNonce: 'test-action-nonce' });
    expect(describeApprovalActionFields({ actionId: spec.id, actionArgs: draft }).rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'draftConnectionId', value: 'pc_draft' }),
      expect.objectContaining({ path: 'template.name', value: 'Draft source' }),
      expect.objectContaining({ path: 'template.endpointTemplates.[].baseUrl', value: 'http://127.0.0.1:46435/v1' }),
      expect.objectContaining({ path: 'template.credential', value: 'null' }),
    ]));
    const overrides = [{ endpointTemplateId: 'messages', baseUrl: 'https://override.example.test/' }];
    const contributed = describeApprovalActionFields({ actionId: 'providers.connections.create_contribution', actionArgs: {
      action: 'createContribution', connectionId: 'pc_builtin', contributionKey: 'example.provider/source',
      displayName: 'Work source', savedSecretId: 'private-secret-reference', enable: true,
      authoringReview: { endpointOverrides: overrides },
    } });
    expect(contributed.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'displayName', value: 'Work source' }),
      expect.objectContaining({ path: 'authoringReview.endpointOverrides', value: JSON.stringify(overrides) }),
    ]));
    expect(JSON.stringify(contributed)).not.toContain('private-secret-reference');
  });
  it('declares every machine-family input operand for exact-target approval review', () => {
    for (const actionId of [...MACHINE_PRESET_ACTION_IDS_V1, ...MACHINE_POOL_ACTION_IDS_V1, ...MANAGED_MACHINE_ACTION_IDS_V1]) {
      const spec = getActionSpec(actionId);
      const declared = new Set(spec.inputHints?.fields.map(field => field.path.split('.')[0]));
      const paths = readActionSchemaTopLevelFieldNames(spec.inputSchema);
      if (paths) expect([...paths].filter(path => !declared.has(path)), actionId).toEqual([]);
    }
  });

  it('shows preset configuration, deletion target and the reviewed managed effect in approval details', () => {
    const preset = { homeId: 'home', id: 'preset', name: 'Personal machine', owner: { kind: 'account', accountId: 'account' },
      recipe: { provider: { pluginId: 'machine.example', localId: 'vm' }, schemaVersion: 1, name: 'Work VM', choices: { cpu: 2 } },
      controller: { machineId: 'controller', installationId: 'installation' },
      environment: { setupScript: 'echo ready' }, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
    const presentation = describeApprovalActionFields({ actionId: 'machines.presets.create', actionArgs: preset });
    expect(presentation.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'name', value: preset.name }),
      expect.objectContaining({ path: 'recipe', value: JSON.stringify(preset.recipe) }),
      expect.objectContaining({ path: 'controller', value: JSON.stringify(preset.controller) }),
      expect.objectContaining({ path: 'environment', value: JSON.stringify(preset.environment) }),
    ]));
    expect(describeApprovalActionFields({ actionId: 'machines.pools.delete', actionArgs: { poolId: 'pool', expectedRevision: 3 } }).rows)
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: 'poolId', value: 'pool' }),
        expect.objectContaining({ path: 'expectedRevision', value: '3' })]));
    expect(describeApprovalActionFields({ actionId: 'machines.managed.delete', actionArgs: {
      homeId: 'home', managedId: 'managed', when: 'now', intent: 'delete', expectedRevision: 4, reviewedDependencies: true,
    } }).rows).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'managedId', value: 'managed' }),
      expect.objectContaining({ path: 'intent', value: 'Delete' }), expect.objectContaining({ path: 'reviewedDependencies', value: 'true' })]));
    const deferred = describeApprovalActionFields({ actionId: 'machines.managed.delete', actionArgs: {
      homeId: 'home', managedId: 'managed', when: 'after-idle', intent: 'delete', reviewedDependencies: true, afterMs: 0,
    } });
    expect(deferred.unrepresentable).toBeNull();
    expect(deferred.rows).toContainEqual(expect.objectContaining({ path: 'afterMs', value: '0' }));
    const selection = { kind: 'one-off', homeId: 'home', controller: preset.controller };
    const acquire = describeApprovalActionFields({ actionId: 'machines.managed.acquire', actionArgs: { selection } });
    expect(acquire.unrepresentable).toBeNull();
    expect(acquire.rows).toContainEqual(expect.objectContaining({ path: 'selection', value: JSON.stringify(selection) }));
  });

  it('represents the validated guide starter without waiving ordinary prompt content', () => {
    const starter = describeApprovalActionFields({ actionId: 'prompt_doc.create', actionArgs: { starter: 'happier_guide' } });
    expect(starter.unrepresentable).toBeNull();
    expect(starter.rows).toContainEqual(expect.objectContaining({ path: 'starter', value: 'happier_guide' }));
    for (const actionArgs of [{}, { starter: 'unknown' }, { title: 'Incomplete' }]) {
      expect(describeApprovalActionFields({ actionId: 'prompt_doc.create', actionArgs }).unrepresentable)
        .toMatchObject({ reason: 'missing_required_context' });
    }
  });
  it.each(['', ' \n '])('represents explicitly blank prompt content (%j) without admitting missing content', markdown => {
    const empty = describeApprovalActionFields({ actionId: 'prompt_doc.create', actionArgs: { title: 'Blank document', markdown } });
    expect(empty.unrepresentable).toBeNull();
    expect(empty.rows).toContainEqual(expect.objectContaining({ path: 'markdown', value: JSON.stringify(markdown) }));
    expect(describeApprovalActionFields({ actionId: 'prompt_doc.create', actionArgs: { title: 'Missing content' } }).unrepresentable)
      .toMatchObject({ path: 'markdown', reason: 'missing_required_context' });
  });
  it('makes update-clear visible while leaving ordinary Markdown review verbatim', () => {
    for (const markdown of ['', ' \n ']) {
      const cleared = describeApprovalActionFields({ actionId: 'prompt_doc.update', actionArgs: { artifactId: 'document', title: 'Document', markdown } });
      expect(cleared.unrepresentable).toBeNull();
      expect(cleared.rows).toContainEqual(expect.objectContaining({ path: 'markdown', value: JSON.stringify(markdown) }));
    }
    const markdown = '# Reviewed content';
    for (const actionId of ['prompt_doc.create', 'prompt_doc.update']) {
      const ordinary = describeApprovalActionFields({ actionId, actionArgs: { artifactId: 'document', title: 'Document', markdown } });
      expect(ordinary.rows).toContainEqual(expect.objectContaining({ path: 'markdown', value: markdown }));
    }
  });
  it.each([undefined, null])('keeps absent or undeclared-null required context (%j) unavailable', markdown => {
    expect(describeApprovalActionFields({ actionId: 'prompt_doc.create', actionArgs: { title: 'Document', markdown } }).unrepresentable)
      .toMatchObject({ path: 'markdown', reason: 'missing_required_context' });
  });
  it('retains the declared-null context exception', () => {
    expect(describeApprovalActionFields({ actionId: 'settings.set', actionArgs: { anchor: 'example', value: null } }).unrepresentable)
      .toBeNull();
  });
  it('represents a declared-null create revision across input alternatives without admitting an absent revision', () => {
    const actionArgs = { itemId: 'note', expectedItemRevision: null, item: { v: 1, title: 'Note', frame: 'card',
      height: { mode: 'auto', fallback: 'regular' }, source: { kind: 'declarative',
        document: { version: 1, root: { kind: 'markdown', text: 'Note' } } } } };
    expect(describeApprovalActionFields({ actionId: 'session.board.item.upsert', actionArgs }).unrepresentable).toBeNull();
    const { expectedItemRevision: _revision, ...absent } = actionArgs;
    expect(describeApprovalActionFields({ actionId: 'session.board.item.upsert', actionArgs: absent }).unrepresentable)
      .toMatchObject({ path: 'expectedItemRevision', reason: 'missing_required_context' });
  });
  it.each(['account', 'team', 'group'])('keeps %s access principals as data, not Session references', (kind) => {
    const principal = { kind, ...(kind === 'group' ? { teamId: 'team-1' } : {}), [`${kind}Id`]: 'session-shaped-id' };
    const rows = describeApprovalActionFields({ actionId: 'machines.access.grant.set',
      actionArgs: { serverId: 'home', machineId: 'machine', principal, level: 'view' } }).rows;
    expect(rows.find(row => row.path === 'principal')).toMatchObject({ kind: 'value', path: 'principal', value: JSON.stringify(principal) });
    expect(rows.find(row => row.path === 'principal')).not.toHaveProperty('reference');
  });

  it('identifies the declared Voice Session target with its own Home', () => {
    const rows = describeApprovalActionFields({ actionId: 'ui.voice_global.start', actionArgs: {
      target: { kind: 'session', sessionAddress: { serverId: 'other-home', sessionId: 'session-1' } }, expectedAttempt: null,
    } }).rows;
    expect(rows.find(row => row.path === 'target')).toMatchObject({
      reference: { kind: 'session', id: 'session-1', serverId: 'other-home' },
    });
  });

  it('does not interpret an arbitrary configuration object as a typed target', () => {
    const value = { kind: 'session', sessionId: 'session-1', unrelatedSessionId: 'session-2', empty: '', absent: null };
    const rows = describeApprovalActionFields({ actionId: 'settings.set', actionArgs: { anchor: 'example', value } }).rows;
    const row = rows.find(row => row.path === 'value');
    expect(row).toMatchObject({ value: JSON.stringify(value) });
    expect(row).not.toHaveProperty('reference');
    if (row?.kind !== 'value') throw new Error('Missing configuration reading');
    const unrelated = row.entries?.find(entry => entry.value === value.unrelatedSessionId);
    expect(unrelated).toBeDefined();
    expect(unrelated).not.toHaveProperty('reference');
  });
  it.each([
    ['ordered members', ['account-b', 'account-a']],
    ['an explicit empty list', []],
  ])('preserves %s as structured JSON rather than flattening or hiding the mutation', (_label, accountIds) => {
    const presentation = describeApprovalActionFields({
      actionId: 'connectedServices.pools.reorder',
      actionArgs: {
        group: { serviceId: 'service-a', groupId: 'pool-a' },
        accountIds,
        expectedGeneration: '1',
      },
    });

    expect(presentation.rows).toContainEqual(expect.objectContaining({
      kind: 'value', path: 'accountIds', value: JSON.stringify(accountIds),
    }));
    expect(presentation.unrepresentable).toBeNull();
  });

  it('treats required input withheld by live-only custody as present without disclosing it', () => {
    const presentation = describeApprovalActionFields({
      actionId: 'notifications.webhooks.signingSecret.set',
      actionArgs: {
        channelId: 'webhook-a',
        secret: 'recognizable-live-only-secret',
      },
    });

    expect(presentation).toEqual({
      rows: [
        { kind: 'value', path: 'channelId', title: 'Webhook id', value: 'webhook-a' },
      ],
      unrepresentable: null,
    });
    expect(JSON.stringify(presentation)).not.toContain('recognizable-live-only-secret');
  });

  it('applies live-only withholding to non-secret structured configuration fields', () => {
    const presentation = describeApprovalActionFields({
      actionId: 'connectedServices.configuration.replace',
      actionArgs: {
        service: { pluginId: 'happier.agent.codex', localId: 'openai' },
        modeId: 'configured',
        expectedRevision: 'before',
        values: { endpoint: 'https://private-endpoint.test' },
        secretValues: { token: 'recognizable-private-replacement' },
      },
    });

    expect(presentation.unrepresentable).toBeNull();
    expect(JSON.stringify(presentation)).not.toContain('private-endpoint');
    expect(JSON.stringify(presentation)).not.toContain('private-replacement');
  });

  it('shows worker policy, service placement and operation cancellation operands without requiring absent union-arm context', () => {
    const workspace = { serverId: 'home', refId: 'checkout' };
    const disabled = { enabled: false, unavailable: 'ask', allowAdHoc: false, scriptOverrides: {} };
    const enabled = { enabled: true, destination: { kind: 'pool', poolId: '39a2d0b4-c6ce-4e85-a674-1b8c5824d425', selection: 'automatic' },
      unavailable: 'fail', allowAdHoc: true, scriptOverrides: { build: 'workers' } };
    const primary = { runsOn: { kind: 'primary' }, unavailable: 'fail' };
    const workers = { runsOn: { kind: 'workers', destination: { kind: 'machine', machineId: 'worker' } }, unavailable: 'primary' };
    const cases = [
      ['projects.worker.preferences.set', { workspace, expectedRevision: 'absent', expected: { kind: 'absent' }, next: disabled }],
      ['projects.worker.preferences.set', { workspace, expectedRevision: 3, expected: { kind: 'value', value: disabled }, next: enabled }],
      ['projects.worker.preferences.reset', { workspace, expectedRevision: 4, expected: { kind: 'value', value: enabled } }],
      ['machines.worker.policy.set', { serverId: 'home', machineId: 'worker', expectedMetadataVersion: 5,
        expectedPolicy: { accepting: true, runAtMost: null }, policy: { accepting: false, runAtMost: 2 } }],
      ['projects.service.placement.set', { workspace, serviceName: 'web', expectedRevision: 'absent',
        expected: { kind: 'absent' }, value: primary }],
      ['projects.service.placement.set', { workspace, serviceName: 'web', expectedRevision: 6,
        expected: { kind: 'value', value: primary }, value: workers }],
      ['action.operations.cancel', { serverId: 'home', machineId: 'worker', operationId: 'operation' }],
    ] as const;
    for (const [actionId, raw] of cases) {
      const actionArgs = getActionSpec(actionId).inputSchema.parse(raw);
      const presentation = describeApprovalActionFields({ actionId, actionArgs });
      expect(presentation.unrepresentable, actionId).toBeNull();
      if (typeof actionArgs !== 'object' || actionArgs === null) throw new Error(`Expected object Action input for ${actionId}`);
      for (const [path, value] of Object.entries(actionArgs)) {
        // A value that is only its kind (`{ kind: 'absent' }`) reads as that word, like a chosen option.
        const kindOnly = typeof value === 'object' && value !== null && Object.keys(value).join() === 'kind';
        expect(presentation.rows, `${actionId}:${path}`).toContainEqual(expect.objectContaining({
          path, value: kindOnly ? 'Absent' : typeof value === 'object' ? JSON.stringify(value) : String(value),
        }));
      }
    }
    expect(describeApprovalActionFields({ actionId: 'action.operations.cancel',
      actionArgs: { serverId: 'home', operationId: 'operation' } }).unrepresentable)
      .toMatchObject({ path: 'machineId', reason: 'missing_required_context' });
  });

  it.each(['sessions.external.link.ensure', 'sessions.external.transcript.page', 'sessions.external.transcript.readAfter'] as const)(
    'reviews the canonical Agent identity after external-session ingress normalization: %s', actionId => {
      for (const identity of [{ agentId: 'codex' }, { providerId: 'codex' }]) {
        const actionArgs = getActionSpec(actionId).inputSchema.parse({
          ...identity, machineId: 'machine', remoteSessionId: 'native-session', source: { kind: 'codexHome', home: 'user' },
          ...(actionId === 'sessions.external.transcript.page' ? { direction: 'older' } : {}),
          ...(actionId === 'sessions.external.transcript.readAfter' ? { cursor: 'native-cursor' } : {}),
        });
        const presentation = describeApprovalActionFields({ actionId, actionArgs });
        expect(presentation.unrepresentable).toBeNull();
        expect(presentation.rows).toContainEqual(expect.objectContaining({ path: 'agentId', value: 'codex' }));
      }
    });

  it('reads an encoded file in a visual by its size, never by its bytes', () => {
    const contentBase64 = Buffer.from('<main>Build health</main>'.repeat(60)).toString('base64');
    const item = { v: 1, title: 'Build health', frame: 'frameless', height: { mode: 'auto', fallback: 'regular' },
      source: { kind: 'hostedHtml', source: { v: 1, entrypoint: 'index.html', files: { 'index.html': { mime: 'text/html', contentBase64 } } } } };
    const presentation = describeApprovalActionFields({ actionId: 'session.board.item.upsert',
      actionArgs: { sessionId: 'session-1', itemId: 'build-health', expectedItemRevision: null, destination: 'transcript', item } });
    const row = presentation.rows.find((candidate) => candidate.path === 'item');
    const entries = row && row.kind === 'value' ? row.entries ?? [] : [];
    expect(entries.some((entry) => entry.value?.includes(contentBase64))).toBe(false);
    expect(entries).toContainEqual({ label: 'Size', value: '1.5 KB', depth: 4 });
    // Admission and copy still read the exact literal.
    expect(row).toMatchObject({ kind: 'value', value: JSON.stringify(item) });
  });

  it('says what network an HTML visual will get, including none when it declares nothing', () => {
    const html = { v: 1, entrypoint: 'index.html', files: { 'index.html': { mime: 'text/html', contentBase64: 'PGI+aGk8L2I+' } } };
    const networkOf = (requestedCapabilities?: unknown) => {
      const item = { v: 1, title: 'Build health', source: { kind: 'hostedHtml', source: html,
        ...(requestedCapabilities === undefined ? {} : { requestedCapabilities }) } };
      const rows = describeApprovalActionFields({ actionId: 'session.board.item.upsert',
        actionArgs: { sessionId: 'session-1', itemId: 'build-health', expectedItemRevision: null, destination: 'transcript', item } }).rows;
      const row = rows.find((candidate) => candidate.title === 'Network');
      return row && row.kind === 'value' && !row.technical ? row.value : null;
    };
    expect(networkOf()).toBe('No network access');
    expect(networkOf({ networkOrigins: ['https://api.example.com', 'https://cdn.example.com'] }))
      .toBe('Only https://api.example.com, https://cdn.example.com');
    expect(networkOf({ network: 'open' })).toBe('Any site');
    // A typed visual runs no code, so it has no network to state.
    expect(describeApprovalActionFields({ actionId: 'session.board.item.upsert', actionArgs: { sessionId: 'session-1',
      itemId: 'notes', expectedItemRevision: null, destination: 'transcript',
      item: { v: 1, source: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Hi' } } } } } })
      .rows.some((row) => row.title === 'Network')).toBe(false);
  });

  it('previews the visual being approved, and an HTML one with no network until it is approved', () => {
    const html = { v: 1, entrypoint: 'index.html', files: { 'index.html': { mime: 'text/html', contentBase64: 'PGI+aGk8L2I+' } } };
    const args = (source: unknown) => ({ sessionId: 'session-1', itemId: 'visual', expectedItemRevision: null,
      destination: 'transcript', item: { v: 1, title: 'Build health', source } });
    const document = { version: 1, root: { kind: 'text', text: 'Hi' } };
    expect(resolveApprovalVisualPreview({ actionId: 'session.board.item.upsert', actionArgs: args({ kind: 'declarative', document }) }))
      .toEqual({ kind: 'declarative', title: 'Build health', document });
    expect(resolveApprovalVisualPreview({ actionId: 'session.board.item.upsert',
      actionArgs: args({ kind: 'hostedHtml', source: html, requestedCapabilities: { network: 'open', actions: [] } }) }))
      .toEqual({ kind: 'html', title: 'Build health', source: html, requestedCapabilities: { network: 'none' } });
    expect(resolveApprovalVisualPreview({ actionId: 'settings.set', actionArgs: args({ kind: 'declarative', document }) })).toBeNull();
  });

  it('carries the declared HTML height into the approval preview', () => {
    const source = { v: 1, entrypoint: 'index.html', files: { 'index.html': { mime: 'text/html', contentBase64: 'PGI+aGk8L2I+' } } };
    for (const height of [{ mode: 'fixed', size: 'compact' }, { mode: 'auto', fallback: 'tall' }]) {
      expect(resolveApprovalVisualPreview({ actionId: 'session.board.item.upsert', actionArgs: {
        item: { title: 'Build health', height, source: { kind: 'hostedHtml', source } },
      } })).toMatchObject({ kind: 'html', height });
    }
  });

  it('keeps a previewed visual’s arguments under technical details, and its network in view', () => {
    const html = { v: 1, entrypoint: 'index.html', files: { 'index.html': { mime: 'text/html', contentBase64: 'PGI+aGk8L2I+' } } };
    const rows = describeApprovalActionFields({ actionId: 'session.board.item.upsert', actionArgs: { sessionId: 'session-1',
      itemId: 'build', expectedItemRevision: null, destination: 'transcript',
      item: { v: 1, title: 'Build time', source: { kind: 'hostedHtml', source: html } } } }).rows;
    const item = rows.find((row) => row.path === 'item');
    expect(item && item.kind === 'value' && item.technical).toBe(true);
    const network = rows.find((row) => row.title === 'Network');
    expect(network && network.kind === 'value' && !network.technical).toBe(true);
  });

  it('summarizes a visual approval as what will appear and where, not as the Action’s documentation', () => {
    const summary = getActionSpec('session.board.item.upsert').approvalPresentation?.summary;
    const ask = (destination: string, expectedItemRevision: string | null = null) => summary?.({ sessionId: 'session-1',
      itemId: 'build', expectedItemRevision, destination, item: { v: 1, title: 'Build time by package',
        source: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Hi' } } } } });
    expect(ask('transcript')).toBe('Show “Build time by package” in the conversation.');
    expect(ask('board')).toBe('Show “Build time by package” on the Board.');
    expect(ask('both')).toBe('Show “Build time by package” in the conversation and on the Board.');
    expect(ask('both', 'ssr1.AAAACHN5c3JlY18xAAAAAQ')).toBe('Update “Build time by package” in the conversation and on the Board.');
  });
});

describe('workspace file approvals read as the effect, not the mechanism', () => {
  const rootPath = '/home/happier/d-dc-hello-world';
  const args = { rootPath, path: `${rootPath}/docs/getting-started.md`, content: '', expectedHash: null };

  it('summarizes a write by its file and checkout', () => {
    expect(getActionSpec('daemon.filesystem.writeFile').approvalPresentation?.summary(args))
      .toBe('Write docs/getting-started.md in d-dc-hello-world');
    expect(getActionSpec('daemon.filesystem.writeFile').approvalPresentation?.summary({ ...args, expectedHash: 'abc' }))
      .toBe('Save changes to docs/getting-started.md in d-dc-hello-world');
    expect(getActionSpec('daemon.filesystem.createDirectory').approvalPresentation?.summary({ rootPath, path: 'docs' }))
      .toBe('Create the folder docs in d-dc-hello-world');
    expect(getActionSpec('daemon.filesystem.delete').approvalPresentation?.summary({ rootPath, path: 'docs', recursive: true }))
      .toBe('Delete docs and everything in it from d-dc-hello-world');
  });

  it('shows what will be written as its size, never as base64', () => {
    const empty = describeApprovalActionFields({ actionId: 'daemon.filesystem.writeFile', actionArgs: args });
    const rows = empty.rows.filter((row) => row.kind === 'value');
    expect(empty.unrepresentable).toBeNull();
    expect(rows.find((row) => row.path === 'content')).toMatchObject({ title: 'Content', value: 'Empty file' });
    expect(rows.find((row) => row.path === 'path')).toMatchObject({ value: 'docs/getting-started.md' });
    expect(JSON.stringify(empty.rows)).not.toMatch(/base64/i);
    const sized = describeApprovalActionFields({ actionId: 'daemon.filesystem.writeFile',
      actionArgs: { ...args, content: 'aGVsbG8gd29ybGQK' } });
    expect(sized.rows.find((row) => row.path === 'content')).toMatchObject({ value: '12 bytes' });
  });
});

describe('plugin development confirmation summary', () => {
  // PLUGQA 2026-10-15: "Submit plugin development snapshot" asked "Submit plugin development snapshot."
  // — the confirmation repeated its title and never named the folder the daemon would build and run.
  it('names the exact source each plugin development Action acts on instead of repeating its title', async () => {
    const { buildApprovalPreviewSummary } = await import('./actionExecutor.js');
    const cases = [
      ['plugins.dev.submit', { projectRoot: '/home/ada/plugins/notes' }, '/home/ada/plugins/notes'],
      ['plugins.dev.unregister', { projectRoot: '/home/ada/plugins/notes' }, '/home/ada/plugins/notes'],
      ['plugins.dev.test', { projectRoot: '/home/ada/plugins/notes' }, '/home/ada/plugins/notes'],
      ['plugins.pack', { locator: '/home/ada/plugins/notes' }, '/home/ada/plugins/notes'],
      ['plugins.reload', { pluginId: 'acme.notes' }, 'acme.notes'],
    ] as const;
    for (const [actionId, input, subject] of cases) {
      const spec = getActionSpec(actionId);
      const summary = buildApprovalPreviewSummary(spec, input);
      expect(summary, actionId).toContain(subject);
      expect(summary.replace(/\.$/u, ''), actionId).not.toBe(spec.title);
    }
  });
});

describe('workspace sync approval operands', () => {
  it.each([
    'workspace.sync.relationship.disable',
    'workspace.sync.relationship.enable',
    'workspace.sync.relationship.flush',
    'workspace.sync.relationship.terminate',
  ] as const)('reads the controller machine and the linked folders of %s by reference, not as bare ids', (actionId) => {
    const presentation = describeApprovalActionFields({ actionId,
      actionArgs: { controllerMachineId: 'machine-1', relationshipId: 'relationship_abc' } });
    expect(presentation.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'controllerMachineId', reference: { kind: 'machine', id: 'machine-1' } }),
      expect.objectContaining({ path: 'relationshipId', reference: { kind: 'workspaceSyncRelationship', id: 'relationship_abc' } }),
    ]));
  });

  it('reads the source folder and target machine of a new link by reference', () => {
    const presentation = describeApprovalActionFields({ actionId: 'workspace.sync.relationship.create',
      actionArgs: { v: 1, sourceWorkspaceRefId: 'ref-1', targetMachineId: 'machine-2', targetPath: '/home/me/copy',
        mode: 'keep_synced', destinationIntent: 'use_existing', contentPolicy: { v: 1, selection: 'git_worktree',
          extraIgnorePatterns: [], extraIncludePatterns: [], policyDigest: computeWorkspaceSyncPolicyDigest({
            v: 1, selection: 'git_worktree', extraIgnorePatterns: [], extraIncludePatterns: [] }) } } });
    expect(presentation.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'sourceWorkspaceRefId', reference: { kind: 'workspace', id: 'ref-1' } }),
      expect.objectContaining({ path: 'targetMachineId', reference: { kind: 'machine', id: 'machine-2' } }),
    ]));
  });
  it('keeps raw launch environment and private connected references out of session.spawn_new observations and review', () => {
    const creation = { executionTarget: { serverId: 'home', machineId: 'machine' }, directory: { kind: 'managed' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
      environmentVariables: { API_TOKEN: 'private-environment-secret' },
      connectedServices: { v: 2, bindingsByServiceId: { 'happier.scm.forge.github/github-account': {
        source: 'connected', selection: 'profile', profileId: 'private-connected-secret' } } } };
    const input = creation;
    const spec = getActionSpec('session.spawn_new');
    expect(spec.inputSchema.safeParse(input).success).toBe(true);
    const before = structuredClone(input);
    for (const projected of [spec.projectObservationInput?.(input), spec.approvalPresentation?.projectInput?.(input)]) {
      expect(projected).toBeDefined();
      expect(JSON.stringify(projected)).not.toContain('private-environment-secret');
      expect(JSON.stringify(projected)).not.toContain('private-connected-secret');
      expect(projected)
        .toMatchObject({ executionTarget: creation.executionTarget, agentTarget: creation.agentTarget });
    }
    expect(input).toEqual(before);
  });

});
