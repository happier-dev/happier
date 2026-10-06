import { ComputerInputRequestV1Schema, ComputerTargetRequestV1Schema, ComputerTargetsListRequestV1Schema, ComputerMachineRequestV1Schema, ComputerTargetSelectRequestV1Schema, ComputerOpenSettingsRequestV1Schema } from '@happier-dev/protocol/computer/v1';
import { SURFACE_AUTHORITY_AGENT_FLOOR } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import type { ActionExecutorContext, ComputerTargetV1, RuntimeActionExecute, RuntimeActionIdV1 } from '@happier-dev/protocol';
import type { MachineLiveStreamCaptureRegistry } from '../peer/mediation/stream/captureRegistry';
import { computerTargetKey, createComputerCaptureSource } from './source';
import { createManagedComputerDriver } from './driver/managedComputerDriver';
import { createSessionImageMediaWriter } from '@/session/media/createSessionImageMediaWriter';
import { createTransferPathAllowanceRegistry } from '@/transfers/targets/createTransferPathAllowanceRegistry';
import { configuration } from '@/configuration';
import { openComputerPrivacySettings } from './privacySettings';

export type ComputerRoutes = Readonly<{
  dispatch(actionId: RuntimeActionIdV1, input: unknown, context: ActionExecutorContext): Promise<Awaited<ReturnType<RuntimeActionExecute>>>;
  closeSession(sessionId: string): Promise<void>;
  dispose(): Promise<void>;
}>;

