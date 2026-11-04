import { ComputerClipboardWriteRequestV1Schema } from '@happier-dev/protocol/computer/v1';
import { ComputerInputRequestV1Schema, ComputerTargetRequestV1Schema, ComputerTargetsListRequestV1Schema, ComputerMachineRequestV1Schema, ComputerTargetSelectRequestV1Schema, ComputerOpenSettingsRequestV1Schema, resolveComputerAccess } from '@happier-dev/protocol/computer/v1';
import type { ActionExecutorContext, ComputerTargetV1, RuntimeActionExecute, RuntimeActionIdV1 } from '@happier-dev/protocol';
import type { MachineLiveStreamCaptureRegistry } from '../peer/mediation/stream/captureRegistry';
import { computerTargetKey, createComputerCaptureSource } from './source';
import { ComputerDriverError, createManagedComputerDriver, resolveComputerDisplayId } from './driver/managedComputerDriver';
import { createSessionImageMediaWriter } from '@/session/media/createSessionImageMediaWriter';
import { createTransferPathAllowanceRegistry } from '@/transfers/targets/createTransferPathAllowanceRegistry';
import { configuration } from '@/configuration';
import { openComputerPrivacySettings } from './privacySettings';
import { createComputerDesktop } from './desktop';
import type { ComputerProviderIdV1, ComputerUseSettingsV1 } from '@happier-dev/protocol/computer/v1';
import { ComputerProviderUnavailableError, resolveComputerProvider, resolveComputerProviderId } from './driver/provider';

export type ComputerRoutes = Readonly<{
  dispatch(actionId: RuntimeActionIdV1, input: unknown, context: ActionExecutorContext): Promise<Awaited<ReturnType<RuntimeActionExecute>>>;
  closeSession(sessionId: string): Promise<void>;
  dispose(): Promise<void>;
}>;

