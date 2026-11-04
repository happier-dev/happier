import type { SessionOwnerMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import type { SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import type { AdmittedRequesterSessionBootstrap } from '../sessionEncryption/requesterSessionCredentials';
import { bestEffortReportBotTemplateAcceptedVersionV1 } from '@happier-dev/protocol/bots/templates/botTemplateOperations';
import { reportArtifactTemplateAcceptedVersion } from '@/api/artifacts/artifactAccessHttp';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

export type TemplateAcceptedVersionLaunchSettlement = Readonly<{
    result: SpawnSessionResult;
    requester?: Pick<AdmittedRequesterSessionBootstrap, 'credentials' | 'serverHttpBaseUrl'>;
    ownerMetadata?: SessionOwnerMetadataV1;
    signal?: AbortSignal;
}>;

/** Runner success is the natural deferred-copy settlement; Pending acceptance never calls this hook. */
export async function reportTemplateAcceptedVersionAfterLaunch(input: TemplateAcceptedVersionLaunchSettlement): Promise<void> {
    const instance = input.ownerMetadata?.work?.templateInstance;
    if (input.result.type !== 'success' || !input.result.sessionId || !input.requester || !instance) return;
    const requester = input.requester;
    await bestEffortReportBotTemplateAcceptedVersionV1({ reportAcceptedVersion: report =>
        runWithServerHttpBaseUrl(requester.serverHttpBaseUrl, () => reportArtifactTemplateAcceptedVersion(report, {
            headers: { Authorization: `Bearer ${requester.credentials.token}` }, signal: input.signal,
        })),
    }, { instance, copyId: input.result.sessionId }, { signal: input.signal });
}
