import { approvalArtifactBodyMatchesHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import type { DaemonTerminalEnsureRequest } from '@happier-dev/protocol/daemon/terminal';
import type { SessionTerminalPendingActionApprovalV1 } from '@happier-dev/protocol/terminal/workspace';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

/** One binding check shared by remounted receipt custody and explicit member cancellation. */
export function inspectMachineTerminalMemberApproval(input: Readonly<{
    artifact: DecryptedArtifact; pending: SessionTerminalPendingActionApprovalV1;
    machineId: string; request: DaemonTerminalEnsureRequest;
}>) {
    const { artifact, pending } = input;
    if (artifact.id !== pending.artifactId || typeof artifact.body !== 'string') return null;
    const matched = approvalArtifactBodyMatchesHeaderV1(artifact.header ?? {}, artifact.body);
    if (matched?.family !== 'built_in' || matched.request.v !== 2) return null;
    const request = matched.request;
    const origin = request.executionOriginV1;
    if (request.actionId !== pending.actionId || origin.actionId !== pending.actionId
        || origin.accountId !== pending.scope.accountId
        || !areServerProfileIdentifiersEquivalent(origin.serverId, pending.scope.serverId)) return null;
    const parsed = getActionSpec(pending.actionId).inputSchema.safeParse(request.actionArgs);
    if (!parsed.success || typeof parsed.data !== 'object' || parsed.data === null) return null;
    const args: Readonly<Record<string, unknown>> = parsed.data;
    if (args.machineId !== input.machineId || typeof args.serverId !== 'string'
        || !areServerProfileIdentifiersEquivalent(args.serverId, pending.scope.serverId)) return null;
    // Resize is presentation-owned and can differ when the same member remounts.
    // All launch/root/Session operands still have to match the immutable Artifact.
    const { cols: originalCols, rows: originalRows, ...original } = args;
    const { cols: currentCols, rows: currentRows, ...current } = input.request;
    if (createCanonicalJsonSigningInput(projectNativeJsonValueForTransport({ ...original, serverId: pending.scope.serverId }))
        !== createCanonicalJsonSigningInput(projectNativeJsonValueForTransport({ ...current, serverId: pending.scope.serverId, machineId: input.machineId }))) return null;
    return request;
}