export function createComputerRoutes(input: Readonly<{machineId: string; machineDisplayName?: string; registry: MachineLiveStreamCaptureRegistry; executablePath?: string;
  resolveProviderSettings?: () => ComputerUseSettingsV1;
  /** Default X11 connection; the driver owner resolves native Windows/macOS/Wayland defaults. */
  defaultDisplayId?: string}>): ComputerRoutes {
  const writer = createSessionImageMediaWriter({ workingDirectory: configuration.happyHomeDir, storage: 'daemon',
    pathAllowanceRegistry: createTransferPathAllowanceRegistry() });
  const failure = (code: string, message = code) => ({ ok: false, errorCode: code, error: message } as const);
  const nativeFailure = (error: unknown) => error instanceof ComputerProviderUnavailableError ? {
    ...failure(error.code, error.message),
    provider: error.provider, installableKey: error.installableKey, capabilityId: error.capabilityId,
    installHint: { actionId: 'machines.capabilities.install', capabilityId: error.capabilityId },
  } : error instanceof ComputerDriverError ? failure(error.code, error.message)
    : failure(error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'native_capture_failed');
  const selected = (sessionId: string, provider: ComputerProviderIdV1) => input.registry.list()
    .find(entry => entry.computer?.sessionId === sessionId && entry.computer.provider === provider)?.computer;
  const desktop = createComputerDesktop();
  const resolveConnection = async (requestedDisplayId?: string): Promise<Readonly<{
    displayId: string; environment?: Readonly<Record<string, string>>;
  }>> => {
    const current = desktop.current();
    const displayId = resolveComputerDisplayId(requestedDisplayId, input.defaultDisplayId) ?? current?.displayId;
    if (!displayId && process.platform === 'linux') return await desktop.ensure();
    if (!displayId) throw new ComputerDriverError('computer_display_unavailable');
    if (current && displayId.replace(/\.0$/, '') === current.displayId) {
      return { ...await desktop.ensure(), displayId };
    }
    return { displayId };
  };
  const inputDisplayKey = (displayId: string) => {
    // X11 :N and :N.0 address the same screen. Wire source identities stay exact,
    // but aliases cannot admit a second controller for the same physical input.
    const x11 = process.platform === 'linux' ? /^:(\d+)(?:\.(\d+))?$/.exec(displayId) : null;
    const wayland = process.platform === 'linux' ? process.env.WAYLAND_DISPLAY?.trim() : undefined;
    const inheritedX11 = wayland ? /^:(\d+)(?:\.(\d+))?$/.exec(process.env.DISPLAY ?? '') : null;
    // The inherited XWayland connection belongs to this same compositor.
    // Explicit unrelated X11 desktops (for example Xvfb) stay independent.
    if (x11 && inheritedX11 && Number(x11[1]) === Number(inheritedX11[1])
      && Number(x11[2] ?? 0) === Number(inheritedX11[2] ?? 0)) return wayland;
    return x11 ? JSON.stringify([Number(x11[1]), Number(x11[2] ?? 0)]) : displayId;
  };
  const conflictingSelection = (sessionId: string, provider: ComputerProviderIdV1, target: ComputerTargetV1) => input.registry.list()
    .some(entry => entry.computer && entry.computer.sessionId !== sessionId
      && inputDisplayKey(entry.computer.target.displayId) === inputDisplayKey(target.displayId)
      && (entry.computer.provider !== provider || entry.computer.target.kind === 'display' || target.kind === 'display'
        || (entry.computer.target.pid === target.pid && entry.computer.target.windowId === target.windowId)));
  const selection = (sessionId: string, provider: ComputerProviderIdV1) => {
    const source = selected(sessionId, provider);
    return { provider, consentGranted: source?.consentGranted() ?? false,
      approvalDisplay: { machineDisplayName: input.machineDisplayName ?? input.machineId,
        requiresTargetSelection: !source,
        ...(source ? { target: { kind: source.target.kind, title: source.title }, access: source.access,
          ...(source.appName ? { appName: source.appName } : {}),
          ...(source.captureMedia() ? { captureMedia: source.captureMedia() } : {}) } : {}) },
      ...(source ? { selectedTarget: source.target, sourceId: source.sourceId, access: source.access } : {}) };
  };
  const closeSession = async (sessionId?: string) => {
    await Promise.all(input.registry.list().filter(entry => entry.computer && (!sessionId || entry.computer.sessionId === sessionId)).map(async entry => {
      await entry.computer!.close();
      // Source close proves process retirement; prior input remains historically unknown.
      if (input.registry.list().some(current => current.computer === entry.computer)) {
        input.registry.unregister(entry.sourceId);
      }
    }));
  };
  return {
    async dispatch(actionId, rawInput, context) {
      const sessionId = context.defaultSessionId;
      if (!context.authority || (!sessionId && actionId !== 'computer.permissions.openSettings')) return failure('computer_session_required');
      const clipboard = actionId === 'computer.clipboard.read' || actionId === 'computer.clipboard.write';
      if (clipboard && context.authority !== 'present_user') return failure('present_user_required');
      const list = actionId === 'computer.targets.list';
      const parsed = (list ? ComputerTargetsListRequestV1Schema
        : actionId === 'computer.target.get' ? ComputerMachineRequestV1Schema
        : actionId === 'computer.target.select' ? ComputerTargetSelectRequestV1Schema
        : actionId === 'computer.permissions.openSettings' ? ComputerOpenSettingsRequestV1Schema
        : actionId === 'computer.clipboard.write' ? ComputerClipboardWriteRequestV1Schema : actionId === 'computer.input'
        ? ComputerInputRequestV1Schema : ComputerTargetRequestV1Schema).safeParse(rawInput);
      if (!parsed.success) return failure('invalid_parameters');
      if (parsed.data.machineId !== input.machineId) return failure('computer_machine_mismatch');
      context.signal?.throwIfAborted();
      if (actionId === 'computer.permissions.openSettings') {
        return await openComputerPrivacySettings(ComputerOpenSettingsRequestV1Schema.parse(parsed.data).permission, context.signal);
      }
      if (!sessionId) return failure('computer_session_required');
      const settings = input.resolveProviderSettings?.();
      const requestedProvider = parsed.data.provider;
      const recovery = ['computer.target.get', 'computer.control.status', 'computer.control.interrupt', 'computer.control.handBack', 'computer.target.close'].includes(actionId);
      const requestedSourceId = 'sourceId' in parsed.data ? parsed.data.sourceId : undefined;
      const recoverySource = recovery && requestedSourceId
        ? input.registry.list().find(entry => entry.computer?.sessionId === sessionId && entry.sourceId === requestedSourceId)?.computer
        : undefined;
      let provider: ComputerProviderIdV1;
      let executablePath: string | undefined;
      try {
        if (recovery) {
          // Selection reads bind the later Action without re-evaluating availability.
          // A retained source also owns stop/status after its provider is removed.
          provider = resolveComputerProviderId({ provider: requestedProvider ?? recoverySource?.provider, settings });
        } else {
          ({ provider, executablePath } = await resolveComputerProvider({ provider: requestedProvider, settings, executablePath: input.executablePath }));
        }
      } catch (error) { return nativeFailure(error); }
      if (actionId === 'computer.target.get') {
        const source = selected(sessionId, provider);
        try {
          if (source && !await source.resolveTarget()) {
            await source.close();
            if (selected(sessionId, provider) === source) input.registry.unregister(source.sourceId);
          }
          // The selection read already knows whether an unshared Machine has a
          // desktop connection. Viewers need no picker enumeration or thumbnails.
          const currentSelection = selection(sessionId, provider);
          if (!currentSelection.sourceId && !resolveComputerDisplayId(undefined, input.defaultDisplayId) && !desktop.current()) {
            return failure('computer_display_unavailable');
          }
          return currentSelection;
        } catch (error) { return nativeFailure(error); }
      }
      if (list) {
        const request = ComputerTargetsListRequestV1Schema.parse(parsed.data);
        let driver: Awaited<ReturnType<typeof createManagedComputerDriver>>;
        try {
          driver = await createManagedComputerDriver({ ...await resolveConnection(request.displayId), executablePath, provider });
        } catch (error) {
          // An unsupported desktop or a missing driver is the picker's typed explanation, not a thrown RPC.
          return nativeFailure(error);
        }
        try {
          const targets = await driver.listTargets({ includeThumbnails: context.authority === 'present_user' });
          const grants = await driver.checkPermissions();
          return { provider, targets: targets.map(({ target, title, appName, label, width, height, thumbnail }) => ({ target, ...(title ? { title } : {}),
            ...(label ? { label } : {}), ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}),
            ...(appName ? { appName } : {}), ...(context.authority === 'present_user' && thumbnail ? { thumbnail } : {}) })),
            displays: targets.some(entry => entry.target.kind === 'display') ? { status: 'available' }
              : { status: 'unavailable', code: 'display_enumeration_unsupported' },
            grants: { capture: grants.capture, input: grants.input } };
        } catch (error) { return nativeFailure(error); }
        finally { await driver.close(); }
      }
      if (actionId === 'computer.target.select') {
        const request = ComputerTargetSelectRequestV1Schema.parse(parsed.data);
        const access = resolveComputerAccess(request.access);
        let existing = selected(sessionId, provider);
        if (request.target && conflictingSelection(sessionId, provider, request.target)) return failure('computer_target_in_use');
        if (existing && (existing.status().uncertain || existing.isClosed())) {
          try { await existing.close(); } catch (error) { return nativeFailure(error); }
          if (selected(sessionId, provider) !== existing) return failure('computer_target_selection_changed');
          input.registry.unregister(existing.sourceId);
          existing = undefined;
        }
        if (request.target && existing && access === existing.access && computerTargetKey(request.target) === computerTargetKey(existing.target)) return selection(sessionId, provider);
        let connection: Awaited<ReturnType<typeof resolveConnection>>;
        let driver: Awaited<ReturnType<typeof createManagedComputerDriver>>;
        try {
          connection = await resolveConnection(request.target?.displayId);
          driver = await createManagedComputerDriver({ ...connection, executablePath, provider });
        }
        catch (error) { return nativeFailure(error); }
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
        } catch (error) { return nativeFailure(error); }
        finally { await driver.close(); }
        context.signal?.throwIfAborted();
        if (conflictingSelection(sessionId, provider, target)) return failure('computer_target_in_use');
        if (selected(sessionId, provider) !== existing) return failure('computer_target_selection_changed');
        if (existing && !existing.isClosed() && !existing.status().uncertain
          && access === existing.access && computerTargetKey(target) === computerTargetKey(existing.target)) return selection(sessionId, provider);
        if (existing) {
          try { await existing.close(); } catch (error) { return nativeFailure(error); }
          if (selected(sessionId, provider) !== existing) return failure('computer_target_selection_changed');
          input.registry.unregister(existing.sourceId);
        }
        // Native enumeration may await: recheck the single owning registry before replacement.
        if (selected(sessionId, provider)) return failure('computer_target_selection_changed');
        if (conflictingSelection(sessionId, provider, target)) return failure('computer_target_in_use');
        const source = createComputerCaptureSource({ sessionId, target, title, appName, access, executablePath, provider,
          environment: connection.environment });
        const sourceId = source.sourceId;
        input.registry.register({ sourceId, streamFamily: 'screen', computer: source, adapter: source.adapter,
          capabilities: { v: 1, sourceId, sourceKind: 'screen', supportedCodecs: ['image.frame.v1'], inputMode: 'shared', sidebands: [], health: { status: 'available' } } });
        return selection(sessionId, provider);
      }
      const request = ComputerTargetRequestV1Schema.parse({ machineId: parsed.data.machineId,
        target: 'target' in parsed.data ? parsed.data.target : undefined,
        sourceId: 'sourceId' in parsed.data ? parsed.data.sourceId : undefined });
      const source = selected(sessionId, provider);
      const element = actionId === 'computer.input' && ComputerInputRequestV1Schema.parse(parsed.data).operation.kind === 'element';
      if (element && request.sourceId && request.sourceId !== source?.sourceId) return failure('computer_element_stale');
      if (!source) return ['computer.capture', 'computer.query', 'computer.input'].includes(actionId)
        ? { status: 'target_selection_required', approvalDisplay: selection(sessionId, provider).approvalDisplay }
        : failure('computer_target_not_open');
      const sourceId = source.sourceId;
      if ((request.sourceId && request.sourceId !== sourceId)
        || (request.target && computerTargetKey(request.target) !== computerTargetKey(source.target))) return failure('computer_target_selection_changed');
      if (actionId === 'computer.input' && source.access === 'see') return { target: source.target, sourceId, provider,
        status: 'failed', code: 'computer_access_read_only' };
      if (['computer.capture', 'computer.query', 'computer.input'].includes(actionId)
        && context.authority !== 'present_user' && !source.consentGranted()) {
        if (!context.bypassApprovals) return failure('computer_consent_required');
        source.grantConsent();
      }
      const identity = { target: source.target, sourceId, provider };
      try {
        if (clipboard) return await source.clipboard(actionId === 'computer.clipboard.read' ? { kind: 'read' }
          : { kind: 'write', text: ComputerClipboardWriteRequestV1Schema.parse(parsed.data).text }, context.signal);
        if (actionId === 'computer.capture' || actionId === 'computer.query') {
          const observed = await source.observe(context.authority === 'present_user' ? 'human' : 'agent');
          context.signal?.throwIfAborted();
          const media = await writer.write({ sessionId, captureId: observed.captureId, png: observed.png });
          if (media.ok) source.setCaptureMedia(media.media);
          if (actionId === 'computer.query') return { ...identity, status: 'queried', captureId: observed.captureId, accessibility: {
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
        if (actionId === 'computer.control.status') return await source.readStatus();
        if (actionId === 'computer.control.interrupt') {
          const result = await source.interrupt();
          return { ...identity, status: 'interrupted', completion: result.completion };
        }
        if (actionId === 'computer.control.handBack') return source.handBack()
          ? { ...identity, status: 'dispatched' } : { ...identity, status: 'failed', code: 'control_not_drained' };
        if (actionId === 'computer.target.close') {
          const drain = await source.interrupt();
          const result = await source.close();
          if (selected(sessionId, provider) !== source) return failure('computer_target_selection_changed');
          input.registry.unregister(sourceId);
          return drain.completion === 'unknown' || result.completion === 'unknown' ? { ...identity, status: 'interrupted', completion: 'unknown' }
            : { ...identity, status: 'dispatched' };
        }
        return failure('unsupported_action');
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'native_capture_failed';
        if (code === 'target_not_found' || code === 'target_mismatch') {
          await source.close();
          if (selected(sessionId, provider) === source) input.registry.unregister(sourceId);
        }
        return { ...identity, status: 'failed', code };
      }
    },
    closeSession,
    async dispose() { try { await closeSession(); } finally { await desktop.dispose(); } },
  };
}
