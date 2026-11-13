import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';

export function createUiMachineOutputFixture(serverId: string): Readonly<{
    cases: ReadonlyMap<ActionId, () => unknown | Promise<unknown>>;
    execute(actionId: ActionId, input: unknown): Promise<ActionExecuteResult>;
    close(): void;
}>;

// Cross-app tests resolve the real UI module at runtime, without merging its
// importer-relative @/* aliases into the CLI-oriented TypeScript program.
export function connectUiActionClient(params: Readonly<{
    serverUrl: string;
    publicEndpoint?: string;
    credentials: Readonly<{ token: string }>;
}>): Promise<Readonly<{
    serverId: string;
    execute(actionId: ActionId, input: unknown, context?: ActionExecutorContext): Promise<ActionExecuteResult>;
    executeConfirmed(actionId: ActionId, input: unknown, context?: ActionExecutorContext): Promise<ActionExecuteResult>;
    isAccountReady(): boolean;
    isMachineActive(machineId: string): boolean;
    close(): Promise<void>;
}>>;

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
    credentials: Readonly<{token: string}>; prepareManagedBootstrapResponse?: () => Promise<unknown>;
}>): Promise<Readonly<{
    cases: ReadonlyMap<ActionId, () => unknown | Promise<unknown>>;
    execute(actionId: ActionId, input: unknown): Promise<ActionExecuteResult>;
    close(): Promise<void>;
}>>;
