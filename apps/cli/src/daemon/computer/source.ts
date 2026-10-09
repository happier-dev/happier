import { randomUUID } from 'node:crypto';
import { computerTargetKeyV1 } from '@happier-dev/protocol/computer/v1';
import { normalizeBrowserActiveTargetRect, BrowserActiveTargetV1Schema } from '@happier-dev/protocol/browser/events/activeTarget';
import type { ComputerTargetV1, ComputerInputOperationV1, ComputerActionResultV1, ComputerAccessV1, BrowserActiveTargetV1, ComputerControlStatusResponseV1, ComputerCaptureGeometryV1, ComputerAccessibilityNodeV1, MachineLiveStreamControlSidebandV1, SessionImageMediaReferenceV1 } from '@happier-dev/protocol';
import { createManagedComputerDriver } from './driver/managedComputerDriver';
import { createSurfaceInputControl } from '../surfaces/inputControl';
import { createSimulatorFrameProducerCaptureAdapter } from '../devices/simulator/capture/adapter';
import type { MachineLiveStreamCaptureAdapter } from '../peer/mediation/stream/captureAdapter';

export const computerTargetKey = computerTargetKeyV1;

export type ComputerCaptureSource = ReturnType<typeof createComputerCaptureSource>;

/** One native producer per exact Session/target, retained by the existing capture registry. */
export function createComputerCaptureSource(input: Readonly<{
  sessionId: string;
  target: ComputerTargetV1;
  title?: string;
  appName?: string;
  access?: ComputerAccessV1;
  executablePath?: string;
}>) {
  // A stream source is one selection lifetime; revoked approvals cannot bind a later reselection.
  const sourceId = `computer:${randomUUID()}`;
  const control = createSurfaceInputControl({ requireObservation: true, onStatusChange: publishStatus });
  let driver: ReturnType<typeof createManagedComputerDriver> | null = null;
  const getDriver = () => driver ??= createManagedComputerDriver({ displayId: input.target.displayId, executablePath: input.executablePath });
  type Capture = Awaited<ReturnType<Awaited<ReturnType<typeof createManagedComputerDriver>>['capture']>>;
  let latest: Pick<Capture, 'png' | 'geometry'> | null = null;
  let modelCaptureId: string | null = null;
  let modelCapture: Pick<Capture, 'geometry' | 'accessibility'> | null = null;
  let agentCaptures = 0;
  let inputActivity: ComputerControlStatusResponseV1['activity'];
  let activeTarget: BrowserActiveTargetV1 | undefined;
  const access = input.access ?? 'use';
  let closed = false;
  let consentGranted = false;
  let title = input.title ?? '';
  let appName = input.appName;
  let captureMedia: (SessionImageMediaReferenceV1 & { file: NonNullable<SessionImageMediaReferenceV1['file']> }) | undefined;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let framePending: Promise<void> | null = null;
  type Viewer = { fps: number | undefined; paused: boolean; ready: boolean; nextFrameAt: number;
    nowMs(): number; emit(png: Buffer): void; emitStatus(status: string): void; fail(reason: string): void };
  const viewers = new Set<Viewer>();
  let lastPublishedStatus: string | undefined;

  function status(): ComputerControlStatusResponseV1 {
    return { target: input.target, sourceId, ...control.getStatus(),
      ...(inputActivity ? { activity: inputActivity } : agentCaptures ? { activity: { kind: 'capture' as const } } : {}),
      ...(activeTarget ? { activeTarget } : {}) };
  }
  function publishStatus(): void {
    const serialized = JSON.stringify(status());
    if (serialized === lastPublishedStatus) return;
    lastPublishedStatus = serialized;
    for (const viewer of viewers) viewer.emitStatus(serialized);
  }

  function publish(capture: Pick<Capture, 'png' | 'geometry'>): void {
    latest = capture;
    for (const viewer of viewers) if (!viewer.paused && viewer.ready && viewer.nowMs() >= viewer.nextFrameAt) viewer.emit(capture.png);
  }
  async function observe(requestedBy: 'agent' | 'human' = 'agent'): Promise<Capture> {
    if (closed) throw new Error('capture_source_unavailable');
    if (requestedBy === 'agent') { agentCaptures += 1; publishStatus(); }
    try {
      const epoch = control.getStatus().controlEpoch;
      const native = await getDriver();
      const capture = await native.capture(input.target);
      if (closed) throw new Error('capture_source_unavailable');
      modelCaptureId = capture.captureId;
      modelCapture = { geometry: capture.geometry, accessibility: capture.accessibility };
      control.observe(epoch);
      publish(capture);
      return capture;
    } finally { if (requestedBy === 'agent') { agentCaptures -= 1; publishStatus(); } }
  }
  async function observeFrame(): Promise<void> {
    if (closed) throw new Error('capture_source_unavailable');
    const frame = await (await getDriver()).captureFrame(input.target);
    if (closed) throw new Error('capture_source_unavailable');
    publish(frame);
  }

  function schedule(): void {
    if (closed || timer || framePending) return;
    const active = [...viewers].filter(viewer => !viewer.paused && viewer.ready);
    if (!active.length) return;
    const delay = Math.min(...active.map(viewer => Math.max(0, viewer.nextFrameAt - viewer.nowMs())));
    // Uncapped frames advance on capture completion and viewer acknowledgement, never a polling timer.
    if (delay === 0) {
      framePending = observeFrame().then(() => undefined, () => {
          for (const viewer of viewers) viewer.fail('capture_source_unavailable');
          viewers.clear();
        }).finally(() => { framePending = null; schedule(); });
    } else {
      // Only an explicit admitted FPS cap supplies a deadline.
      timer = setTimeout(() => { timer = null; schedule(); }, delay);
      timer.unref?.();
    }
  }

  async function execute(captureId: string, operation: ComputerInputOperationV1, requestedBy: 'agent' | 'human', signal?: AbortSignal): Promise<ComputerActionResultV1> {
    const identity = { target: input.target, sourceId };
    if (requestedBy === 'agent' && access === 'see') return { ...identity, status: 'failed', code: 'computer_access_read_only' };
    if (requestedBy === 'agent' && captureId !== modelCaptureId) return { ...identity, status: 'failed', code: 'stale_capture' };
    const clicked = requestedBy === 'agent' && operation.kind === 'click' && modelCapture
      ? clickedTarget(modelCapture, operation) : undefined;
    const targetLabel = clicked?.label;
    const outcome = await control.execute({ requestedBy, signal,
      async effect(abortSignal) {
        if (abortSignal.aborted) return { status: 'interrupted', completion: 'known' } as const;
        if (requestedBy === 'agent') {
          // Keyboard focus is not exposed by the pinned native accessibility contract.
          inputActivity = { kind: operation.kind, ...(targetLabel ? { targetLabel } : {}) };
          activeTarget = clicked;
          publishStatus();
        }
        try {
          const native = await getDriver();
          if (abortSignal.aborted) return { status: 'interrupted', completion: 'known' } as const;
          // Atomic native input is drained; AbortSignal must never discard its physical settlement.
          return await native.input(input.target, captureId, operation, { signal: abortSignal });
        } finally { if (requestedBy === 'agent') { inputActivity = undefined; activeTarget = undefined; publishStatus(); } }
      },
      classifyCompletion: value => value.status === 'interrupted' ? value.completion : 'known',
    });
    if (!outcome.ok) return { ...identity, status: 'failed', code: outcome.errorCode };
    const presentation = targetLabel ? { targetLabel } : {};
    if (outcome.interrupted) return { ...identity, ...presentation, status: 'interrupted', completion: outcome.completion };
    return { ...identity, ...presentation, ...outcome.value };
  }

  const adapter: MachineLiveStreamCaptureAdapter = {
    async start(startInput) {
      if (closed) return { ok: false, reasonCode: 'capture_source_unavailable' };
      let failInput: (reason: string) => void = () => undefined;
      let pendingInput = Promise.resolve();
      let stopped = false;
      let viewer: Viewer | undefined;
      const captureAdapter = createSimulatorFrameProducerCaptureAdapter({ sourceId, sourceCodecs: ['image.frame.v1'], producer: {
        async start({ emitFrame, fail, reportInputFailure }) {
          failInput = reportInputFailure;
          const activeViewer: Viewer = { fps: startInput.caps.maxFramesPerSecond, paused: false, ready: true, nextFrameAt: 0,
            nowMs: startInput.nowMs,
            emit(png: Buffer) {
              if (this.fps === undefined) this.ready = false;
              else this.nextFrameAt = this.nowMs() + 1000 / this.fps;
              emitFrame({ codecId: 'image.frame.v1', payload: png, keyframe: true });
            }, emitStatus(serialized) {
              emitFrame({ codecId: 'image.frame.v1', payloadKind: 'metadata', payload: Buffer.from(serialized) });
            }, fail };
          viewer = activeViewer;
          viewers.add(activeViewer);
          try { await observeFrame(); } catch { viewers.delete(activeViewer); throw { reasonCode: 'capture_source_unavailable' }; }
          activeViewer.emitStatus(JSON.stringify(status()));
          schedule();
          return {
            stop() { stopped = true; viewers.delete(activeViewer); if (!viewers.size && timer) { clearTimeout(timer); timer = null; } },
            pause() { activeViewer.paused = true; return { ok: true } as const; },
            resume() { activeViewer.paused = false; activeViewer.ready = true; schedule(); return { ok: true } as const; },
            requestKeyframe() { activeViewer.ready = true; schedule(); return { ok: true } as const; },
          };
        },
      } });
      const result = await captureAdapter.start({ ...startInput, offerFrame(frame) {
        const offered = startInput.offerFrame(frame);
        if (!offered.ok && offered.reasonCode === 'backpressure_window_exhausted' && viewer) viewer.ready = false;
        return offered;
      } });
      if (!result.ok) return result;
      return { ok: true, session: { ...result.session,
        applyControl(controlMessage) {
          const applied = result.session.applyControl?.(controlMessage) ?? { ok: false, reasonCode: 'invalid_control' };
          if (applied.ok && controlMessage.kind === 'ack' && viewer) {
            // Credit remains transport-owned; a successfully admitted ack wakes the producer.
            viewer.ready = controlMessage.windowFrames !== 0 && controlMessage.windowBytes !== 0;
            schedule();
          }
          return applied;
        },
        applySidebandControl(sideband) {
          if (sideband.sourceId !== sourceId || sideband.streamId !== startInput.streamId) return { ok: false, reasonCode: 'invalid_control' };
          if (stopped) return { ok: false, reasonCode: 'capture_stopped' };
          const operation = viewerOperation(sideband, latest);
          if (!operation || !latest) return result.session.applySidebandControl?.(sideband) ?? { ok: false, reasonCode: 'input_not_supported' };
          const viewedGeometry = latest.geometry;
          // Present-user sidebands are admitted by the existing stream custody/lease owner.
          const takeover = control.takeOver();
          pendingInput = pendingInput.then(async () => {
            const drain = await takeover;
            if (stopped) return;
            if (drain.completion === 'unknown') failInput('human_input_interruption_uncertain');
            const epoch = control.getStatus().controlEpoch;
            const observation = await (await getDriver()).capture(input.target);
            control.observe(epoch);
            if (JSON.stringify(observation.geometry) !== JSON.stringify(viewedGeometry)) { failInput('stale_capture'); return; }
            const outcome = await execute(observation.captureId, operation, 'human');
            if (outcome.status === 'failed' || outcome.status === 'interrupted') failInput('human_input_failed');
          }).catch(() => failInput('human_input_failed'));
          return { ok: true };
        },
      } };
    },
  };
  return { sessionId: input.sessionId, target: input.target, sourceId, adapter, access,
    isClosed: () => closed,
    get title() { return title; },
    get appName() { return appName; },
    async resolveTarget() {
      if (closed) throw new Error('capture_source_unavailable');
      const target = (await (await getDriver()).listTargets()).find(entry =>
        computerTargetKey(entry.target) === computerTargetKey(input.target));
      if (target) { title = target.title ?? ''; appName = target.appName; }
      return target;
    },
    consentGranted: () => consentGranted,
    grantConsent: () => { consentGranted = true; },
    captureMedia: () => captureMedia,
    setCaptureMedia: (media: NonNullable<typeof captureMedia>) => { captureMedia = media; },
    observe,
    input: (captureId: string, operation: ComputerInputOperationV1, requestedBy: 'agent' | 'human', signal?: AbortSignal) => execute(captureId, operation, requestedBy, signal),
    status,
    interrupt: () => control.takeOver(),
    handBack: () => control.handBack(),
    async close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      for (const viewer of viewers) viewer.fail('capture_stopped');
      viewers.clear();
      const outcome = await control.close();
      // Failed initialization already closes its transport in the native boundary.
      const native = driver ? await driver.catch(() => null) : null;
      await native?.close();
      // Process retirement also settles a viewer read with a lost reply.
      await framePending;
      modelCaptureId = null;
      modelCapture = null;
      return { completion: outcome };
    },
  };
}

