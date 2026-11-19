import type { AuthCredentials } from '../../auth/storage/authCredentials.js';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { AccountEncryptionModeResponse } from '@happier-dev/protocol/account/encryptionMode';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { BundledPluginUiAppArtifactInventory, PluginHostBundledUiDeclaration } from '../../sync/domains/plugins/availability/bundledPluginUiArtifactInventory.js';
export type { BundledPluginUiAppArtifactInventory, PluginHostBundledUiDeclaration } from '../../sync/domains/plugins/availability/bundledPluginUiArtifactInventory.js';

export function installBundledPluginUiArtifactsForTests(artifacts: BundledPluginUiAppArtifactInventory): () => void;
export function installBundledPluginUiDeclarationsForTests(declarations: readonly PluginHostBundledUiDeclaration[]): () => void;
export function installPersonTransientConfirmationBoundary(): () => void;
export function mountUiManagedMachineDetail(params: Readonly<{ serverId: string; managedId: string }>): Promise<Readonly<{
    readControls(): Readonly<{ delete: boolean; stop: boolean; remove: boolean }>;
    close(): Promise<void>;
}>>;
export function mountUiRetainedProjectTerminal(workspace: import('@happier-dev/protocol/workspaces/workspaceRefV1').WorkspaceAddressV1): Promise<Readonly<{
    scopeId: string;
    accountId: string;
    text(): string;
    machineName(): string | null;
    ready(): boolean;
    open(): Promise<void>;
    setPresented(presented: boolean): Promise<void>;
    read(): Readonly<{
        tabs: readonly import('@happier-dev/protocol/terminal/workspace').SessionTerminalTabV1[];
        current: boolean;
        surface: Readonly<{ terminalId: string | null; output: string }> | null;
        summary: Readonly<{ title: string | null }> | null;
    }>;
    close(): Promise<void>;
}>>;
export function prepareAuthenticationInventory(packaged: {
    artifacts: unknown[]; declarations: unknown[]; files: Map<number, Uint8Array>; reads: number;
}, input: Readonly<{
    manifest: unknown;
    target: Readonly<{ artifactId: string; exportName: string }>;
    projectPath: string; entryPath: string; packageName: string;
    additionalArtifacts?: readonly Readonly<{ target: Readonly<{ artifactId: string; exportName: string }>; entryPath: string }>[];
    deferDeclaration?: boolean; onDeclarationLoad?: () => void;
}>): Promise<{ pluginId: string; localId: string }>;

export function createUiMachineOutputFixture(serverId: string): Readonly<{
    cases: ReadonlyMap<ActionId, () => unknown | Promise<unknown>>;
    execute(actionId: ActionId, input: unknown): Promise<ActionExecuteResult>;
    close(): void;
}>;

// Cross-app tests resolve the real UI module at runtime, without merging its
// importer-relative @/* aliases into the CLI-oriented TypeScript program.
export function readUiMachineProjection(params: Readonly<{
    serverId: string;
    machineId: string;
    sections: readonly string[];
}>): Promise<import('../../agents/backendCatalog/daemonMergedProjectionCache.js').ProjectionCacheEntry | null>;

export function connectUiActionClient(params: Readonly<{
    serverUrl: string;
    publicEndpoint?: string;
    credentials: AuthCredentials;
}>): Promise<Readonly<{
    serverId: string;
    execute(actionId: ActionId, input: unknown, context?: ActionExecutorContext): Promise<ActionExecuteResult>;
    executeConfirmed(actionId: ActionId, input: unknown, context?: ActionExecutorContext): Promise<ActionExecuteResult>;
    executePresented(actionId: ActionId, input: unknown, context?: ActionExecutorContext): Promise<ActionExecuteResult>;
    submitSessionMessage(sessionId: string, text: string): Promise<Readonly<{ type: string; errorCode?: string; errorMessage?: string }>>;
    readDeploymentReceipt(environmentId: string, deploymentId: string): Promise<
        import('@happier-dev/deployments').DeploymentReadResultV1<import('@happier-dev/deployments/contracts/v1').DeploymentReceiptDetailV1>>;
    executeVoiceSpawn(input: unknown, effectId: string): Promise<string>;
    isAccountReady(): boolean;
    readSessionAgentState(sessionId: string): import('@happier-dev/session-core/state').AgentState | null;
    isMachineActive(machineId: string): boolean;
    isMachineControlReady(machineId: string): boolean;
    close(): Promise<void>;
}>>;

