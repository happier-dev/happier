import type { AccountDirectoryCapabilities } from '@happier-dev/protocol';
import { accountDirectoryCredentialStorage } from '@/auth/accountDirectory/accountDirectoryCredentialStorage';
import { probeServerFeaturesAtUrl } from '@/sync/api/capabilities/serverFeaturesClient';
import { createAccountDirectorySession, parseAccountDirectoryCapability } from '@/sync/domains/accountDirectory/accountDirectorySession';
import { getAccountServiceEndpointSnapshot, type AccountServiceEndpointV1, type ServerProfile } from '@/sync/domains/server/serverProfiles';
import type { SystemTaskPromptContinuation } from '@/components/systemTasks/types';
import { createPersonalHomeRelocationProfilePublication, createPersonalHomeRelocationPromptResponder,
    createPersonalHomeRelocationPromptResponderWithPublication } from './personalHomeRelocationPromptResponder';

export type RelocationDirectoryPublication = Readonly<{
    endpoint: string;
    serverIdentityId: string;
    capability: AccountDirectoryCapabilities;
}>;

export async function resolveRelocationDirectoryPublication(
    endpoint: AccountServiceEndpointV1 | null,
): Promise<RelocationDirectoryPublication | null> {
    if (!endpoint?.url.trim()) return null;
    const observed = await probeServerFeaturesAtUrl({ endpointUrl: endpoint.url, force: true });
    const serverIdentityId = observed.status === 'ready' ? observed.serverIdentityId?.trim() ?? '' : '';
    const capability = parseAccountDirectoryCapability(
        observed.status === 'ready' ? observed.features.capabilities.accountDirectory : null,
    );
    if (!serverIdentityId || capability?.homeDirectory !== true
        || (endpoint.serverIdentityId && endpoint.serverIdentityId !== serverIdentityId)) {
        return null;
    }
    const credential = await accountDirectoryCredentialStorage.read({ endpoint: endpoint.url, serverIdentityId });
    return credential.kind === 'valid' ? { endpoint: endpoint.url, serverIdentityId, capability } : null;
}

export async function createPersonalHomeRelocationTaskContinuation(input: Readonly<{
    operationId: string;
    profile: ServerProfile;
    directoryPublication?: RelocationDirectoryPublication | null;
}>): Promise<SystemTaskPromptContinuation> {
    if (!input.profile.serverIdentityId) throw new Error('personal_home_identity_unavailable');
    const publication = input.directoryPublication === undefined
        ? await resolveRelocationDirectoryPublication(getAccountServiceEndpointSnapshot()) : input.directoryPublication;
    const respond = publication
        ? createPersonalHomeRelocationPromptResponder({
            operationId: input.operationId, homeServerIdentityId: input.profile.serverIdentityId, homeLabel: input.profile.name,
            session: createAccountDirectorySession({ endpoint: publication.endpoint, serverIdentityId: publication.serverIdentityId },
                { capability: publication.capability }),
        })
        : createPersonalHomeRelocationPromptResponderWithPublication({
            operationId: input.operationId, homeServerIdentityId: input.profile.serverIdentityId, homeLabel: input.profile.name,
            publication: createPersonalHomeRelocationProfilePublication(input.profile),
        });
    return bindPersonalHomeRelocationTaskContinuation(respond);
}

export function bindPersonalHomeRelocationTaskContinuation(respond: SystemTaskPromptContinuation): SystemTaskPromptContinuation {
    return async prompt => {
        if (prompt.kind !== 'personal_home.publish_relocation_descriptor.v1'
            && prompt.kind !== 'personal_home.read_relocation_descriptor.v1') return undefined;
        try {
            return await respond(prompt);
        } catch {
            // Preserve ambiguity for the native relocation authority reconciler.
            return { descriptor: null };
        }
    };
}
