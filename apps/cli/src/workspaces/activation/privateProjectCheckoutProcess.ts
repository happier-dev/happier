import { isDeepStrictEqual } from 'node:util';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { authorizeResolvedProjectExecLaunchForHost, spawnAuthorizedHostExecLaunchForHost } from '@/plugins/runtime/invocation/services/exec';
import { createBackgroundServiceProcessServiceHost } from '@/plugins/runtime/lifecycle/contributions/backgroundServiceProcessBridge';
import { createBackgroundServiceProcessFrameDecoder, encodeBackgroundServiceProcessFrame, parseBackgroundServiceProcessMessage } from '@/plugins/runtime/lifecycle/contributions/backgroundServiceProcessProtocol';
import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';
import type { StablePluginConnectedAccountsOwner } from '@/plugins/runtime/invocation/services/connectedAccounts';
import type { readAgentIsolationMemberWorkspaceRoot } from '@/daemon/agentIsolation/agentIsolationNativeIdentity';
import type { PrivateProjectCheckout } from './privateProjectCheckout';
import type { MaterializedProjectCheckout } from './materializeProjectCheckout';
import type { WorkspaceCheckoutEffect } from './workspaceEffect';
import { createWorkspaceEffectConnectedAccounts } from './workspaceEffectServices';
import type { PrivateProjectNativeSync, PrivateProjectNativeSyncProcessPort, PrivateProjectSyncEffectConfiguration, PrivateProjectSyncNetwork } from './privateProjectSyncEffect';

type Launch = Parameters<typeof authorizeResolvedProjectExecLaunchForHost>[0];
type MemberRoot = Awaited<ReturnType<typeof readAgentIsolationMemberWorkspaceRoot>>;

export type PrivateProjectNativeProcessInput = Readonly<{
  prepared: PrivateProjectCheckout;
  memberRoot: MemberRoot;
  effect: WorkspaceCheckoutEffect;
  launch: Omit<Launch, 'launch'>;
  managedHappierBinaryPath: string;
  connectedAccounts?: Pick<StablePluginConnectedAccountsOwner, 'getBinding' | 'listAccounts' | 'materialize'>;
  verifyCurrent(): Promise<void>;
  onEffectsIssued(): void;
}>;

async function prepareNativeWorkspaceEffectLaunch(input: PrivateProjectNativeProcessInput) {
  const selected = input.launch.requesterIdentity;
  if (selected?.kind !== 'isolated' || !isDeepStrictEqual(selected.requester, input.memberRoot.identity.requester)
    || input.prepared.destinationParentPath !== input.memberRoot.workspaceRoot
    || input.effect.workspaceRefId !== input.prepared.workspaceRefId) throw new PluginError({ code: 'workspace_private_checkout_required',
      message: 'The private checkout operation is unavailable' });
  input.launch.signal.throwIfAborted();
  await input.verifyCurrent();
  return authorizeResolvedProjectExecLaunchForHost({ ...input.launch,
    agentLaunchKind: 'workspaceExec', agentNativeLaunch: false,
    launch: { command: input.managedHappierBinaryPath, args: ['workspace-effect'],
      cwd: input.memberRoot.workspaceRoot, env: {}, maxStdoutBytes: 0, maxStderrBytes: 0 },
  });
}

/** The existing Workspace operation retains its exact native/material leases.
 * This is transport for that owner, not a checkout engine or grant producer. */