function clickedTarget(capture: Readonly<{ geometry: ComputerCaptureGeometryV1;
  accessibility: Readonly<{ nodes: readonly ComputerAccessibilityNodeV1[] }> }>,
  operation: Extract<ComputerInputOperationV1, { kind: 'click' }>): BrowserActiveTargetV1 | undefined {
  const geometry = capture.geometry;
  // Native accessibility bounds are absolute screen coordinates, not delivered PNG pixels.
  const candidates = capture.accessibility.nodes.flatMap(node => {
    if (!node.bounds) return [];
    const rect = { x: (node.bounds.x - geometry.originX) / geometry.scaleX,
      y: (node.bounds.y - geometry.originY) / geometry.scaleY,
      width: node.bounds.width / geometry.scaleX, height: node.bounds.height / geometry.scaleY };
    if (operation.x < rect.x || operation.y < rect.y || operation.x >= rect.x + rect.width || operation.y >= rect.y + rect.height) return [];
    const normalized = normalizeBrowserActiveTargetRect(rect, { width: geometry.captureWidth, height: geometry.captureHeight });
    if (!normalized) return [];
    // A native name identical to its field value is not independent presentation evidence.
    const name = node.name && node.name !== node.value ? node.name : undefined;
    const target = BrowserActiveTargetV1Schema.safeParse({ ...normalized, ...(name ? { label: name } : {}) });
    return [{ area: rect.width * rect.height, target: target.success ? target.data : normalized }];
  });
  candidates.sort((left, right) => left.area - right.area);
  return candidates[0]?.target;
}

function viewerOperation(control: MachineLiveStreamControlSidebandV1, capture: { geometry: { captureWidth: number; captureHeight: number } } | null): ComputerInputOperationV1 | null {
  if (control.kind === 'keyboard_text') return { kind: 'type', text: control.text };
  if (control.kind === 'keyboard_key') return { kind: 'press', key: control.key };
  if (control.kind === 'tap' && capture) return { kind: 'click', x: control.x * capture.geometry.captureWidth, y: control.y * capture.geometry.captureHeight };
  return null;
}
