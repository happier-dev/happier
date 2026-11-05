import type { Readable, Writable } from 'node:stream';
import { createBackgroundServiceProcessFrameDecoder, encodeBackgroundServiceProcessFrame, parseBackgroundServiceProcessMessage } from '@/plugins/runtime/lifecycle/contributions/backgroundServiceProcessProtocol';
import { createBackgroundServiceProcessServiceClient, type BackgroundServiceProcessBridgeValue } from '@/plugins/runtime/lifecycle/contributions/backgroundServiceProcessBridge';
import { executeWorkspaceCheckoutEffect, type WorkspaceCheckoutEffect, type WorkspaceCheckoutEffectContext } from './workspaceEffect';
import type { MaterializedProjectCheckout } from './materializeProjectCheckout';
import { privateProjectCheckoutRefusal } from './privateProjectCheckout';
import { executePrivateProjectSyncEffect, privateSyncEffectError, type PrivateProjectNativeSyncProcessPort,
  type PrivateProjectSyncEffectConfiguration, type PrivateProjectSyncNetwork, type WorkspaceNativeSyncEffect } from './privateProjectSyncEffect';

export type WorkspaceEffectServices = Readonly<{
  connectedAccounts?: WorkspaceCheckoutEffectContext['connectedAccounts'];
  onEffectsIssued(): Promise<void>;
  complete(result: MaterializedProjectCheckout): Promise<void>;
  fail(error: Error, effectsIssued: boolean): Promise<void>;
  readNativeSyncConfiguration?(): Promise<Readonly<{ configuration: PrivateProjectSyncEffectConfiguration; network: PrivateProjectSyncNetwork }>>;
  completeNativeSync?(result: PrivateProjectNativeSyncProcessPort): Promise<void>;
}>;

/** Early same-binary entry, before CLI/Account bootstrap. Private inherited
 * pipe only; the native launch shim already checks the actual selected UID. */
export async function runWorkspaceEffectWorker(args: readonly string[], io: Readonly<{
  input: Readable; output: Writable; signal: AbortSignal;
  /** OS boundary override for stream-composition tests, never a request field. */
  currentDirectory?: () => string;
}>): Promise<void> {
  if (args.length) throw privateProjectCheckoutRefusal();
  const decoder = createBackgroundServiceProcessFrameDecoder();
  let client: ReturnType<typeof createBackgroundServiceProcessServiceClient<WorkspaceEffectServices>> | undefined;
  const operation = new AbortController();
  const signal = AbortSignal.any([io.signal, operation.signal]);
  const send = (message: unknown) => { io.output.write(encodeBackgroundServiceProcessFrame(message)); };
  let running: Promise<void> | undefined;
  let runId: string | undefined;
  let nativeSync: PrivateProjectNativeSyncProcessPort | undefined;
  try {
    for await (const chunk of io.input) {
      for (const raw of decoder.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))) {
        const message = parseBackgroundServiceProcessMessage(raw);
        if (message.kind === 'services' && client) { client.receive(message.message); continue; }
        if (message.kind === 'abort' && message.id === runId || message.kind === 'stop') { operation.abort(); continue; }
        if (message.kind !== 'run' || running) throw new Error('workspace_effect_protocol_invalid');
        // Admission/source descriptors are inherited solely from the parent
        // owner, exactly as in the existing background-process bootstrap.
        const dispatched = message.context as WorkspaceCheckoutEffect | WorkspaceNativeSyncEffect;
        const effect = 'kind' in dispatched && dispatched.kind === 'native_sync' ? dispatched.checkout : dispatched as WorkspaceCheckoutEffect;
        if (effect.workspaceRoot !== (io.currentDirectory ?? process.cwd)()) {
          throw privateProjectCheckoutRefusal();
        }
        runId = message.id;
        client = createBackgroundServiceProcessServiceClient<WorkspaceEffectServices>({
          description: message.services as BackgroundServiceProcessBridgeValue,
          send: value => send({ kind: 'services', message: value }), signal,
        });
        const services = client.services;
        running = (async () => {
          let effectsIssued = false;
          try {
            if ('kind' in dispatched && dispatched.kind === 'native_sync') {
              if (!services.readNativeSyncConfiguration || !services.completeNativeSync) throw privateProjectCheckoutRefusal();
              const configuration = await services.readNativeSyncConfiguration();
              nativeSync = await executePrivateProjectSyncEffect(dispatched, configuration.configuration, configuration.network, { signal,
                connectedAccounts: services.connectedAccounts,
                onEffectsIssued: () => { effectsIssued = true; void services.onEffectsIssued().catch(() => {}); } });
              await services.completeNativeSync(nativeSync);
              send({ kind: 'settled', id: runId });
              return;
            }
            const result = await executeWorkspaceCheckoutEffect(effect, { signal,
              connectedAccounts: services.connectedAccounts,
              onEffectsIssued: () => { effectsIssued = true; void services.onEffectsIssued().catch(() => {}); },
            });
            await services.complete(result);
            send({ kind: 'settled', id: runId });
          } catch (error) {
            // The existing bridge ErrorValue preserves PluginError.data,
            // including reason/phase. Do not flatten it into failed.code/message.
            await services.fail('kind' in dispatched && dispatched.kind === 'native_sync'
              ? privateSyncEffectError(error) : error instanceof Error ? error : new Error('workspace_effect_failed'), effectsIssued);
            send({ kind: 'settled', id: runId });
          }
        })();
      }
    }
  } finally {
    operation.abort();
    try { await running; } finally {
      try { await nativeSync?.dispose(); } finally { await client?.dispose(); }
    }
  }
}
