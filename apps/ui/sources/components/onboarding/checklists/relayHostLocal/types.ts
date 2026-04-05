import type { SystemTaskResult, SystemTaskRunState, SystemTaskRunner } from '@/components/systemTasks/types';

export type RelayHostLocalChecklistItemId =
    | 'installRelayRuntime'
    | 'startRelayRuntime';

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

export type RelayHostLocalChecklistTaskResult = SystemTaskResult;
