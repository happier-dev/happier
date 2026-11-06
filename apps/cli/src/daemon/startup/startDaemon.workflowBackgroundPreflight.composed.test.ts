import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { WorkflowInvocationListResultV1Schema, WorkflowRunWaitResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { startInstalledDaemonFixture } from '@/daemon/testkit/installedDaemon.testkit';
import { createFirstConversationAgentFixture } from '@/daemon/testkit/firstConversationAgent.testkit';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { mutateQualifiedConnectedAccountCredentialV4 } from '@/api/client/qualifiedConnectedAccountApi';
import { sealQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol/connect/qualifiedConnectedAccountContentEnvelope';

let f: Awaited<ReturnType<typeof startInstalledDaemonFixture>>;
let stopDaemon: (() => Promise<void>) | undefined;
beforeAll(async () => {
  const agent = createFirstConversationAgentFixture('WORKFLOW_BACKGROUND_INPUT');
  const plugin = {
    manifest: createPluginManifestV2Fixture({ ...agent.manifest,
      hostAccess: { ...agent.manifest.hostAccess, required: [...(agent.manifest.hostAccess?.required ?? []), {
        id: 'provider-token', capability: 'environment', reason: 'Materialize the selected requester credential',
        scope: { keys: ['WORKFLOW_PROVIDER_TOKEN'] },
      }] },
      contributes: { ...agent.manifest.contributes,
        agents: agent.manifest.contributes.agents?.map(definition => ({ ...definition,
          connectedAccounts: [{ purpose: 'primary', service: 'upstream', required: false, materializationKinds: ['environment'] }],
        })),
        connectedAccountDescriptors: [{ id: 'upstream', title: 'Workflow provider', authentication: {
          defaultModeId: 'token', modes: [{ id: 'token', kind: 'manual', outcomeReconciliation: 'none',
            fields: [{ id: 'token', title: 'Token', schema: { type: 'string', minLength: 1 }, secret: true }] }],
        } }],
      },
    }),
    files: { ...agent.files,
      'agent-daemon.mjs': agent.files['daemon.mjs']
        .replace("sessionRunnerFactory:", "connectedAccountLaunch: { environmentUses: [{ purpose: 'primary', environmentKey: 'WORKFLOW_PROVIDER_TOKEN' }] }, sessionRunnerFactory:"),
      'daemon.mjs': `import { activate as activateAgent } from './agent-daemon.mjs';
      export function activate(api) { activateAgent(api); api.connectedAccounts.register('upstream', {
        authentication: { modes: { token: { kind: 'manual', async complete() { return { status: 'connected' }; } } } },
        async status() { return { status: 'connected', scopes: [] }; },
        async refresh() { return { status: 'connected', scopes: [] }; },
        async revoke() { return { status: 'remoteUnsupported' }; },
        async materialize(request, context) {
          if (request.kind !== 'environment' || await context.credentials.get('token') !== 'guest-provider-only') throw new Error('Wrong requester provider credential');
          return { kind: 'environment', env: { WORKFLOW_PROVIDER_TOKEN: 'guest-provider-only' } };
        },
      }); }`,
    },
  };
  // The Home fixture seeds the legacy minimal stored Machine metadata before
  // the installed daemon reconnects; no setup-desired projection is required.
  f = await startInstalledDaemonFixture({
    plugins: [plugin],
    registerCleanup: cleanup => { stopDaemon = cleanup; },
  });
}, 120_000);
afterAll(async () => { await stopDaemon?.(); }, 120_000);

it('finishes an owner background Role and keeps shared requester Run custody in its own Account', async () => {
    const context = { surface: 'rpc' as const, authority: 'present_user' as const, serverId: f.serverId,
      externalActionTarget: { kind: 'machine' as const, machineId: f.machineId,
        project: { machineId: f.machineId, directory: f.directory } } };
    const agentTarget = { kind: 'agent' as const, identity: { pluginId: 'acme.project-launch', localId: 'agent' } };
    const request = (runId: string, connected = false) => ({ runId, executionTarget: { kind: 'session' as const }, source: { kind: 'inline' as const,
      definition: { version: 1 as const, inputs: [], defaults: {
        agentTarget,
        connectedServices: connected ? { v: 2 as const, bindingsByServiceId: {
          'acme.project-launch/upstream': { source: 'connected' as const, selection: 'profile' as const, profileId: 'guest-provider' },
        } } : null, conversation: { kind: 'fresh' as const },
      }, roles: [{ roleId: 'builder', name: 'Builder', instructions: '',
        engine: { agentTargetKey: buildBackendTargetKeyV2(agentTarget) },
        runsAs: { kind: 'background_run' as const, intent: 'task' as const } }],
      blocks: [
        { kind: 'step' as const, id: 'background', document: { text: 'WORKFLOW_BACKGROUND_INPUT', references: [], attachments: [] },
          input: [], execution: { engine: { role: 'builder' } }, result: { kind: 'text' as const } },
      ] },
    } });
    const runId = randomUUID();
    const executor = f.createActionExecutor();
    const started = await executor.execute('workflow.run.start', request(runId), context);
    expect(started, JSON.stringify(started)).toMatchObject({ ok: true });
    const settled = await executor.execute('workflow.run.wait', { runId, timeoutSeconds: 60 }, context);
    expect(settled, JSON.stringify(settled)).toMatchObject({ ok: true });
    if (!settled.ok) throw new Error('Workflow observation refused');
    const listed = await executor.execute('workflow.run.invocations.list', { runId, includeContent: true }, context);
    expect(listed, JSON.stringify(listed)).toMatchObject({ ok: true });
    if (!listed.ok) throw new Error('Workflow persisted invocation read refused');
    const details = WorkflowInvocationListResultV1Schema.parse(listed.result).invocationDetails;
    const background = details?.find(detail => detail.progress.invocationPath.blockId === 'background');
    expect(background?.index.lifecycle, background?.progress.reason?.code).toBe('completed');
    expect(background?.progress).toMatchObject({ execution: { kind: 'detached_run' } });
    expect(JSON.stringify(background?.progress.result)).toContain('git version ');
    expect(WorkflowRunWaitResultV1Schema.parse(settled.result)).toMatchObject({
      observation: 'terminal', run: { id: runId, state: 'succeeded' },
    });

    const effects = await f.home.readWorkflowSessionEffects();
    expect(effects.runs.find(run => run.id === runId)).toMatchObject({ accountId: f.home.accountId, state: 'succeeded' });

    const member = await f.home.createMachineMember('admin');
    await mutateQualifiedConnectedAccountCredentialV4({ token: member.token, mutation: {
      ref: { service: { pluginId: 'acme.project-launch', localId: 'upstream' }, accountId: 'guest-provider' },
      authenticationModeId: 'token', expectedCredentialRevision: null, metadata: { scopes: [] },
      content: sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'plain',
        payload: { v: 1, values: { token: 'guest-provider-only' } }, randomBytes: size => new Uint8Array(size) }),
    } });
    const guest = f.createActionExecutor(member);
    const guestRunId = randomUUID();
    const guestStarted = await guest.execute('workflow.run.start', request(guestRunId, true), context);
    expect(guestStarted, JSON.stringify(guestStarted)).toMatchObject({ ok: true });
    const guestRead = await guest.execute('workflow.run.get', { runId: guestRunId, includeUsage: false }, context);
    expect(guestRead, JSON.stringify(guestRead))
      .toMatchObject({ ok: true, result: { run: { id: guestRunId } } });
    let guestSettled = await guest.execute('workflow.run.wait', { runId: guestRunId, timeoutSeconds: 60 }, context);
    while (guestSettled.ok && WorkflowRunWaitResultV1Schema.parse(guestSettled.result).observation === 'timeout'
      && WorkflowRunWaitResultV1Schema.parse(guestSettled.result).run.state === 'running') {
      guestSettled = await guest.execute('workflow.run.wait', { runId: guestRunId, timeoutSeconds: 60 }, context);
    }
    expect(guestSettled, JSON.stringify(guestSettled)).toMatchObject({ ok: true });
    if (!guestSettled.ok) throw new Error('Guest Workflow observation refused');
    const guestListed = await guest.execute('workflow.run.invocations.list', { runId: guestRunId, includeContent: true }, context);
    expect(guestListed, JSON.stringify(guestListed)).toMatchObject({ ok: true });
    if (!guestListed.ok) throw new Error('Guest Workflow persisted invocation read refused');
    const guestBackground = WorkflowInvocationListResultV1Schema.parse(guestListed.result).invocationDetails
      ?.find(detail => detail.progress.invocationPath.blockId === 'background');
    expect(guestBackground?.index.lifecycle, JSON.stringify({ guestSettled,
      reason: guestBackground?.progress.reason?.code })).toBe('completed');
    expect(guestBackground?.progress).toMatchObject({ execution: { kind: 'detached_run' } });
    expect(JSON.stringify(guestBackground?.progress.result)).toContain('git version ');
    expect(WorkflowRunWaitResultV1Schema.parse(guestSettled.result)).toMatchObject({
      observation: 'terminal', run: { id: guestRunId, state: 'succeeded' },
    });
    expect(await executor.execute('workflow.run.get', { runId: guestRunId, includeUsage: false }, context))
      .toMatchObject({ ok: false, errorCode: 'run_not_found' });
    expect(await guest.execute('workflow.run.get', { runId, includeUsage: false }, context))
      .toMatchObject({ ok: false, errorCode: 'run_not_found' });
    const sharedEffects = await f.home.readWorkflowSessionEffects();
    expect(sharedEffects.runs.find(run => run.id === guestRunId)).toMatchObject({ accountId: member.accountId, state: 'succeeded' });
}, 120_000);
