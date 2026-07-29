import {
  VoiceSpeechDiagnosticsSettingsV1Schema,
  type VoiceSpeechDiagnosticArtifactSummaryV1,
  type VoiceSpeechDiagnosticsBackupPolicyV1,
  type VoiceSpeechDiagnosticsHealthV1,
  type VoiceSpeechDiagnosticsSettingsV1,
} from '@happier-dev/protocol';

import {
  createVoiceDiagnosticStore,
  type VoiceDiagnosticArtifact,
  type VoiceDiagnosticCapture,
  VoiceDiagnosticCleanupError,
} from './store';
import { readFile } from 'node:fs/promises';

export type VoiceDiagnosticsController = Readonly<{
  root: string;
  configure(settings: VoiceSpeechDiagnosticsSettingsV1): Promise<void>;
  capture(capture: VoiceDiagnosticCapture): Promise<VoiceDiagnosticArtifact | null>;
  captureFile(capture: Omit<VoiceDiagnosticCapture, 'bytes'> & Readonly<{ filePath: string }>): Promise<VoiceDiagnosticArtifact | null>;
  status(): Promise<Readonly<{
    settings: VoiceSpeechDiagnosticsSettingsV1;
    artifacts: readonly VoiceSpeechDiagnosticArtifactSummaryV1[];
    health: VoiceSpeechDiagnosticsHealthV1;
    backupPolicy: VoiceSpeechDiagnosticsBackupPolicyV1;
  }>>;
  deleteAll(): Promise<void>;
  resolveArtifactForExport(artifactId: string): Promise<VoiceDiagnosticArtifact | null>;
  revokeCaptureAuthorization(authorizationId: string): Promise<void>;
}>;

