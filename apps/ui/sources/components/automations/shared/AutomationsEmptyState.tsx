import React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Icon } from '@/components/ui/icons/Icon';

export function AutomationsEmptyState(props: Readonly<{ title: string; body: string }>) {
    const { theme } = useUnistyles();
    return (
        <EmptyState
            icon={<Icon name="timer" size={56} color={theme.colors.text.secondary} />}
            title={props.title}
            subtitle={props.body}
        />
    );
}
