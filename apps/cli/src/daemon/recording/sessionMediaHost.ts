import type { StoredCredentials } from '@/persistence';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import { readOwnSessionMachineWorkspace } from '@/session/machineControlLocality';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readRequesterAccountActionTransportContext } from '../sessionEncryption/requesterAccountActionContext';
import { isOriginalOwnAccountActionCustody } from '../sessionEncryption/requesterAccountActionProjection';
import type { RequesterSessionAccountContextCustody } from '../sessionEncryption/requesterSessionAccountContextCustody';
import { retainRequesterSessionRuntimeContext } from '../sessionEncryption/requesterSessionRuntimeContextLifetime';
import { createDaemonSessionMutationCustody, type DaemonSessionMutationCustody } from '../connectedServices/usageLimitRecovery/createDaemonUsageLimitRecoveryMutationCustody';
import type { FilesystemEffectChannel } from '@/rpc/handlers/fileSystem/filesystemEffectChannel';
import type { FilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import type { FilesystemEffectConfiguration } from '@/rpc/handlers/fileSystem/filesystemEffectOperation';
import type { HostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';

type SaveCustody = Readonly<{ credentials: StoredCredentials; serverHttpBaseUrl: string }>;

/** The requester's own native filesystem process for one Session workspace; each save or discard opens one operation. */
export type RecordingMemberMedia = Readonly<{ open(): Promise<FilesystemEffectChannel> }>;

/**
 * Where the admitted requester's Session media files are written on this Machine, decided once by the
 * filesystem-effect owner: this daemon process, or the requester's member process (separated people).
 */
export type RecordingMediaPlacement =
  | Readonly<{ kind: 'daemon' }>
  | Readonly<{ kind: 'member'; media: RecordingMemberMedia; release(): Promise<void> }>
  | Readonly<{ kind: 'unavailable' }>;

/**
 * The save Record START admitted: the Session, its workspace here, whose custody writes its transcript
 * (null: this daemon's Account), and, for a separated requester, the member process that writes its files.
 */
export type RecordingSessionSave = Readonly<{ sessionId: string; workingDirectory: string; requester: SaveCustody | null;
  member?: RecordingMemberMedia }>;

/** Admitted host custody, kept private for the lifetime of one recording. */
export type RecordingOperationContext = Pick<RpcActionExecutorContext,
  'externalActionExecutionAuthorization' | 'requesterSessionBootstrap' | 'defaultSessionId' | 'runtimeAccountId' | 'machineAdmission'
  | 'verifyMachineAdmissionCurrent' | 'authority'>
  & Readonly<{ recordingSave?: RecordingSessionSave }>;

/**
 * Why Record START refused the save, before any capture:
 * - `recording_session_not_owned`: the named Session does not run on this Machine as the caller's own Account.
 * - `recording_session_unavailable`: the caller's Session cannot be read here as its owner (not on this Machine,
 *   ended, or its Account custody is not current), or its files cannot be written here as the caller's own OS user.
 */
export type RecordingSaveRefusal = Readonly<{ code: 'recording_session_not_owned' | 'recording_session_unavailable'; message: string }>;
export type RecordingSaveAdmission =
  | Readonly<{ ok: true; context: RecordingOperationContext; release(): Promise<void> }>
  | Readonly<{ ok: false; reason: RecordingSaveRefusal }>;

const noRelease = async () => {};

/** The filesystem-effect owner's placement for a recording save. A native placement writes through the
 * requester's own process, confined to the admitted Session workspace and nothing else. */
export async function selectRecordingMediaPlacement(input: Readonly<{
  admission: Pick<FilesystemEffectAdmission, 'resolveActionEffectPlacement'>;
  context: RecordingOperationContext | undefined;
  workingDirectory: string;
  openNative(identity: Extract<HostRequesterExecutionIdentity, { kind: 'isolated' }>,
    configuration: Pick<FilesystemEffectConfiguration, 'workingDirectory' | 'accessPolicy'>): Promise<FilesystemEffectChannel>;
}>): Promise<RecordingMediaPlacement> {
  const placement = await input.admission.resolveActionEffectPlacement?.(input.context) ?? { kind: 'unavailable' as const };
  if (placement.kind !== 'native') return placement;
  const { identity, requester } = placement;
  const configuration = { workingDirectory: input.workingDirectory,
    accessPolicy: { kind: 'restrictedRoots' as const, roots: [input.workingDirectory] } };
  return { kind: 'member', release: () => requester.dispose(), media: { open: () => input.openNative(identity, configuration) } };
}

/** Browser and Computer media save into the admitted Session with that Session's own Account custody. */
export function createRecordingSessionMediaHost(input: Readonly<{
  credentials: StoredCredentials;
  serverHttpBaseUrl: string;
  machineId: string;
  currentMachineHost: string;
  currentMachineHomeDir: string;
  signal?: AbortSignal;
  mutationCustody: Pick<DaemonSessionMutationCustody, 'stageTranscriptMessage'>;
  /** Machine core's requester custody for tracked Sessions; absent, only the custodian's own Sessions are admitted. */
  sessionAccounts?: Pick<RequesterSessionAccountContextCustody, 'resolveSessionAccountContext' | 'releaseSessionAccountContext'>;
  /** The filesystem-effect owner's placement for this admitted requester. With no Machine connection no remote
   * requester can reach Record START, so an absent owner leaves files to this daemon. */
  resolveMediaPlacement?: (context: RecordingOperationContext | undefined, workingDirectory: string) => Promise<RecordingMediaPlacement> | undefined;
  title: string;
}>) {
  const refuse = (code: RecordingSaveRefusal['code'], message: string) => ({ ok: false as const, reason: { code, message } });
  const unavailable = () => refuse('recording_session_unavailable', 'Your Session cannot be saved to on this Machine.');

  /** The one decision of whose custody writes this Session; every recording ingress reaches it at START. */
  async function selectCustody(sessionId: string, context?: RecordingOperationContext) {
    // Installed ingress and the Session issuer (an Agent's Action) carry the admitted requester's own custody.
    const requester = readRequesterAccountActionTransportContext(context?.externalActionExecutionAuthorization)
      ?? context?.requesterSessionBootstrap;
    if (requester) return { ok: true as const, requester, release: noRelease };
    const authorization = context?.externalActionExecutionAuthorization;
    if (authorization && !isOriginalOwnAccountActionCustody(authorization.binding)) return unavailable();
    const admission = context?.machineAdmission;
    if (!admission || authorization) return { ok: true as const, requester: null, release: noRelease };
    // A person's own Machine RPC carries no Account custody: reuse the custody this daemon already holds
    // for the named tracked Session, and only when that Session runs as the authenticated caller.
    let account: Awaited<ReturnType<RequesterSessionAccountContextCustody['resolveSessionAccountContext']>> = null;
    try { account = await input.sessionAccounts?.resolveSessionAccountContext(sessionId, undefined, input.signal) ?? null; }
    catch { return unavailable(); }
    const runsAs = account ? account.bootstrap.attribution.accountId : admission.custodianAccountId;
    if (runsAs !== admission.actorAccountId) {
      await input.sessionAccounts?.releaseSessionAccountContext(account);
      return refuse('recording_session_not_owned', 'Recordings save only into your own Session on this Machine.');
    }
    if (!account) return { ok: true as const, requester: null, release: noRelease };
    const held = account;
    const releaseOperation = retainRequesterSessionRuntimeContext(held);
    return { ok: true as const, requester: held.bootstrap, release: async () => {
      releaseOperation();
      await input.sessionAccounts?.releaseSessionAccountContext(held);
    } };
  }

  function admittedSave(sessionId: string, context?: RecordingOperationContext): RecordingSessionSave {
    const save = context?.recordingSave;
    if (!save || save.sessionId !== sessionId) throw new Error('Recording save was not admitted for this Session.');
    return save;
  }

  return {
    async admitSave({ sessionId }: Readonly<{ sessionId: string }>, context?: RecordingOperationContext): Promise<RecordingSaveAdmission> {
      const selected = await selectCustody(sessionId, context);
      if (!selected.ok) return selected;
      const custody = selected.requester
        ? { credentials: selected.requester.credentials, serverHttpBaseUrl: selected.requester.serverHttpBaseUrl } : null;
      try {
        // The owner read decides ownership, Account-mode decryption and locality to this Machine.
        const workspace = await readOwnSessionMachineWorkspace({
          credentials: custody?.credentials ?? input.credentials,
          serverHttpBaseUrl: custody?.serverHttpBaseUrl ?? input.serverHttpBaseUrl,
          sessionId, machineId: input.machineId,
          currentMachineHost: input.currentMachineHost, currentMachineHomeDir: input.currentMachineHomeDir,
          signal: input.signal,
        });
        if (workspace) {
          // Files in a separated requester's workspace are written by that requester's own OS user.
          const placement = await input.resolveMediaPlacement?.(context, workspace.rootPath) ?? { kind: 'daemon' as const };
          if (placement.kind !== 'unavailable') {
            const member = placement.kind === 'member' ? placement.media : undefined;
            return { ok: true, release: placement.kind === 'member'
              ? async () => { try { await placement.release(); } finally { await selected.release(); } } : selected.release,
            context: { ...context, recordingSave: { sessionId, workingDirectory: workspace.rootPath, requester: custody,
              ...(member ? { member } : {}) } } };
          }
        }
      } catch { /* A failed owner read refuses below like an absent workspace. */ }
      await selected.release();
      return unavailable();
    },
    async resolveWorkingDirectory({ sessionId }: Readonly<{ sessionId: string }>, context?: RecordingOperationContext) {
      return admittedSave(sessionId, context).workingDirectory;
    },
    async commitAttachment(attachment: Readonly<{ sessionId: string; localId: string; meta: Record<string, unknown> }>, context?: RecordingOperationContext) {
      const { requester } = admittedSave(attachment.sessionId, context);
      const mutation = { sessionId: attachment.sessionId, localId: attachment.localId, messageRole: 'user' as const,
        payload: { role: 'user', content: { type: 'text', text: input.title }, meta: attachment.meta } };
      if (!requester) {
        await input.mutationCustody.stageTranscriptMessage(mutation);
        return;
      }
      await runWithServerHttpBaseUrl(requester.serverHttpBaseUrl, async () => {
        const owner = createDaemonSessionMutationCustody({ credentials: requester.credentials });
        try { await owner.stageTranscriptMessage(mutation); }
        finally { await owner.close(); }
      });
    },
  };
}