export async function materializePrivateProjectCheckoutProcess(input: PrivateProjectNativeProcessInput): Promise<MaterializedProjectCheckout> {
  const refusal = (code = 'workspace_private_checkout_required') => new PluginError({ code,
    message: 'The private checkout operation is unavailable',
    details: { reason: code, phase: 'native_execution_preparation' } });
  const launch = await prepareNativeWorkspaceEffectLaunch(input);
  let transferred = false;
  try {
    await input.verifyCurrent();
    input.launch.assertCurrent();
    const process = spawnAuthorizedHostExecLaunchForHost(launch, { signal: input.launch.signal });
    transferred = true; // The incumbent supervisor now owns launch.release().
    // One invocation per pipe; the existing checkout id is sufficient routing.
    const id = input.prepared.workspaceRefId;
    const decoder = createBackgroundServiceProcessFrameDecoder();
    let result: MaterializedProjectCheckout | undefined;
    let failure: unknown;
    let settled = false;
    let issued = false;
    const onEffectsIssued = () => { if (!issued) { issued = true; input.onEffectsIssued(); } };
    const send = (value: unknown) => { process.child.stdin.write(encodeBackgroundServiceProcessFrame(value)); };
    const services = createBackgroundServiceProcessServiceHost({ signal: input.launch.signal,
      services: {
        ...(input.connectedAccounts ? { connectedAccounts: createWorkspaceEffectConnectedAccounts({
          effect: input.effect, owner: input.connectedAccounts, signal: input.launch.signal, assertCurrent: input.verifyCurrent,
        }) } : {}),
        onEffectsIssued: async () => { onEffectsIssued(); },
        fail: async (error: Error, effectsIssued: boolean) => {
          if (effectsIssued) onEffectsIssued();
          failure = error;
        },
        complete: async (checkout: MaterializedProjectCheckout) => {
          await input.verifyCurrent();
          // The captured native child already verified physical paths as the
          // member. The daemon must not traverse that private checkout again.
          if (checkout.rootPath !== input.prepared.rootPath
            || !isCanonicalAbsolutePathInsideRoot(input.prepared.rootPath, checkout.directory)) throw refusal();
          result = checkout;
        },
      }, send: message => send({ kind: 'services', message }),
    });
    const receive = (chunk: Buffer) => {
      try {
        for (const raw of decoder.push(chunk)) {
          const message = parseBackgroundServiceProcessMessage(raw);
          if (message.kind === 'services') { services.receive(message.message); continue; }
          if (message.kind === 'settled' && message.id === id) { settled = true; process.child.stdin.end(); continue; }
          if (message.kind === 'failed' && message.id === id) {
            failure = refusal(message.error.code); process.child.stdin.end(); continue;
          }
          throw refusal('workspace_effect_protocol_invalid');
        }
      } catch (error) { failure = error; void process.dispose('caller'); }
    };
    process.child.stdout.on('data', receive);
    process.child.stdin.on('error', () => {}); // Physical result below owns failed writes.
    try {
      send({ kind: 'run', id, context: input.effect, services: services.description });
      const completed = await process.handle.wait();
      // Root exit is not descendant settlement. The incumbent supervisor's
      // disposal owns that proof; waiting for it before requesting disposal
      // would retain the finished checkout and native material indefinitely.
      await process.dispose('caller');
      await process.waitForSettlement();
      // A settled canonical child can attest no-effect auth/admission refusal.
      // Abrupt transport loss cannot: clone may already have reserved its path.
      if (!settled && input.effect.request.materialization.kind === 'clone') onEffectsIssued();
      if (failure) throw failure;
      if (!settled || !result || completed.termination.observed.kind !== 'exit'
        || completed.termination.observed.exitCode !== 0) throw refusal('workspace_effect_outcome_unknown');
      await input.verifyCurrent();
      return result;
    } finally {
      process.child.stdout.off('data', receive);
      await services.dispose();
      await process.dispose('caller');
      await process.waitForSettlement();
    }
  } finally { if (!transferred) await launch.release(); }
}

/** The existing native invocation keeps the private pipe until the incumbent
 * relationship owner disposes it; no transfer re-selects a requester. */
