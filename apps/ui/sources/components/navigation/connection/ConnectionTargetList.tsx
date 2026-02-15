import * as React from 'react';

import { ActionListSection } from '@/components/ui/lists/ActionListSection';

type ConnectionTargetListProps = Readonly<{
    title: string;
    actions: ReadonlyArray<{
        id: string;
        label: string;
        subtitle?: string;
        icon?: React.ReactNode;
        right?: React.ReactNode;
        selected?: boolean;
        disabled?: boolean;
        onPress: () => void;
    }>;
}>;

export function ConnectionTargetList(props: ConnectionTargetListProps) {
    if (props.actions.length === 0) return null;
    return (
        <ActionListSection
            title={props.title}
            actions={props.actions}
        />
    );
}
