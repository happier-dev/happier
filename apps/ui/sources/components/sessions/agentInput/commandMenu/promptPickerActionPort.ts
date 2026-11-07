import type { PublicActionInputById } from '@happier-dev/protocol/actions/actionSpecs';
import type { UserMessageHistoryEntriesData } from '@/hooks/session/useUserMessageHistoryEntries';

export type PromptPickerActionPort = Readonly<{
    select: (selection: PublicActionInputById['ui.prompts.picker.select']['selection']) => 'selected' | 'notFound' | 'notReady';
    apply: (mode: 'insert' | 'send', signal?: AbortSignal) => Promise<boolean>;
    history: Readonly<{
        read: () => UserMessageHistoryEntriesData;
        page: (signal?: AbortSignal) => Promise<UserMessageHistoryEntriesData>;
        retry: (signal?: AbortSignal) => Promise<UserMessageHistoryEntriesData>;
        stop: () => UserMessageHistoryEntriesData;
    }>;
}>;

/** The existing mounted open callback also exposes its open leaf's current port. */
export type PromptPickerOpenRequest = (() => boolean) & Readonly<{
    read: () => PromptPickerActionPort | null;
}>;
