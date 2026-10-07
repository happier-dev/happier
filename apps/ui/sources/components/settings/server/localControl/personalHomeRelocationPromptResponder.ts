import {
    HomeConnectionDescriptorV1Schema,
    type HomeConnectionDescriptorV1,
} from '@happier-dev/protocol/auth/accountDirectory';

import type { SystemTaskPromptEnvelope } from '@/components/systemTasks/prompts/readLatestSystemTaskPrompt';
import type { AccountDirectorySession } from '@/sync/domains/accountDirectory/accountDirectorySession';
import {
    adoptHomeProfile,
    buildHomeConnectionDescriptorForProfile,
    getServerProfileById,
    type ServerProfile,
} from '@/sync/domains/server/serverProfiles';

type RelocationDirectorySession = Pick<AccountDirectorySession, 'publishHomeDescriptor' | 'readHomeDescriptor'>;

export type PersonalHomeRelocationPublication = Readonly<{
    publish: (input: Readonly<{
        homeServerIdentityId: string;
        homeLabel: string;
        connectionDescriptor: HomeConnectionDescriptorV1;
    }>) => Promise<HomeConnectionDescriptorV1>;
    read: (homeServerIdentityId: string) => Promise<HomeConnectionDescriptorV1 | null>;
}>;

type RelocationPromptResponderParams = Readonly<{
    operationId: string;
    homeServerIdentityId: string;
    homeLabel: string;
    session: RelocationDirectorySession;
}>;

type RelocationPromptResponderWithPublicationParams = Omit<RelocationPromptResponderParams, 'session'> & Readonly<{
    publication: PersonalHomeRelocationPublication;
}>;

/** Without Directory only the initiating client's existing profile is updated. */
export function createPersonalHomeRelocationProfilePublication(profile: ServerProfile): PersonalHomeRelocationPublication {
    return {
        publish: async (input) => {
            if (input.connectionDescriptor.homeServerIdentityId !== profile.serverIdentityId) {
                throw new Error('Personal Home relocation descriptor did not match the current Home.');
            }
            const adopted = await adoptHomeProfile({
                descriptor: input.connectionDescriptor,
                source: profile.source ?? 'manual',
                preserveUserLabel: true,
                preserveProfileSource: true,
                descriptorAuthority: 'current_connection_observation',
            });
            const descriptor = buildHomeConnectionDescriptorForProfile(getServerProfileById(adopted.id) ?? adopted);
            if (!descriptor) throw new Error('Personal Home relocation descriptor was not retained.');
            return descriptor;
        },
        read: async (homeServerIdentityId) => {
            if (homeServerIdentityId !== profile.serverIdentityId) throw new Error('Personal Home relocation read targeted another Home.');
            const current = getServerProfileById(profile.id);
            return current ? buildHomeConnectionDescriptorForProfile(current) : null;
        },
    };
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function assertExpectedOperation(prompt: SystemTaskPromptEnvelope, params: Pick<RelocationPromptResponderParams, 'operationId' | 'homeServerIdentityId'>): void {
    const operationId = readString(prompt.data.operationId);
    const homeServerIdentityId = readString(prompt.data.homeServerIdentityId);
    if (operationId !== params.operationId || homeServerIdentityId !== params.homeServerIdentityId) {
        throw new Error('Personal Home relocation prompt did not match the requested Home operation.');
    }
}

/**
 * The task runner owns relocation progress and prompt delivery. This adapter
 * only validates the bound prompt facts and delegates publication/readback to
 * the canonical Account Directory session; it neither stores credentials nor
 * becomes a Home-location authority.
 */
export function createPersonalHomeRelocationPromptResponder(
    params: RelocationPromptResponderParams,
): (prompt: SystemTaskPromptEnvelope) => Promise<Readonly<{ descriptor: unknown | null }>> {
    return createPersonalHomeRelocationPromptResponderWithPublication({
        operationId: params.operationId,
        homeServerIdentityId: params.homeServerIdentityId,
        homeLabel: params.homeLabel,
        publication: {
            publish: async (input) => {
                const result = await params.session.publishHomeDescriptor({
                    homeServerIdentityId: input.homeServerIdentityId,
                    label: input.homeLabel,
                    connectionDescriptor: input.connectionDescriptor,
                });
                return result.entry.connectionDescriptor;
            },
            read: async (homeServerIdentityId) => {
                const entry = await params.session.readHomeDescriptor(homeServerIdentityId);
                return entry?.connectionDescriptor ?? null;
            },
        },
    });
}

/**
 * The relocation task binds every publication/readback prompt to its operation
 * and Home identity. Directory-backed publication and initiating-client profile
 * adoption share this validation boundary; only their canonical persistence
 * owner differs.
 */
export function createPersonalHomeRelocationPromptResponderWithPublication(
    params: RelocationPromptResponderWithPublicationParams,
): (prompt: SystemTaskPromptEnvelope) => Promise<Readonly<{ descriptor: unknown | null }>> {
    return async (prompt) => {
        assertExpectedOperation(prompt, params);

        if (prompt.kind === 'personal_home.publish_relocation_descriptor.v1') {
            const descriptor = HomeConnectionDescriptorV1Schema.safeParse(prompt.data.connectionDescriptor);
            if (!descriptor.success || descriptor.data.homeServerIdentityId !== params.homeServerIdentityId) {
                throw new Error('Personal Home relocation publication prompt contained invalid destination facts.');
            }
            const published = await params.publication.publish({
                homeServerIdentityId: params.homeServerIdentityId,
                homeLabel: params.homeLabel,
                connectionDescriptor: descriptor.data,
            });
            return { descriptor: published };
        }

        if (prompt.kind === 'personal_home.read_relocation_descriptor.v1') {
            return { descriptor: await params.publication.read(params.homeServerIdentityId) };
        }

        throw new Error('Unexpected Personal Home relocation prompt.');
    };
}
