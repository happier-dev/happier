import { describe, expect, it } from 'vitest';
import { describeApprovalActionFields } from './actionApprovalPresentation.js';
import { getActionSpec } from './actionSpecs.js';

describe('Saved Secret approval operands', () => {
  it('reads every declared secret reference in binding rows while preserving binding context and literal values', () => {
    const first = 'happier:shared-secret:v1:first';
    const second = 'happier:shared-secret:v1:second';
    const actionId = 'deployments.bindings.set';
    const actionArgs = getActionSpec(actionId).inputSchema.parse({ serverId: 'home', environmentId: 'environment', expectedRevision: 1,
      set: [
        { purpose: 'variable', name: 'FIRST_KEY', phase: 'runtime', source: { kind: 'secret', ref: first, resourceRevision: 1 } },
        { purpose: 'variable', name: 'SECOND_KEY', phase: 'build', source: { kind: 'secret', ref: second, resourceRevision: 2 } },
        { purpose: 'variable', name: 'PUBLIC_VALUE', phase: 'runtime', source: { kind: 'value', value: first } },
      ], remove: [] });
    const presentation = describeApprovalActionFields({ actionId, actionArgs });
    expect(presentation.unrepresentable).toBeNull();
    const row = presentation.rows.find(row => row.kind === 'value' && row.path === 'set');
    if (row?.kind !== 'value') throw new Error('Missing binding context');
    expect(row.entries?.filter(entry => entry.reference?.kind === 'savedSecret').map(entry => entry.reference))
      .toEqual([{ kind: 'savedSecret', id: first }, { kind: 'savedSecret', id: second }]);
    expect(row.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: 'FIRST_KEY' }), expect.objectContaining({ value: 'SECOND_KEY' }),
      expect.objectContaining({ label: 'Value', value: first }),
    ]));
    expect(row.entries?.find(entry => entry.label === 'Value')).not.toHaveProperty('reference');
  });

  it('keeps the existing top-level Saved Secret reading', () => {
    const actionId = 'providers.connections.secrets.bind';
    const actionArgs = getActionSpec(actionId).inputSchema.parse({ action: 'bindSecret', connectionId: 'provider',
      credentialSlotId: 'apiKey', savedSecretId: 'saved-key', scope: 'account' });
    expect(describeApprovalActionFields({ actionId, actionArgs }).rows).toContainEqual(expect.objectContaining({
      path: 'savedSecretId', reference: { kind: 'savedSecret', id: 'saved-key' },
    }));
  });

  it.each(['deployments.templates.instantiate', 'deployments.environments.create'] as const)(
    'reads the same binding operand in %s', actionId => {
      const bindings = [{ purpose: 'variable', name: 'API_KEY', phase: 'runtime',
        source: { kind: 'secret', ref: 'happier:shared-secret:v1:catalog-key', resourceRevision: 1 } }];
      const templateRef = { sourceId: 'apps', itemId: 'service', version: '1', ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } };
      const creation = { name: 'Service', requestKey: 'create-service', protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers' };
      const actionArgs = getActionSpec(actionId).inputSchema.parse(actionId === 'deployments.templates.instantiate'
        ? { mode: 'apply', serverId: 'home', machineId: 'machine', projectSourceId: 'source', templateRef,
          environment: { kind: 'create', ...creation, controllerMachineId: 'machine' }, target: { kind: 'new', installationId: 'installation' },
          destination: { kind: 'stored' }, bindings }
        : { mode: 'apply', serverId: 'home', projectSourceId: 'source', ...creation, definition: { from: 'catalogApp', templateRef }, bindings });
      const row = describeApprovalActionFields({ actionId, actionArgs }).rows.find(row => row.kind === 'value' && row.path === 'bindings');
      if (row?.kind !== 'value') throw new Error('Missing binding context');
      expect(row.entries).toContainEqual(expect.objectContaining({ reference: { kind: 'savedSecret', id: 'happier:shared-secret:v1:catalog-key' } }));
    },
  );
});
