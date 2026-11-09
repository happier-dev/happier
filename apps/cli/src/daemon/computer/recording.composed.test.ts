import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor, type ActionId } from '@happier-dev/protocol';
import { createComputerRoutes } from './routes';
import { createComputerCaptureSource } from './source';
import { createComputerRecording } from './recording';
import { native, target, captureResult } from './driver/nativeComputerBoundary.testkit';
import { createMachineLiveStreamCaptureRegistry } from '../peer/mediation/stream/captureRegistry';
import { createDaemonRuntimeActionExecutor } from '../runtimeActionExecutor';
import { createFfmpegBrowserRecordingStreamFrameEncoderFactory } from '../recording/ffmpegStreamEncoder';

afterEach(() => vi.restoreAllMocks());

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'happier-computer-recording-'));
  const registry = createMachineLiveStreamCaptureRegistry();
  const source = createComputerCaptureSource({ sessionId: 'session', target, executablePath: '/managed/cua-driver' });
  registry.register({ sourceId: source.sourceId, streamFamily: 'screen', computer: source, adapter: source.adapter,
    capabilities: { v: 1, sourceId: source.sourceId, sourceKind: 'screen', supportedCodecs: ['image.frame.v1'],
      inputMode: 'shared', sidebands: [], health: { status: 'available' } } });
  native.call.mockImplementation(async ({ name }) => name === 'get_window_state' ? captureResult()
    : name === 'list_windows' ? { structuredContent: { windows: [{ pid: target.pid, window_id: target.windowId, title: 'Editor' }] } }
    : { structuredContent: { x11: true, xsend_event: true } });
  const commits: Record<string, unknown>[] = [];
  let encodedFrames = 0;
  // Only the encoder process is replaced; real stream capture, lifecycle, file persistence and Action dispatch run.
  const encoderFactory = createFfmpegBrowserRecordingStreamFrameEncoderFactory({ workingDirectory: directory,
    resolveFfmpegBinaryPath: async () => '/fixture/ffmpeg',
    spawnFfmpeg: (_binary, args) => {
      expect(args).toContain('image2pipe');
      const child = new EventEmitter();
      const stdin = new Writable({ write(_chunk, _encoding, callback) { encodedFrames++; callback(); },
        final(callback) { void writeFile(args.at(-1)!, Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1]))
          .then(() => { callback(); child.emit('close', 0, null); }, callback); } });
      queueMicrotask(() => child.emit('spawn'));
      return Object.assign(child, { stdin, kill: () => { child.emit('close', null, 'SIGKILL'); return true; } });
    } });
  const routes = createComputerRoutes({ machineId: 'machine', registry, executablePath: '/managed/cua-driver',
    recording: { workingDirectory: directory, encoderFactory,
      commitAttachment: async ({ meta }) => { commits.push(JSON.parse(JSON.stringify(meta))); } } });
  const runtimeActionExecute = createDaemonRuntimeActionExecutor({ env: { NODE_ENV: 'test' },
    resolveRouteOwners: () => ({ computer: routes }), resolveServerFeaturesSnapshot: () => undefined });
  const executor = createActionExecutor({ runtimeActionExecute });
  const context = { authority: 'present_user' as const, surface: 'ui' as const, defaultSessionId: 'session',
    defaultSessionMachineId: 'machine', serverId: 'home' };
  const invoke = (id: string, input: Record<string, unknown>, agent = false) => executor.execute(id as ActionId,
    { machineId: 'machine', sourceId: source.sourceId, ...input }, agent
      ? { ...context, authority: 'account_automation', surface: 'agent', bypassApprovals: true } : context);
  return { routes, source, registry, encoderFactory, commits, directory, invoke, executor, runtimeActionExecute, frames: () => encodedFrames,
    async close() { await routes.dispose(); await rm(directory, { recursive: true, force: true }); } };
}

