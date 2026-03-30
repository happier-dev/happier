import type { SystemTaskRunState } from '@/components/systemTasks/types';

export type RelayDriftBanner = Readonly<{
    kind: 'warning';
    title: string;
    description: string;
    actionLabel: string;
    secondaryActionLabel?: string;
    actionDisabled?: boolean;
    actionHint?: string;
    onPress: () => void | Promise<void>;
    onSecondaryPress?: () => void | Promise<void>;
    isRepairStarting: boolean;
    repairTaskSnapshot: SystemTaskRunState | null;
    onCancelRepair?: () => void;
}>;
