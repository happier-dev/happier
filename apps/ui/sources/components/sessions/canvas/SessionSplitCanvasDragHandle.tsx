import * as React from 'react';
import type { PressableProps } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { t } from '@/text';
import { SplitCanvasDragSourceView } from '@/components/appShell/splitCanvas/components/SplitCanvasDragSourceView';
import { encodeSessionSplitCanvasDragData } from './sessionSplitCanvasDragData';
import { emitSessionSplitCanvasDragState } from './sessionSplitCanvasDragState';
import { Icon } from '@/components/ui/icons/Icon';

export type SessionSplitCanvasDragHandleProps = Readonly<{
    sessionId: string;
    onOpenInSplitRight: () => void;
}> & Pick<PressableProps, 'style' | 'testID'>;

export function SessionSplitCanvasDragHandle(props: SessionSplitCanvasDragHandleProps): React.ReactElement {
    const { theme } = useUnistyles();

    const handlePress = React.useCallback((event: unknown) => {
        const pressEvent = event as { preventDefault?: () => void; stopPropagation?: () => void } | null | undefined;
        pressEvent?.preventDefault?.();
        pressEvent?.stopPropagation?.();
        props.onOpenInSplitRight();
    }, [props.onOpenInSplitRight]);

    const handleDragStart = React.useCallback((event: any) => {
        const dataTransfer = event?.dataTransfer;
        if (!dataTransfer) {
            return;
        }

        dataTransfer.effectAllowed = 'copy';
        dataTransfer.setData('text/plain', encodeSessionSplitCanvasDragData({
            sessionId: props.sessionId,
        }));
        emitSessionSplitCanvasDragState(true);
    }, [props.sessionId]);

    const handleDragEnd = React.useCallback((event: any) => {
        event?.preventDefault?.();
        emitSessionSplitCanvasDragState(false);
    }, []);

    return (
        <SplitCanvasDragSourceView
            testID={props.testID}
            accessibilityRole="button"
            accessibilityLabel={t('sessionInfo.openInSplitRight')}
            hitSlop={8}
            style={props.style}
            onPress={handlePress}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
        >
            <Icon name="list" size={16} color={theme.colors.accent.blue} />
        </SplitCanvasDragSourceView>
    );
}
