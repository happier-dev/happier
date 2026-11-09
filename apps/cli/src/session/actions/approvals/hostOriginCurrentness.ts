import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { resolveApprovalExecutor } from '@happier-dev/protocol/approvals/resolveApprovalExecutor';
import { verifyExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { decodeBase64, encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { MachineInstallationPublicKeySchema } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { readExternalActionInstalledMachine } from '@/api/externalActionExecutionAuthorization';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import type { StoredCredentials } from '@/persistence';

/** CLI and saved-profile MCP share host approval custody. Exact daemon replay
 * keeps its existing currentness callback; this host never substitutes for it. */
export function createHostApprovalOriginCurrentness(params: Readonly<{
  credentials: StoredCredentials;
  serverId: string;
  serverApiUrl: string;
  resolveServerFeaturesSnapshot(): CliServerFeaturesSnapshot | undefined | Promise<CliServerFeaturesSnapshot | undefined>;
  checkDaemonOrigin?: NonNullable<ActionExecutorDeps['isApprovalExecutionOriginCurrent']>;
}>): NonNullable<ActionExecutorDeps['isApprovalExecutionOriginCurrent']> {
  return async args => {
    if (resolveApprovalExecutor(args.request).kind === 'daemon') return await params.checkDaemonOrigin?.(args) ?? false;
    // Account/client proposals belong to the deciding Account, not the old
    // runner. The signature authenticates unchanged proposal provenance.
    const { origin, request, signal } = args;
    if (origin.accountId !== undefined && origin.accountId !== readAccountIdFromToken(params.credentials.token)) return false;
    const snapshot = await params.resolveServerFeaturesSnapshot();
    if (signal?.aborted || !snapshot || snapshot.status !== 'ready' || snapshot.provenance !== 'authenticated'
      || (origin.serverIdentityId ? origin.serverIdentityId !== snapshot.features.capabilities.serverIdentity.serverIdentityId
        : origin.serverId !== params.serverId)) return false;
    const authorization = origin.externalActionExecutionAuthorization;
    if (!authorization) return true;
    if (request.v !== 2 || !origin.machineId || !origin.target || !origin.externalActionInputSignature
      || origin.actionId !== request.actionId
      || (authorization.binding.actionId !== request.actionId && authorization.binding.actionId !== 'approval.request.create')
      || (origin.caller.kind === 'session' ? request.createdBy.sessionId !== origin.caller.sessionId
        : origin.caller.kind !== 'host')) return false;
    // Only the recorded daemon can recheck its signed Home root and live
    // custody; approved-Artifact replay does that before the effect.
    const source = await readExternalActionInstalledMachine({ serverHttpBaseUrl: params.serverApiUrl,
      machineId: origin.machineId, headers: { Authorization: `Bearer ${params.credentials.token}` }, ...(signal ? { signal } : {}) });
    if (!source?.installationPublicKey || source.installationId !== authorization.binding.installationId
      || signal?.aborted) return false;
    const publicKey = decodeBase64(source.installationPublicKey, 'base64');
    if (encodeBase64(publicKey, 'base64') !== source.installationPublicKey
      || !MachineInstallationPublicKeySchema.safeParse(encodeBase64(publicKey, 'base64url')).success) return false;
    const current = verifyExternalActionApprovalInputV1({ authorizationToken: authorization.token,
      actionId: request.actionId, input: request.actionArgs, target: origin.target,
      ...(request.v === 2 && request.requesterConfirmation ? { requesterConfirmation: request.requesterConfirmation } : {}),
      signature: origin.externalActionInputSignature, publicKey });
    if (!current) args.reportStale?.('credential_changed');
    return current;
  };
}
