import type { DeploymentOwnServerContentV1 } from '@happier-dev/deployments/contracts/v1';
import type { DeploymentStageLogWriter as OwnServerDeploymentStageLogWriter } from '../stageLog';
export {
    DEPLOYMENT_STAGE_LOG_RELATIVE_PATH as OWN_SERVER_STAGE_LOG_RELATIVE_PATH,
    type DeploymentStageLogProvenance as OwnServerStageLogProvenance,
    type DeploymentStageLogWriter as OwnServerDeploymentStageLogWriter,
    resolveDeploymentStageLogPathForHost as resolveOwnServerStageLogPathForHost,
    openDeploymentStageLog as openOwnServerDeploymentStageLog,
    resolveRetainedDeploymentStageLogRootForHost,
    retainDeploymentStageLogAfterCandidateRemoval,
    type DeploymentStageLogReceipt as OwnServerStageLogReceipt,
    type DeploymentStageLogReadOptions as OwnServerStageLogReadOptions,
    readDeploymentStageLogs as readOwnServerDeploymentStageLogs
} from '../stageLog';

/** Snapshot this invocation's already-masked sink into the same protected receipt content. */
export function captureOwnServerDeploymentStageLog(content: DeploymentOwnServerContentV1,
    output: Pick<OwnServerDeploymentStageLogWriter, 'provenance'> | undefined): DeploymentOwnServerContentV1 {
    if (!output || !content.ownServer) return content;
    const snapshot = output.provenance;
    return { ...content, ownServer: { ...content.ownServer, stageLogs: [
        ...(content.ownServer.stageLogs ?? []).filter(log => log.machineId !== snapshot.machineId
            || log.installationId !== snapshot.installationId), snapshot,
    ] } };
}
