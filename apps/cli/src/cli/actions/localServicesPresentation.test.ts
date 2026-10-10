import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalServiceActionConfirmationNonceV1 } from '@happier-dev/protocol/local/services/actions/v1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { captureConsoleText } from '@/testkit/logger/captureOutput';

import { findCompiledActionCliCommand, listCompiledActionCliCommands } from './compiledCommands';
import { loadActionCliPresentation } from './commandPresentation';
import { composeActionCliInput, parseActionCliCommandInput } from './parseCommandInput';

describe('compiled Services command presentation', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['localServices.actions.copyUrl', 'localServices.actions.openPreview',
    'localServices.launcher.openPreview', 'localServices.publicPreview.copyUrl'] as const)(
    'keeps answering-client effect %s client-placed without public Machine RPC', actionId => {
      const spec = getActionSpec(actionId);
      expect(spec.executionPlacement).toBe('client');
      expect(spec.surfaces.rpc).toBe(false);
      expect(listCompiledActionCliCommands().some(command => command.actionId === actionId)).toBe(false);
    },
  );

  it('renders observed running URL-less Services without inventing a waiting endpoint', async () => {
    const command = findCompiledActionCliCommand(['services', 'launcher', 'snapshot'], listCompiledActionCliCommands());
    expect(command?.path).toEqual(['services', 'launcher', 'snapshot']);
    if (!command) return;
    const input = { machineId: 'machine-a', scope: 'workspace', workspaceRoot: '/accepted' };
    const presentation = await loadActionCliPresentation(command.actionId);
    const output = captureConsoleText();
    try {
      expect(await presentation?.presentSuccess?.({ v: 1, machineId: 'machine-a', updatedAt: 1, targets: [{
        id: 'web', machineId: 'machine-a', source: 'managed_service', title: 'Web', confidence: 'high',
        state: 'available', serviceState: 'running', endpointKind: 'none', readiness: 'not_reported', actions: [],
      }] }, { command, input, callerInput: input, json: false })).toBe(true);
      expect(output.text()).toContain('Web');
      expect(output.text()).toContain('running');
      expect(output.text()).toContain('machine-a');
      expect(output.text()).not.toContain('waiting');
    } finally { output.restore(); }
  });

  it.each([['stop', 'stop_managed'], ['restart', 'restart_managed']] as const)(
    'binds friendly %s to its canonical action and preserves a denied receipt', async (verb, action) => {
      const command = findCompiledActionCliCommand(['services', verb], listCompiledActionCliCommands());
      expect(command?.path).toEqual(['services', verb]);
      if (!command) return;
      const target = { kind: 'managed_service' as const, managedServiceId: 'current-instance', machineId: 'machine-a', cwd: '/accepted' };
      const confirmationNonce = createLocalServiceActionConfirmationNonceV1({ requestId: 'reviewed-control', action, target, force: false });
      const parsed = parseActionCliCommandInput(command, [...command.path, '--request-id', 'reviewed-control', '--target-json', JSON.stringify(target), '--confirmation-nonce', confirmationNonce]);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const composed = composeActionCliInput({ parsed, canonicalSchema: command.spec.inputSchema,
        wholeInputSchema: command.wholeInputSchema, callerSchema: command.callerSchema, bindInput: command.spec.cli?.bindInput,
        context: { actionId: command.actionId, invocationId: 'friendly-control' } });
      expect(composed).toMatchObject({ ok: true, input: { requestId: 'reviewed-control', action, target, confirmationNonce } });
      const presentation = await loadActionCliPresentation(command.actionId);
      expect(presentation?.classifyResult?.({ v: 1, requestId: 'reviewed-control', action, status: 'denied',
        reasonCode: 'service_unavailable', auditEvents: [] }, { command, json: true, input: {}, callerInput: {} }))
        .toMatchObject({ errorCode: 'service_unavailable', details: { status: 'denied' } });
    },
  );
});