export function createComputerRoutes(input: Readonly<{machineId: string; machineDisplayName?: string; registry: MachineLiveStreamCaptureRegistry; executablePath?: string;
  /** This machine's own desktop display (the daemon's `DISPLAY`), listed when the person names none. */
  defaultDisplayId?: string}>): ComputerRoutes {
  const writer = createSessionImageMediaWriter({ workingDirectory: configuration.happyHomeDir, storage: 'daemon',
    pathAllowanceRegistry: createTransferPathAllowanceRegistry() });
  const failure = (code: string) => ({ ok: false, errorCode: code, error: code } as const);
  const selected = (sessionId: string) => input.registry.list().find(entry => entry.computer?.sessionId === sessionId)?.computer;
  const conflictingSelection = (sessionId: string, target: ComputerTargetV1) => input.registry.list()
    .some(entry => entry.computer && entry.computer.sessionId !== sessionId && computerTargetKey(entry.computer.target) === computerTargetKey(target));
  const selection = (sessionId: string) => {
    const source = selected(sessionId);
    return { consentGranted: source?.consentGranted() ?? false,
      approvalDisplay: { machineDisplayName: input.machineDisplayName ?? input.machineId,
        requiresTargetSelection: !source,
        ...(source ? { target: { kind: source.target.kind, title: source.title }, access: source.access,
          ...(source.appName ? { appName: source.appName } : {}),
          ...(source.captureMedia() ? { captureMedia: source.captureMedia() } : {}) } : {}) },
      ...(source ? { selectedTarget: source.target, sourceId: source.sourceId, access: source.access } : {}) };
  };
  const closeSession = async (sessionId?: string) => {
    await Promise.all(input.registry.list().filter(entry => entry.computer && (!sessionId || entry.computer.sessionId === sessionId)).map(async entry => {
      const completion = await entry.computer!.close();
      // Keep physical ownership while draining, and quarantine an unconfirmed close.
      if (completion.completion === 'known' && input.registry.list().some(current => current.computer === entry.computer)) {
        input.registry.unregister(entry.sourceId);
      }
    }));
  };
  return {
    async dispatch(actionId, rawInput, context) {
      const sessionId = context.defaultSessionId;
      if (!context.authority || (!sessionId && actionId !== 'computer.permissions.openSettings')) return failure('computer_session_required');
      if (actionId === 'computer.target.close'
        && context.authority !== 'present_user') return failure('present_user_required');
      if ((actionId === 'computer.targets.list' || SURFACE_AUTHORITY_AGENT_FLOOR.some(id => id === actionId))
        && context.authority !== 'present_user' && !context.bypassApprovals) return failure('approval_required');
      const list = actionId === 'computer.targets.list';
      const parsed = (list ? ComputerTargetsListRequestV1Schema
        : actionId === 'computer.target.get' ? ComputerMachineRequestV1Schema
        : actionId === 'computer.target.select' ? ComputerTargetSelectRequestV1Schema
        : actionId === 'computer.permissions.openSettings' ? ComputerOpenSettingsRequestV1Schema : actionId === 'computer.input'
        ? ComputerInputRequestV1Schema : ComputerTargetRequestV1Schema).safeParse(rawInput);
      if (!parsed.success) return failure('invalid_parameters');
      if (parsed.data.machineId !== input.machineId) return failure('computer_machine_mismatch');
      context.signal?.throwIfAborted();
      if (actionId === 'computer.permissions.openSettings') {
        return await openComputerPrivacySettings(ComputerOpenSettingsRequestV1Schema.parse(parsed.data).permission, context.signal);
      }
      if (!sessionId) return failure('computer_session_required');
      if (actionId === 'computer.target.get') {
        const source = selected(sessionId);
        if (source && !await source.resolveTarget()) {
          const drain = await source.interrupt();
          if (drain.completion === 'unknown') return failure('control_not_drained');
          if (selected(sessionId) === source) input.registry.unregister(source.sourceId);
          await source.close();
        }
        return selection(sessionId);
      }
      if (list) {
        const request = ComputerTargetsListRequestV1Schema.parse(parsed.data);
        const displayId = request.displayId ?? input.defaultDisplayId?.trim();
        if (!displayId) return failure('computer_display_unavailable');
        let driver: Awaited<ReturnType<typeof createManagedComputerDriver>>;
        try {
          driver = await createManagedComputerDriver({ displayId, executablePath: input.executablePath });
        } catch (error) {
          // An unsupported desktop or a missing driver is the picker's typed explanation, not a thrown RPC.
          return failure(error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'native_capture_failed');
        }
        try {
          const targets = await driver.listTargets({ includeThumbnails: context.authority === 'present_user' });
          const grants = await driver.checkPermissions();
          return { targets: targets.map(({ target, title, appName, thumbnail }) => ({ target, ...(title ? { title } : {}),
            ...(appName ? { appName } : {}), ...(context.authority === 'present_user' && thumbnail ? { thumbnail } : {}) })),
            displays: { status: 'unavailable', code: 'display_enumeration_unsupported' },
            grants: { capture: grants.capture, input: grants.input } };
        } finally { await driver.close(); }
      }
      if (actionId === 'computer.target.select') {
        const request = ComputerTargetSelectRequestV1Schema.parse(parsed.data);
        const access = request.access ?? 'use';
        const existing = selected(sessionId);
        if (request.target && conflictingSelection(sessionId, request.target)) return failure('computer_target_in_use');
        if (request.target && existing && access === existing.access && computerTargetKey(request.target) === computerTargetKey(existing.target)) return selection(sessionId);
        const displayId = request.target?.displayId ?? input.defaultDisplayId?.trim();
        if (!displayId) return failure('computer_display_unavailable');
        const driver = await createManagedComputerDriver({ displayId, executablePath: input.executablePath });
        let target: ComputerTargetV1;
        let title: string | undefined;
        let appName: string | undefined;
        try {
          const targets = await driver.listTargets();
          const requestedIdentity = request.target;
          const hint = request.requestedTarget?.toLowerCase();
          const matches = requestedIdentity
            ? targets.filter(entry => computerTargetKey(entry.target) === computerTargetKey(requestedIdentity))
            : targets.filter(entry => hint && (entry.title?.toLowerCase().includes(hint) || entry.appName?.toLowerCase().includes(hint)));
          const match = matches.length === 1 ? matches[0] : undefined;
          if (!match) return failure(requestedIdentity ? 'computer_target_not_available' : 'computer_target_selection_required');
          target = match.target;
          title = match.title;
          appName = match.appName;
        } finally { await driver.close(); }
        context.signal?.throwIfAborted();
        if (conflictingSelection(sessionId, target)) return failure('computer_target_in_use');
        if (selected(sessionId) !== existing) return failure('computer_target_selection_changed');
        if (existing && access === existing.access && computerTargetKey(target) === computerTargetKey(existing.target)) return selection(sessionId);
        if (existing) {
          const drain = await existing.interrupt();
          if (drain.completion === 'unknown') return failure('control_not_drained');
          if (selected(sessionId) !== existing) return failure('computer_target_selection_changed');
          input.registry.unregister(existing.sourceId);
          await existing.close();
        }
        // Native enumeration may await: recheck the single owning registry before replacement.
        if (selected(sessionId)) return failure('computer_target_selection_changed');
        if (conflictingSelection(sessionId, target)) return failure('computer_target_in_use');
        const source = createComputerCaptureSource({ sessionId, target, title, appName, access, executablePath: input.executablePath });
        const sourceId = source.sourceId;
        input.registry.register({ sourceId, streamFamily: 'screen', computer: source, adapter: source.adapter,
          capabilities: { v: 1, sourceId, sourceKind: 'screen', supportedCodecs: ['image.frame.v1'], inputMode: 'shared', sidebands: [], health: { status: 'available' } } });
        return selection(sessionId);
      }
      const request = ComputerTargetRequestV1Schema.parse({ machineId: parsed.data.machineId,
        target: 'target' in parsed.data ? parsed.data.target : undefined,
        sourceId: 'sourceId' in parsed.data ? parsed.data.sourceId : undefined });
      const source = selected(sessionId);
      if (!source) return ['computer.capture', 'computer.query', 'computer.input'].includes(actionId)
        ? { status: 'target_selection_required', approvalDisplay: selection(sessionId).approvalDisplay }
        : failure('computer_target_not_open');
      const sourceId = source.sourceId;
      if ((request.sourceId && request.sourceId !== sourceId)
        || (request.target && computerTargetKey(request.target) !== computerTargetKey(source.target))) return failure('computer_target_selection_changed');
      if (actionId === 'computer.input' && source.access === 'see') return { target: source.target, sourceId,
        status: 'failed', code: 'computer_access_read_only' };
      if (['computer.capture', 'computer.query', 'computer.input'].includes(actionId)
        && context.authority !== 'present_user' && !source.consentGranted()) {
        if (!context.bypassApprovals) return failure('computer_consent_required');
        source.grantConsent();
      }
      const identity = { target: source.target, sourceId };
      try {
        if (actionId === 'computer.capture' || actionId === 'computer.query') {
          const observed = await source.observe(context.authority === 'present_user' ? 'human' : 'agent');
          context.signal?.throwIfAborted();
          const media = await writer.write({ sessionId, captureId: observed.captureId, png: observed.png });
          if (media.ok) source.setCaptureMedia(media.media);
          if (actionId === 'computer.query') return { ...identity, status: 'queried', accessibility: {
            status: observed.accessibility.complete ? 'complete' : observed.accessibility.nodes.length ? 'partial' : 'unavailable',
            ...(observed.accessibility.degradedReason ? { reason: observed.accessibility.degradedReason } : {}), nodes: observed.accessibility.nodes,
          } };
          return media.ok ? { ...identity, status: 'captured', captureId: observed.captureId, geometry: observed.geometry, media: media.media }
            : { ...identity, status: 'failed', code: media.disabledReason ?? 'capture_failed' };
        }
        if (actionId === 'computer.input') {
          const action = ComputerInputRequestV1Schema.parse(parsed.data);
          return await source.input(action.captureId, action.operation, context.authority === 'present_user' ? 'human' : 'agent', context.signal);
        }
        if (actionId === 'computer.control.status') return source.status();
        if (actionId === 'computer.control.interrupt') {
          const result = await source.interrupt();
          return { ...identity, status: 'interrupted', completion: result.completion };
        }
        if (actionId === 'computer.control.handBack') return source.handBack()
          ? { ...identity, status: 'dispatched' } : { ...identity, status: 'failed', code: 'control_not_drained' };
        if (actionId === 'computer.target.close') {
          const drain = await source.interrupt();
          if (drain.completion === 'unknown') return { ...identity, status: 'interrupted', completion: 'unknown' };
          if (selected(sessionId) !== source) return failure('computer_target_selection_changed');
          input.registry.unregister(sourceId);
          const result = await source.close();
          return result.completion === 'unknown' ? { ...identity, status: 'interrupted', completion: 'unknown' }
            : { ...identity, status: 'dispatched' };
        }
        return failure('unsupported_action');
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'native_capture_failed';
        if (code === 'target_not_found' || code === 'target_mismatch') {
          input.registry.unregister(sourceId);
          await source.close();
        }
        return { ...identity, status: 'failed', code };
      }
    },
    closeSession,
    dispose: () => closeSession(),
  };
}