export async function startPrivateProjectSyncProcess(input: PrivateProjectNativeProcessInput & Readonly<{
  configuration: PrivateProjectSyncEffectConfiguration;
  network: PrivateProjectSyncNetwork;
}>): Promise<PrivateProjectNativeSync> {
  const launch = await prepareNativeWorkspaceEffectLaunch(input);
  let transferred = false;
  try {
    await input.verifyCurrent(); input.launch.assertCurrent();
    const process = spawnAuthorizedHostExecLaunchForHost(launch, { signal: input.launch.signal });
    transferred = true;
    const decoder = createBackgroundServiceProcessFrameDecoder();
    const send = (value: unknown) => { process.child.stdin.write(encodeBackgroundServiceProcessFrame(value)); };
    let resolveReady!: (value: PrivateProjectNativeSyncProcessPort) => void;
    let rejectReady!: (error: unknown) => void;
    const ready = new Promise<PrivateProjectNativeSyncProcessPort>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    let completeNativeSync!: () => void;
    const nativeLifetime = new Promise<void>(resolve => { completeNativeSync = resolve; });
    const services = createBackgroundServiceProcessServiceHost({ signal: input.launch.signal, services: {
      ...(input.connectedAccounts ? { connectedAccounts: createWorkspaceEffectConnectedAccounts({ effect: input.effect,
        owner: input.connectedAccounts, signal: input.launch.signal, assertCurrent: input.verifyCurrent }) } : {}),
      onEffectsIssued: async () => { input.onEffectsIssued(); },
      readNativeSyncConfiguration: async () => ({ configuration: input.configuration, network: input.network }),
      // The existing bridge owns argument references for the duration of this
      // call. Retain that call with the incumbent native invocation.
      completeNativeSync: async (value: PrivateProjectNativeSyncProcessPort) => { resolveReady(value); await nativeLifetime; },
      fail: async (error: Error) => { rejectReady(error); },
    }, send: message => send({ kind: 'services', message }) });
    const receive = (chunk: Buffer) => {
      try {
        for (const raw of decoder.push(chunk)) {
          const message = parseBackgroundServiceProcessMessage(raw);
          if (message.kind === 'services') services.receive(message.message);
          else if (message.kind === 'settled') process.child.stdin.end();
          else throw new Error('workspace_effect_protocol_invalid');
        }
      } catch (error) { rejectReady(error); void process.dispose('caller'); }
    };
    process.child.stdout.on('data', receive);
    process.child.stdin.on('error', () => {});
    let disposal: Promise<void> | undefined;
    const disposeProcess = () => disposal ??= (async () => {
      completeNativeSync();
      try { await process.handle.wait(); } finally {
        await process.dispose('caller'); await process.waitForSettlement();
        process.child.stdout.off('data', receive); await services.dispose();
      }
    })();
    try {
      send({ kind: 'run', id: input.prepared.workspaceRefId,
        context: { kind: 'native_sync', checkout: input.effect, memberHome: input.memberRoot.identity.home }, services: services.description });
      const native = await Promise.race([ready, process.handle.wait().then(() => {
        throw new PluginError({ code: 'workspace_effect_outcome_unknown', message: 'The private workspace process ended before readiness' });
      })]);
      let closing: Promise<void> | undefined;
      return { ...native, borrowSourceRootForCopy: async request => {
        const loan = await native.borrowSourceRootForCopy(request);
        return loan && { ...loan, release: () => loan.dispose() };
      }, acquireWorkspaceSyncMachineIngress: async request => {
        const ingress = await native.acquireWorkspaceSyncMachineIngress(request);
        return { ...ingress, close: () => ingress.dispose() };
      }, openLocalWorkspaceAgentIngress: async request => {
        const ingress = await native.openLocalWorkspaceAgentIngress(request);
        return { ...ingress, close: () => ingress.dispose() };
      }, acquireLocalRoot: async request => {
        const result = await native.acquireLocalRoot(request);
        return 'kind' in result ? result : { ...result, release: () => result.dispose() };
      }, prepareBootstrapAtTarget: async (request, context) => {
        const result = await native.prepareBootstrapAtTarget(request, context);
        return { ...result, ...(result.ownershipHandles ? { ownershipHandles: result.ownershipHandles.map(handle => ({ ...handle, release: () => handle.dispose() })) } : {}) };
      }, dispose: () => closing ??= (async () => {
        try { await native.dispose(); } finally { await disposeProcess(); }
      })() };
    } catch (error) { await disposeProcess(); throw error; }
  } finally { if (!transferred) await launch.release(); }
}