export function createVoiceDiagnosticsController(input: Readonly<{
  happyHomeDir: string;
  createStore?: (settings: VoiceSpeechDiagnosticsSettingsV1) => ReturnType<typeof createVoiceDiagnosticStore>;
}>): VoiceDiagnosticsController {
  let settings = VoiceSpeechDiagnosticsSettingsV1Schema.parse({});
  const makeStore = input.createStore
    ?? ((policy: VoiceSpeechDiagnosticsSettingsV1) => createVoiceDiagnosticStore({ happyHomeDir: input.happyHomeDir, policy }));
  let store = makeStore(settings);
  let tail: Promise<void> = Promise.resolve();
  let captureFailureLatched = false;
  let cleanupHealth: VoiceSpeechDiagnosticsHealthV1['cleanup'] = {
    status: 'healthy',
    code: null,
    ownedEntryCount: 0,
  };
  let operationalCleanupFailure: Extract<
    VoiceSpeechDiagnosticsHealthV1['cleanup'],
    { status: 'required' }
  > | null = null;
  const revokedCaptureAuthorizations = new Set<string>();
  let denyAllCaptureAuthorizations = false;

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation, operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  }

  function projectHealth(): VoiceSpeechDiagnosticsHealthV1 {
    return {
      captureFailure: captureFailureLatched,
      cleanup: cleanupHealth,
    };
  }

  function markCleanupRequired(
    code: Extract<VoiceSpeechDiagnosticsHealthV1['cleanup'], { status: 'required' }>['code'],
    ownedEntryCount: number | null = null,
  ): void {
    cleanupHealth = { status: 'required', code, ownedEntryCount };
  }

  function latchOperationalCleanupFailure(
    code: 'cleanup_failed' | 'delete_failed',
    ownedEntryCount: number | null = null,
  ): void {
    operationalCleanupFailure = { status: 'required', code, ownedEntryCount };
    cleanupHealth = operationalCleanupFailure;
  }

  async function inspectStore(options: Readonly<{
    acknowledgeOperationalCleanup?: 'retention' | 'delete_all';
  }> = {}): Promise<readonly VoiceSpeechDiagnosticArtifactSummaryV1[]> {
    try {
      const inspection = await store.inspect();
      if (inspection.cleanupRequired) {
        markCleanupRequired('cleanup_failed', inspection.ownedEntryCount);
      } else {
        if (options.acknowledgeOperationalCleanup === 'delete_all'
          || (options.acknowledgeOperationalCleanup === 'retention'
            && operationalCleanupFailure?.code === 'cleanup_failed')) {
          operationalCleanupFailure = null;
        }
        cleanupHealth = operationalCleanupFailure
          ? { ...operationalCleanupFailure, ownedEntryCount: inspection.ownedEntryCount }
          : {
            status: 'healthy',
            code: null,
            ownedEntryCount: inspection.ownedEntryCount,
          };
      }
      return inspection.artifacts.map((artifact) => ({
        id: artifact.id,
        createdAtMs: artifact.createdAtMs,
        direction: artifact.direction,
        format: artifact.format,
        durationMs: artifact.durationMs,
        byteLength: artifact.byteLength,
      }));
    } catch {
      markCleanupRequired('catalog_unreadable', null);
      return [];
    }
  }

  async function latchCaptureFailure(): Promise<void> {
    await inspectStore();
    captureFailureLatched = true;
  }

  async function captureWithHealth(capture: VoiceDiagnosticCapture): Promise<VoiceDiagnosticArtifact | null> {
    try {
      const artifact = await store.capture(capture);
      if (artifact) {
        captureFailureLatched = false;
        await inspectStore({ acknowledgeOperationalCleanup: 'retention' });
      }
      return artifact;
    } catch (error) {
      if (error instanceof VoiceDiagnosticCleanupError) {
        latchOperationalCleanupFailure('cleanup_failed', cleanupHealth.ownedEntryCount);
        await inspectStore();
        return null;
      }
      await latchCaptureFailure();
      return null;
    }
  }

  return {
    root: store.root,
    configure: (next) => enqueue(async () => {
      settings = VoiceSpeechDiagnosticsSettingsV1Schema.parse(next);
      store = makeStore(settings);
      try {
        await store.prune();
        await inspectStore({ acknowledgeOperationalCleanup: 'retention' });
      } catch {
        latchOperationalCleanupFailure('cleanup_failed', null);
      }
    }),
    capture: (capture) => enqueue(async () => {
      if (!capture.authorizationId || denyAllCaptureAuthorizations || revokedCaptureAuthorizations.has(capture.authorizationId)) return null;
      return await captureWithHealth(capture);
    }),
    captureFile: (capture) => enqueue(async () => {
      if (!capture.authorizationId || denyAllCaptureAuthorizations || revokedCaptureAuthorizations.has(capture.authorizationId)) return null;
      if (!settings.enabled || settings.consentVersion !== 1) return null;
      if (capture.direction === 'stt_input' && !settings.captureSttInput) return null;
      if (capture.direction === 'tts_output' && !settings.captureTtsOutput) return null;
      let bytes: Uint8Array;
      try {
        bytes = await readFile(capture.filePath);
      } catch {
        await latchCaptureFailure();
        return null;
      }
      return await captureWithHealth({ ...capture, bytes });
    }),
    status: () => enqueue(async () => ({
      settings,
      backupPolicy: store.backupPolicy,
      artifacts: await inspectStore(),
      health: projectHealth(),
    })),
    deleteAll: () => enqueue(async () => {
      try {
        await store.deleteAll();
        await inspectStore({ acknowledgeOperationalCleanup: 'delete_all' });
      } catch (error) {
        latchOperationalCleanupFailure('delete_failed', cleanupHealth.ownedEntryCount);
        throw error;
      }
    }),
    resolveArtifactForExport: (artifactId) => enqueue(async () => {
      try {
        return await store.resolveArtifactForExport(artifactId);
      } catch {
        markCleanupRequired('catalog_unreadable', null);
        return null;
      }
    }),
    revokeCaptureAuthorization: (authorizationId) => enqueue(async () => {
      if (denyAllCaptureAuthorizations) return;
      if (revokedCaptureAuthorizations.size >= 4_096) {
        revokedCaptureAuthorizations.clear();
        denyAllCaptureAuthorizations = true;
        return;
      }
      revokedCaptureAuthorizations.add(authorizationId);
    }),
  };
}
