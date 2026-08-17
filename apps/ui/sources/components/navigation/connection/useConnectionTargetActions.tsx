import * as React from 'react';

import { getServerSelectionTargetIconName, getServerSelectionTargetSubtitle } from '@/sync/domains/server/selection/serverSelectionTargets';
import type { ServerSelectionTarget } from '@/sync/domains/server/selection/serverSelectionTypes';
import { Icon } from '@/components/ui/icons/Icon';

type UseConnectionTargetActionsParams = Readonly<{
    targets: ReadonlyArray<ServerSelectionTarget>;
    activeTargetKey: string;
    onSelectTarget: (target: ServerSelectionTarget) => void;
    selectedColor: string;
    iconColor: string;
}>;

export function useConnectionTargetActions(params: UseConnectionTargetActionsParams) {
    return React.useMemo(() => {
        return params.targets.map((target) => {
            const targetKey = `${target.kind}:${target.id}`;
            const isSelected = targetKey === params.activeTargetKey;
            return {
                id: `target-use-${target.kind}-${target.id}`,
                label: target.name,
                subtitle: getServerSelectionTargetSubtitle(target),
                icon: (
                    <Icon
                        name={getServerSelectionTargetIconName(target)}
                        size={16}
                        color={params.iconColor}
                    />
                ),
                right: isSelected
                    ? <Icon name="check" size={16} color={params.selectedColor} />
                    : null,
                selected: isSelected,
                disabled: isSelected,
                onPress: () => {
                    params.onSelectTarget(target);
                },
            };
        });
    }, [params.activeTargetKey, params.iconColor, params.onSelectTarget, params.selectedColor, params.targets]);
}