export function connectUiPersonActionClient(params: Readonly<{
    serverUrl: string;
    addressAnchorUrl?: string;
    accountSecret: Uint8Array;
    accountEncryptionMode?: AccountEncryptionModeResponse['mode'];
    withAppShellActions?: boolean;
    withCurrentUiActionPort?: boolean;
    withAccountLifecycle?: boolean;
}>): ReturnType<typeof connectUiActionClient>;

export function connectUiTriageActionClient(params: Parameters<typeof connectUiPersonActionClient>[0] & Readonly<{
    additionalPlugins?: readonly Readonly<{
        packageName: string;
        manifest: import('@happier-dev/plugin-sdk/manifest').PluginManifest;
        activate: import('@happier-dev/plugin-sdk').PluginAccountActivationModule['activate'];
    }>[];
}>): Promise<Awaited<ReturnType<typeof connectUiActionClient>> & Readonly<{
    collectionClients(contracts: readonly import('@happier-dev/protocol/plugins/data/collectionsV1').NormalizedPluginAccountCollectionContractV1[]):
        Promise<import('../../sync/api/plugins/data/activePluginCollectionClient.js').ActivePluginCollectionClientV1[]>;
    readConnectedAccountPoolActiveMember(group: import('@happier-dev/protocol/connect/qualified-connected-account-projections').QualifiedConnectedAccountGroupRef): string | null;
    observeMachineTransport(): Promise<Readonly<{
        counts(): { active: number; scoped: number };
        reset(): void;
        dispose(): void;
    }>>;
    waitForConnectedAccountProfile(ref: import('@happier-dev/protocol/connect/qualified-connected-account-persistence').QualifiedConnectedAccountRef): Promise<void>;
}>>;
export function prepareUiTriageActionPluginsForTest(
    additionalPlugins?: Parameters<typeof connectUiTriageActionClient>[0]['additionalPlugins'],
): Promise<void>;


export function connectFreshVercelThroughDeploymentUi(params: Readonly<{
    serverUrl: string;
    credentials: AuthCredentials;
    teamId: string;
    token: string;
    providerFetch: typeof globalThis.fetch;
}>): Promise<import('@happier-dev/protocol/connect/qualified-connected-account-persistence').QualifiedConnectedAccountRef>;

export function submitUiSessionSpawnNew(params: Readonly<{
    serverUrl: string;
    addressAnchorUrl?: string;
    accountSecret: Uint8Array;
    input: import('@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2').SessionSpawnNewInputV2;
    machineHomeDir: string;
    userAttemptId: string;
}>): Promise<unknown>;

export function createAccountOutputFixture(params: Readonly<{
    serverId: string; homeId: string; baseUrl: string; ownerToken: string; ownerAccountId: string;
    memberToken: string; memberAccountId: string; machineId: string; replacementMachineId?: string;
    createOutputMachine(input: Readonly<{id: string; active?: boolean; accountId?: string}>): Promise<string>;
    createOutputManagedMachine(input: Readonly<{id: string; setupGuestId?: string}>): Promise<Readonly<{managedId: string; intentRevision: number}>>;
}>): Readonly<{
    cases: ReadonlyMap<ActionId, () => unknown | Promise<unknown>>;
    execute(actionId: ActionId, input: unknown): Promise<ActionExecuteResult>;
    close(): Promise<void>;
}>;

export function allowRealActionServerSocketBoundary(serverUrl: string): Readonly<{dispose(): void}>;

export function createMachineClientEnrollmentOutputFixture(options: Readonly<{
    serverId: string; homeId: string; machineId: string; baseUrl: string; publicEndpoint: string;
    credentials: AuthCredentials; prepareManagedBootstrapResponse?: () => Promise<unknown>;
}>): Promise<Readonly<{
    cases: ReadonlyMap<ActionId, () => unknown | Promise<unknown>>;
    execute(actionId: ActionId, input: unknown): Promise<ActionExecuteResult>;
    close(): Promise<void>;
}>>;
