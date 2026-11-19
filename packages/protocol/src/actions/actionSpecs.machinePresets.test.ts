import { describe, expect, it } from 'vitest';
import { MACHINE_PRESET_HTTP_ACTION_IDS_V1, MACHINE_PRESET_PREPARE_ACTION_ID_V1 } from '../machines/managed/machinePresetActionsV1.js';
import { ACTION_IDS } from './actionIds.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import { resolveApprovalRequestApproveAdmission } from './actionApprovalPresentation.js';
import { createActionExecutor } from './actionExecutor.js';
import type { ApprovalRequestV2 } from '../approvals/approvalRequestV1.js';
import { doesExternalActionConsumeRequesterAccountContentV1, getActionSpec, listActionCliCommandDeclarations, listVoiceToolActionSpecs, PLUGIN_INVOCABLE_ACTION_IDS, PUBLIC_ACTION_IDS } from './actionSpecs.js';

describe('personal and Team Machine preset Actions', () => {
  it('delegates private preset content only to the admitted native Archive host', () => {
    const request = { actionId: 'machines.presets.archive', input: { homeId: 'home', id: 'preset', expectedRevision: 1 } };
    expect(doesExternalActionConsumeRequesterAccountContentV1(request)).toBe(false);
    expect(doesExternalActionConsumeRequesterAccountContentV1({ ...request, target: { kind: 'machine', machineId: 'original-host' } })).toBe(true);
    expect(doesExternalActionConsumeRequesterAccountContentV1({ ...request, actionId: 'machines.presets.restore',
      target: { kind: 'machine', machineId: 'ambient-host' } })).toBe(false);
  });

  it('runs Archive through its admitted cleanup owner while Restore uses the ordinary preset transport', async () => {
    const effects: string[] = [];
    const input = { homeId: 'home', id: 'preset', expectedRevision: 1 };
    const executor = createActionExecutor({
      machinePresetArchive: async request => {
        expect(request.input).toEqual(input);
        effects.push('cleanup-and-archive');
        return { kind: 'refused', code: 'provider_unavailable' };
      },
      machinePresetAction: async request => {
        effects.push(request.actionId);
        return { kind: 'refused', code: 'preset_not_found' };
      },
    });
    for (const actionId of ['machines.presets.archive', 'machines.presets.restore'] as const) {
      expect(await executor.execute(actionId, input, { surface: 'cli', authority: 'present_user',
        presentUserConfirmation: { actionId } })).toMatchObject({ ok: true, result: { kind: 'refused' } });
    }
    expect(effects).toEqual(['cleanup-and-archive', 'machines.presets.restore']);
  });
  it('executes Prepare through the installed Machine operation owner', async () => {
    const input = { homeId: 'home', id: 'preset', expectedRevision: 0, machineId: 'builder' };
    const accepted = { status: 'accepted', operationId: 'prepare-operation', machineId: 'builder' };
    const executor = createActionExecutor({ machinePresetPrepare: async request => {
      expect(request.input).toEqual(input);
      return accepted;
    } });
    const actionId = MACHINE_PRESET_PREPARE_ACTION_ID_V1;
    expect(await executor.execute(actionId, input, { surface: 'cli', authority: 'present_user',
      presentUserConfirmation: { actionId } })).toEqual({ ok: true, result: accepted });
  });
  it('admits Prepare as a Machine operation and refuses an uninstalled executor without a preset HTTP mutation', async () => {
    let httpMutations = 0;
    const executor = createActionExecutor({ machinePresetAction: async () => {
      httpMutations += 1;
      throw new Error('Prepare must not use the preset HTTP transport');
    } });
    const actionId = MACHINE_PRESET_PREPARE_ACTION_ID_V1;
    const input = { homeId: 'home', id: 'preset', expectedRevision: 0, machineId: 'builder' };
    expect(await executor.execute(actionId, input, { surface: 'cli', authority: 'present_user',
      presentUserConfirmation: { actionId } })).toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    expect(httpMutations).toBe(0);
    const spec = getActionSpec(actionId);
    expect(spec).toMatchObject({ executionPlacement: 'machine', sideEffectClass: 'danger',
      operation: { version: 1, visibility: 'activity', progress: 'reported' } });
    expect(spec.serverTransport).toBeUndefined();
    expect(spec.inputSchema.parse(input)).toEqual(input);
    expect(spec.outputSchema.parse({ status: 'accepted', operationId: 'host-operation', machineId: 'builder' }))
      .toEqual({ status: 'accepted', operationId: 'host-operation', machineId: 'builder' });
  });
  it.each(['machines.presets.create', 'machines.presets.update'] as const)('replays %s with the name in its strict content carrier', actionId => {
    const content = { t: 'plain', v: { v: 1, name: 'Reviewed preset',
      setup: { scripts: [{ body: 'echo ready', affects: 'none' }] } } };
    const spec = getActionSpec(actionId);
    const actionArgs = spec.inputSchema.parse(actionId === 'machines.presets.create'
      ? { homeId: 'home', id: 'preset', owner: { kind: 'account', accountId: 'owner' },
        contentEncryptionMode: 'plain', content, recipients: [] }
      : { homeId: 'home', id: 'preset', expectedRevision: 1, patch: { content } });
    const request: ApprovalRequestV2 = { v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'cli' }, requestedSurface: 'cli', actionId, actionArgs, summary: spec.title,
      executionOriginV1: { v: 1, authority: 'account_automation', caller: { kind: 'host' }, requestId: 'request',
        surface: 'cli', serverId: 'home', actionId } };
    const admission = resolveApprovalRequestApproveAdmission(request);
    expect(admission).toMatchObject({ status: 'available' });
    expect(admission.presentation.rows).toContainEqual(expect.objectContaining({
      path: actionId === 'machines.presets.create' ? 'content.v' : 'patch.content.v', value: JSON.stringify(content.v),
    }));
    expect(spec.inputSchema.safeParse({ ...actionArgs, name: 'Obsolete top-level name' }).success).toBe(false);
  });
  it.each(['machines.presets.create', 'machines.presets.update'] as const)('reviews %s encrypted carriers without exposing ciphertext or requiring an opened name', actionId => {
    // The encrypted transport boundary carries opaque secretbox-sized bytes.
    const content = { t: 'encrypted', c: Buffer.alloc(64, 7).toString('base64') };
    const spec = getActionSpec(actionId);
    const actionArgs = spec.inputSchema.parse(actionId === 'machines.presets.create'
      ? { homeId: 'home', id: 'preset', owner: { kind: 'account', accountId: 'owner' },
        contentEncryptionMode: 'e2ee', content, recipients: [] }
      : { homeId: 'home', id: 'preset', expectedRevision: 1, patch: { content } });
    const request: ApprovalRequestV2 = { v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'cli' }, actionId, actionArgs, summary: spec.title };
    const admission = resolveApprovalRequestApproveAdmission(request);
    expect(admission).toMatchObject({ status: 'available' });
    expect(JSON.stringify(admission.presentation)).not.toContain(content.c);
  });
  it('carries every exact-Home intent through the canonical headless catalog and asks before mutation', () => {
    const commands = new Map(listActionCliCommandDeclarations().map(({ spec, binding }) => [spec.id, binding.path]));
    const voice = new Set(listVoiceToolActionSpecs().map(spec => spec.id));
    for (const id of MACHINE_PRESET_HTTP_ACTION_IDS_V1) {
      expect(ACTION_IDS).toContain(id);
      expect(PUBLIC_ACTION_IDS).toContain(id);
      expect(PLUGIN_INVOCABLE_ACTION_IDS).toContain(id);
      const read = id === 'machines.presets.list' || id === 'machines.presets.get';
      const spec = getActionSpec(id);
      expect(spec).toMatchObject({ executionPlacement: 'account', sideEffectClass: read ? 'read' : 'danger',
        surfaces: { ui: true, agent: true, cli: true, mcp: true, voice: true },
        serverTransport: { method: 'POST', path: `/v1/machines/presets/${id.split('.').at(-1)}` } });
      expect(commands.get(id)).toEqual(id.split('.'));
      expect(voice.has(id)).toBe(true);
      if (!read) expect(resolveActionApprovalRouting({ actionId: id, spec, context: { surface: 'agent' } }).required).toBe(true);
    }
  });
});
