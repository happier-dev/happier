import type { ExternalSessionsSource, FeaturesResponse } from '@happier-dev/protocol';

import type { ExternalSessionBrowseCandidate } from '@/components/sessions/external/browse/useExternalSessionBrowseCandidates';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import type { NewSessionDraft } from '@/sync/domains/state/persistence';
import type { Machine, PendingMessage, Session } from '@/sync/domains/state/storageTypes';
import type { NormalizedMessage } from '@/sync/typesRaw';

import { buildDemoProfile, type DemoWorldProfile } from './connectedAccounts';
import { buildDemoLocalSettings, type DemoWorldLocalSettings } from './localSettings';

import {
    DEMO_MACHINE_ID,
    DEMO_NOW_MS,
    DEMO_OPEN_CODE_PROVIDER_SESSION_ID,
    DEMO_PROJECT_PATH,
    DEMO_RICH_SESSION_ID,
    DEMO_SERVER_BASE_URL,
} from './constants';
import { buildDemoMachines, createDemoMachineFixture } from './machines';
import { buildDemoMessages, buildDemoPendingMessages, buildDemoReviewComments } from './messages';
import { buildDemoServerFeatures } from './serverFeatures';
import { buildDemoSessions, createDemoOpenCodeSessionFixture } from './sessions';
import { buildDemoSettings, type DemoWorldSettings } from './settings';

export { DEMO_RICH_SESSION_ID } from './constants';
export { createDemoMachineFixture, type CreateDemoMachineFixtureOptions } from './machines';
export { createDemoOpenCodeSessionFixture, type CreateDemoOpenCodeSessionFixtureOptions } from './sessions';

export type DemoWorld = Readonly<{
    sessions: Session[];
    machines: Machine[];
    messages: Record<string, NormalizedMessage[]>;
    pending: Record<string, { messages: PendingMessage[] }>;
    reviewComments: Record<string, ReviewCommentDraft[]>;
    serverFeatures: FeaturesResponse;
    settings: DemoWorldSettings;
    localSettings: DemoWorldLocalSettings;
    profile: DemoWorldProfile;
}>;

export function buildDemoWorld(): DemoWorld {
    return {
        sessions: buildDemoSessions(),
        machines: buildDemoMachines(),
        messages: buildDemoMessages(),
        pending: buildDemoPendingMessages(),
        reviewComments: buildDemoReviewComments(),
        serverFeatures: buildDemoServerFeatures(),
        settings: buildDemoSettings(),
        localSettings: buildDemoLocalSettings(),
        profile: buildDemoProfile(),
    };
}

export type CreateDemoExternalSessionBrowseCandidateFixtureOptions = Partial<ExternalSessionBrowseCandidate> & Readonly<{
    machineId?: string;
    path?: string;
    source?: ExternalSessionsSource;
}>;

export function createDemoExternalSessionBrowseCandidateFixture(
    options: CreateDemoExternalSessionBrowseCandidateFixtureOptions = {},
): ExternalSessionBrowseCandidate {
    const {
        machineId = DEMO_MACHINE_ID,
        path = DEMO_PROJECT_PATH,
        source = { kind: 'opencodeServer', baseUrl: DEMO_SERVER_BASE_URL, directory: path },
        details: detailsOverrides,
        ...candidateOverrides
    } = options;

    return {
        remoteSessionId: DEMO_OPEN_CODE_PROVIDER_SESSION_ID,
        title: 'OpenCode running on MacBook Pro',
        updatedAtMs: DEMO_NOW_MS,
        activity: 'running',
        details: {
            cwd: path,
            path,
            machineId,
            source,
            providerId: 'opencode',
            startedBy: 'daemon',
            ...(detailsOverrides ?? {}),
        },
        ...candidateOverrides,
    };
}

type DemoNewSessionDraftFields = Pick<
    NewSessionDraft,
    | 'input'
    | 'selectedMachineId'
    | 'selectedPath'
    | 'agentType'
    | 'permissionMode'
    | 'modelSelection'
    | 'selectedProfileId'
    | 'selectedSecretId'
>;

export type DemoNewSessionFixture = Readonly<DemoNewSessionDraftFields & {
    selectedMachineId: string;
    selectedPath: string;
}>;

export type CreateDemoNewSessionFixtureOptions = Partial<DemoNewSessionFixture> & Readonly<{
    machineId?: string;
    path?: string;
}>;

export function createDemoNewSessionFixture(options: CreateDemoNewSessionFixtureOptions = {}): DemoNewSessionFixture {
    const {
        machineId = DEMO_MACHINE_ID,
        path = DEMO_PROJECT_PATH,
        selectedMachineId: selectedMachineIdOverride,
        selectedPath: selectedPathOverride,
        ...fixtureOverrides
    } = options;

    return {
        input: 'Implement the dashboard auth skeleton and open a PR.',
        selectedMachineId: selectedMachineIdOverride ?? machineId,
        selectedPath: selectedPathOverride ?? path,
        agentType: 'opencode',
        permissionMode: 'default',
        modelSelection: null,
        selectedProfileId: null,
        selectedSecretId: null,
        ...fixtureOverrides,
    };
}
