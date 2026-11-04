import { describe, expect, it } from 'vitest';
import { ActionIdSchema } from './actionIds.js';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { listActionSpecsForCatalogSurface } from './actionCatalog.js';
import { DeploymentLogsReadSuccessV1Schema } from '../deployments/deploymentReadsV1.js';

const reference = { serverId: 'home', environmentId: 'env', deploymentId: 'deploy', targetLinkId: 'target',
  machineId: 'machine', installationId: 'installation', kind: 'build', ref: 'step/build' } as const;
const context = { surface: 'ui', authority: 'present_user', runtimeAccountId: 'owner', serverId: 'home',
  actionCaller: { kind: 'host' } } as const;

describe('client file save Action', () => {
  it('exports finite deployment pages through the existing masked reader for UI and automation', async () => {
    const actionId = ActionIdSchema.parse('files.save');
    for (const surface of ['ui', 'agent', 'mcp', 'cli'] as const) {
      expect(listActionSpecsForCatalogSurface({ surface }).some(spec => spec.id === actionId)).toBe(true);
    }
    const saved: string[] = [];
    const reads: unknown[] = [];
    // Both adapters cross genuine process boundaries: Machine Action transport and client file chooser.
    const actions = createActionExecutor({
      deploymentAction: async (id, input) => {
        expect(id).toBe('deployments.logs.read');
        reads.push(input);
        const second = 'cursor' in input && input.cursor !== undefined;
        const { serverId: _serverId, ref: _ref, kind: _kind, ...target } = reference;
        return DeploymentLogsReadSuccessV1Schema.parse({ ...target,
          ok: true, kind: 'build', logs: { kind: 'page', page: {
            sourceRevision: 'revision', text: second ? '🌍\n' : 'secret=***\n', truncated: false,
            nextCursor: second ? null : { sourceRevision: 'revision', token: 'next' },
          } } });
      },
      saveClientFile: async ({ bytes }) => { saved.push(new TextDecoder().decode(bytes)); return { status: 'saved' }; },
    } as ActionExecutorDeps);
    expect(await actions.execute(actionId, { fileName: 'build.log', source: { kind: 'deploymentLog', reference } }, context))
      .toEqual({ ok: true, result: { status: 'saved' } });
    expect(saved).toEqual(['secret=***\n🌍\n']);
    expect(reads).toEqual([reference, { ...reference, cursor: { sourceRevision: 'revision', token: 'next' } }]);
    expect(await actions.executeAdmittedClientAction(actionId,
      { fileName: 'loaded.log', source: { kind: 'text', text: 'loaded ***' } }, { ...context, surface: 'agent' }))
      .toEqual({ ok: true, result: { status: 'saved' } });
    expect(saved).toEqual(['secret=***\n🌍\n', 'loaded ***']);
  });

  it('preserves a deployment reader refusal without saving a file', async () => {
    const actionId = ActionIdSchema.parse('files.save');
    const saved: unknown[] = [];
    const actions = createActionExecutor({
      deploymentAction: async () => ({ ok: false, error: 'deployment_access_denied' }),
      saveClientFile: async input => { saved.push(input); return { status: 'saved' }; },
    } as ActionExecutorDeps);
    expect(await actions.execute(actionId, { fileName: 'build.log', source: { kind: 'deploymentLog', reference } }, context))
      .toMatchObject({ ok: false, errorCode: 'deployment_access_denied' });
    expect(saved).toEqual([]);
  });

  it('refuses a changed source instead of handing off a partial log', async () => {
    const saved: unknown[] = [];
    const { serverId: _serverId, ref: _ref, kind: _kind, ...target } = reference;
    const actions = createActionExecutor({
      deploymentAction: async () => DeploymentLogsReadSuccessV1Schema.parse({ ...target,
        ok: true, kind: 'build', logs: { kind: 'source-changed', sourceRevision: 'replacement' } }),
      saveClientFile: async input => { saved.push(input); return { status: 'saved' }; },
    } as ActionExecutorDeps);
    expect(await actions.execute('files.save', { fileName: 'build.log', source: { kind: 'deploymentLog', reference } }, context))
      .toMatchObject({ ok: false, errorCode: 'source_changed' });
    expect(saved).toEqual([]);
  });
});
