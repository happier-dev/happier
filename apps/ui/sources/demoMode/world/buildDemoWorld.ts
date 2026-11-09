import type { ExternalSessionsSource} from '@happier-dev/protocol/sessions/external/sourceCatalog';
import type { FeaturesResponse } from '@happier-dev/protocol/features/payload/featuresResponseSchema';

import type { ExternalSessionBrowseCandidate } from '@/components/sessions/external/browse/useExternalSessionBrowseCandidates';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import type { NewSessionDraft } from '@/sync/domains/state/persistence';
import type { Machine, PendingMessage, Session } from '@/sync/domains/state/storageTypes';
import type { NormalizedMessage } from "@happier-dev/session-core/raw";
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';

import { buildDemoConnectedMetadataCatalog, buildDemoProfile, type DemoWorldProfile } from './connectedAccounts';
import type { ConnectedMetadataCatalogV1 } from '@happier-dev/protocol/connect/connectedMetadataCatalogV1';
import { buildDemoLocalSettings, type DemoWorldLocalSettings } from './localSettings';
import { buildDemoMcpServerCatalog } from './mcpServers';
import type { McpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';

import {
    DEMO_MACHINE_ID,
    DEMO_NOW_MS,
    DEMO_OPEN_CODE_PROVIDER_SESSION_ID,
    DEMO_PROJECT_PATH,
    DEMO_RICH_SESSION_ID,
    DEMO_SERVER_BASE_URL,
} from './constants';
import { buildDemoMachines, createDemoMachineFixture } from './machines';
import { buildDemoMachineReadings, buildDemoMachinePresets } from './machineReadings';
import { buildDemoSavedSecretMetadata } from './savedSecretMetadata';
import { buildDemoMessages, buildDemoPendingMessages, buildDemoReviewComments } from './messages';
import { buildDemoServerFeatures } from './serverFeatures';
import { buildDemoSessions, createDemoOpenCodeSessionFixture } from './sessions';
import { buildDemoSettings, type DemoWorldSettings } from './settings';
import { buildDemoRoleArtifacts } from './subagentGuidance';
import { buildDemoDiscussionSessions } from './discussion';

export { DEMO_RICH_SESSION_ID } from './constants';
export { createDemoMachineFixture, type CreateDemoMachineFixtureOptions } from './machines';
export { createDemoOpenCodeSessionFixture, type CreateDemoOpenCodeSessionFixtureOptions } from './sessions';

export type DemoWorld = Readonly<{
    artifacts: DecryptedArtifact[];
    sessions: Session[];
    machines: Machine[];
    machineReadings: ReturnType<typeof buildDemoMachineReadings>;
    machinePresets: ReturnType<typeof buildDemoMachinePresets>;
    savedSecretMetadata: ReturnType<typeof buildDemoSavedSecretMetadata>;
    messages: Record<string, NormalizedMessage[]>;
    pending: Record<string, { messages: PendingMessage[] }>;
    reviewComments: Record<string, ReviewCommentDraft[]>;
    serverFeatures: FeaturesResponse;
    settings: DemoWorldSettings;
    localSettings: DemoWorldLocalSettings;
    profile: DemoWorldProfile;
    connectedMetadata: ConnectedMetadataCatalogV1;
    mcpServers: McpServerCatalogV1;
}>;

export function buildDemoWorld(): DemoWorld {
    const machineReadings = buildDemoMachineReadings();
    return {
        artifacts: buildDemoRoleArtifacts(),
        sessions: [...buildDemoSessions(), ...buildDemoDiscussionSessions()],
        machines: buildDemoMachines(machineReadings),
        machineReadings,
        machinePresets: buildDemoMachinePresets(),
        savedSecretMetadata: buildDemoSavedSecretMetadata(),
        messages: buildDemoMessages(),
        pending: buildDemoPendingMessages(),
        reviewComments: buildDemoReviewComments(),
        serverFeatures: buildDemoServerFeatures(),
        settings: buildDemoSettings(),
        localSettings: buildDemoLocalSettings(),
        profile: buildDemoProfile(),
        connectedMetadata: buildDemoConnectedMetadataCatalog(),
        mcpServers: buildDemoMcpServerCatalog(),
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
