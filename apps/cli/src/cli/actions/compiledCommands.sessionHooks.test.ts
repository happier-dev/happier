import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { findCompiledActionCliCommand } from './compiledCommands';
import { composeActionCliInput, parseActionCliCommandInput } from './parseCommandInput';
import { readTransportMachineId, stripTransportTokens } from './executeCommand';
import { resolveAdmittedActionCliCommand } from '../commandRegistry';

describe('Session hook CLI Action parity', () => {
  it.each(['install', 'disable', 'enable', 'uninstall'] as const)('admits %s through its generated route and retains approval before the hook transport', async intent => {
    const actionId = `plugins.sessionHooks.${intent}` as const;
    const command = findCompiledActionCliCommand(['plugins', 'session-hooks', intent]);
    expect(command?.actionId).toBe(actionId);
    if (!command) throw new Error('Missing Session hook CLI route');
    const input = { agent: { pluginId: 'happier.agent.codex', localId: 'codex' },
      ...(intent === 'install' ? { expectedPreviewId: `hook-install-preview:v1:${'a'.repeat(64)}` } : { installationId: 'installation-1' }) };
    const argv = [...command.path, '--machine-id', 'machine-1', '--input-json', JSON.stringify(input)];
    expect((await resolveAdmittedActionCliCommand(argv))?.actionId).toBe(actionId);
    const machineId = readTransportMachineId(command, argv);
    expect(machineId).toBe('machine-1');
    const parsed = parseActionCliCommandInput(command, stripTransportTokens(command, argv));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.message);
    const bound = composeActionCliInput({ parsed, canonicalSchema: command.spec.inputSchema,
      wholeInputSchema: command.wholeInputSchema, callerSchema: command.callerSchema, bindInput: command.spec.cli?.bindInput,
      context: { actionId, invocationId: 'hook-cli', commandPath: command.path } });
    expect(bound).toMatchObject({ ok: true, input });
    if (!bound.ok) throw new Error('Invalid Session hook input');
    // This is the outward daemon/OS hook boundary. Routing, schemas and approval stay real.
    const requests: unknown[] = [];
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      isActionApprovalRequired: (id, context, actionInput) => isApprovalRequiredByActionsSettings(id,
        context.actionsSettings ?? normalizeActionsSettingsV1({ v: 1 }), context, undefined, undefined, actionInput),
      pluginSessionHookManagementAction: async request => {
        requests.push(request);
        return { ok: false, errorCode: 'hook_fixture_refusal', error: 'hook_fixture_refusal' };
      },
    });
    const context = { surface: 'cli', authority: 'present_user', serverId: 'home-1',
      externalActionTarget: { kind: 'machine', machineId: machineId! } } as const;
    expect(await executor.execute(actionId, bound.input, context))
      .toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    expect(requests).toEqual([]);
    expect(await executor.execute(actionId, bound.input, { ...context, actionsSettings: normalizeActionsSettingsV1({
      v: 1, approvalWaivedSurfaces: { [actionId]: ['cli'] },
    }) }))
      .toMatchObject({ ok: false, errorCode: 'hook_fixture_refusal' });
    expect(requests).toEqual([expect.objectContaining({ actionId, input, serverId: 'home-1' })]);
  });
});