describe('Computer recording through the real Action entry', () => {
  it.each([false, true])('starts, finalizes, lists and attaches the selected screen using the shared recorder (agent=%s)', async agent => {
    const fixture = await setup();
    try {
      const started = await fixture.invoke('computer.recording.start', { mediaTarget: { sessionId: 'session', messageLocalId: 'recording' } }, agent);
      expect(started).toMatchObject({ ok: true, result: { status: 'started', recording: { target, sourceId: fixture.source.sourceId, status: 'recording' } } });
      if (!started.ok) throw new Error('Start refused');
      const recordingId = (started.result as { recording: { recordingId: string } }).recording.recordingId;
      const stopped = await fixture.invoke('computer.recording.stop', { recordingId }, agent);
      expect(stopped).toMatchObject({ ok: true, result: { status: 'finalized', recording: { status: 'finalized', frameCount: expect.any(Number), mediaRef: { mediaKind: 'video' } } } });
      expect(fixture.frames()).toBeGreaterThan(0);
      expect(await fixture.invoke('computer.recording.listForTarget', {})).toMatchObject({ ok: true, result: [{ recordingId, target }] });
      expect(await fixture.invoke('computer.recording.status', { recordingId })).toMatchObject({ ok: true, result: { recordingId, status: 'finalized' } });
      expect(await fixture.invoke('computer.recording.attachToComposer', { recordingId, sessionId: 'session' })).toMatchObject({ ok: true, result: { ok: true, attachmentId: expect.any(String) } });
      expect(fixture.commits).toHaveLength(1);
      const files = await import('node:fs/promises').then(fs => fs.readdir(fixture.directory, { recursive: true }));
      expect(files.some(file => String(file).endsWith('.webm'))).toBe(true);
    } finally { await fixture.close(); }
  });

  it('reports lifecycle retirement before an agent Stop instead of claiming its capture adapter is missing', async () => {
    const fixture = await setup();
    try {
      const started = await fixture.invoke('computer.recording.start', { mediaTarget: { sessionId: 'session', messageLocalId: 'closed' } }, true);
      expect(started).toMatchObject({ ok: true, result: { status: 'started' } });
      if (!started.ok) throw new Error('Start refused');
      const recordingId = (started.result as { recording: { recordingId: string } }).recording.recordingId;
      await fixture.routes.closeSession('session');
      expect(await fixture.invoke('computer.recording.status', { recordingId }, true))
        .toMatchObject({ ok: true, result: { status: 'discarded', outcomeReason: 'session_closed' } });
      expect(await fixture.invoke('computer.recording.stop', { recordingId }, true))
        .toMatchObject({ ok: true, result: { status: 'unavailable', reason: { code: 'browser_recording_not_active' } } });
    } finally { await fixture.close(); }
  });

  it('refuses unconsented agent capture and another Session’s source before starting the stream', async () => {
    const fixture = await setup();
    try {
      const input = { machineId: 'machine', sourceId: fixture.source.sourceId, mediaTarget: { sessionId: 'session', messageLocalId: 'clip' } };
      const context = { authority: 'account_automation' as const, surface: 'agent' as const, defaultSessionId: 'session', defaultSessionMachineId: 'machine' };
      expect(await fixture.executor.execute('computer.recording.start', input, context))
        .toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
      expect(await fixture.runtimeActionExecute({ actionId: 'computer.recording.start', input, context })).toMatchObject({ ok: false, errorCode: 'computer_consent_required' });
      expect(await fixture.runtimeActionExecute({ actionId: 'computer.recording.start', input,
        context: { ...context, authority: 'present_user', surface: 'ui', defaultSessionId: 'other' } }))
        .toMatchObject({ status: 'target_selection_required', approvalDisplay: { requiresTargetSelection: true } });
      expect(fixture.frames()).toBe(0);
      expect(native.tools.filter(call => call.name === 'get_window_state')).toHaveLength(0);
    } finally { await fixture.close(); }
  });

  it('creates no idle timers or polls and returns to zero work after cancellation', async () => {
    const fixture = await setup();
    try {
      vi.useFakeTimers();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(vi.getTimerCount()).toBe(0);
      expect(native.tools).toHaveLength(0);
      expect(fixture.frames()).toBe(0);
      vi.useRealTimers();
      const started = await fixture.invoke('computer.recording.start', { mediaTarget: { sessionId: 'session', messageLocalId: 'cancel' } });
      expect(started).toMatchObject({ ok: true, result: { status: 'started' } });
      if (!started.ok) throw new Error('Start refused');
      const recordingId = (started.result as { recording: { recordingId: string } }).recording.recordingId;
      expect(await fixture.invoke('computer.recording.cancel', { recordingId })).toMatchObject({ ok: true, result: { status: 'canceled' } });
      const captureCount = native.tools.length;
      vi.useFakeTimers();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(vi.getTimerCount()).toBe(0);
      expect(native.tools).toHaveLength(captureCount);
    } finally { vi.useRealTimers(); await fixture.close(); }
  });

  it('keeps retained recordings private to the admitted desktop within a shared Session', async () => {
    const fixture = await setup();
    const recording = createComputerRecording({ machineId: 'machine', registry: fixture.registry,
      options: { workingDirectory: fixture.directory, encoderFactory: fixture.encoderFactory } });
    try {
      const started = await recording.start({ machineId: 'machine', sourceId: fixture.source.sourceId,
        mediaTarget: { sessionId: 'session', messageLocalId: 'private-clip' }, retentionClass: 'preSend' },
      { ...fixture.source, desktopKey: 'private-desktop' });
      expect(started).toMatchObject({ status: 'started' });
      if (!('recording' in started)) throw new Error('Start refused');
      const request = { machineId: 'machine', sourceId: fixture.source.sourceId, recordingId: started.recording.recordingId };
      expect(await recording.dispatch('computer.recording.status', request, fixture.source.sourceIdentity, 'other-desktop')).toBeNull();
      expect(await recording.dispatch('computer.recording.listForTarget', request, fixture.source.sourceIdentity, 'other-desktop')).toEqual([]);
      expect(await recording.dispatch('computer.recording.attachToComposer', request, fixture.source.sourceIdentity, 'other-desktop'))
        .toMatchObject({ ok: false, errorCode: 'computer_recording_missing' });
      expect(await recording.dispatch('computer.recording.status', request, fixture.source.sourceIdentity, 'private-desktop'))
        .toMatchObject({ recordingId: request.recordingId });
    } finally { await recording.closeSource(fixture.source.sourceId); await fixture.close(); }
  });
});
