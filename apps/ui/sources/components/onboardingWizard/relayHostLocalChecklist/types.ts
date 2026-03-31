import type { SystemTaskResult, SystemTaskRunState, SystemTaskRunner } from '@/components/systemTasks/types';

export type RelayHostLocalChecklistItemId =
    | 'installRelayRuntime'
    | 'startRelayRuntime'
    | 'enableSecureAccess';

export type RelayHostLocalChecklistStatus = 'idle' | 'queued' | 'running' | 'done' | 'error';

export type RelayHostLocalChecklistLogEntry = Readonly<{
    ts: number;
    level: RelayHostLocalChecklistLogLevel;
    stepId: string | null;
    message: string;
}>;

export type RelayHostLocalChecklistLogLevel = 'info' | 'warn' | 'error';

export type RelayHostLocalChecklistItem = Readonly<{
    id: RelayHostLocalChecklistItemId;
    title: string;
    subtitle: string;
    badge?: string | null;
    optional?: boolean;
    satisfied: boolean;
    disabled: boolean;
    defaultSelected: boolean;
    stepIds: readonly string[];
}>;

export type RelayHostLocalChecklistExecution = Readonly<{
    status: RelayHostLocalChecklistStatus;
    selected: boolean;
    expanded: boolean;
    logs: readonly RelayHostLocalChecklistLogEntry[];
    errorMessage: string | null;
}>;

export type RelayHostLocalChecklistRuntimeStatus = Readonly<{
    installed: boolean;
    version: string | null;
    relayUrl: string;
    healthy: boolean;
    service: Readonly<{
        active: boolean | null;
        enabled: boolean | null;
    }>;
}>;

export type RelayHostLocalChecklistController = Readonly<{
    items: readonly RelayHostLocalChecklistItem[];
    executionById: Readonly<Record<RelayHostLocalChecklistItemId, RelayHostLocalChecklistExecution>>;
    selectedIds: readonly RelayHostLocalChecklistItemId[];
    phase: 'select' | 'execute' | 'done';
    activeTaskSnapshot: SystemTaskRunState | null;
    toggleItem: (itemId: RelayHostLocalChecklistItemId) => void;
    toggleExpanded: (itemId: RelayHostLocalChecklistItemId) => void;
    startExecution: () => void;
    retry: () => void;
    copyDiagnostics: (itemId: RelayHostLocalChecklistItemId) => void;
    cancel: () => void;
    runner: SystemTaskRunner;
    status: RelayHostLocalChecklistRuntimeStatus | null;
    currentShareableUrl: string | null;
    currentRelayUrl: string | null;
}>;

export type RelayHostLocalChecklistTaskResult = SystemTaskResult;
