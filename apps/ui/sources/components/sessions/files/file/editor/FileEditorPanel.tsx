import * as React from 'react';
import { View } from 'react-native';

import { CodeEditor } from '@/components/ui/code/editor/CodeEditor';
import { Typography } from '@/constants/Typography';
import { Text } from '@/components/ui/text/StyledText';

export function FileEditorPanel(props: Readonly<{
    theme: any;
    resetKey: string;
    value: string;
    language: string | null;
    onChange: (next: string) => void;
    wrapLines?: boolean;
    showLineNumbers?: boolean;
    readOnly?: boolean;
    changeDebounceMs?: number;
    bridgeMaxChunkBytes?: number;
}>) {
    return (
        <View style={{ flex: 1, paddingHorizontal: 16, paddingVertical: 12 }}>
            <CodeEditor
                resetKey={props.resetKey}
                value={props.value}
                language={props.language}
                onChange={props.onChange}
                wrapLines={props.wrapLines}
                showLineNumbers={props.showLineNumbers}
                readOnly={props.readOnly}
                changeDebounceMs={props.changeDebounceMs}
                bridgeMaxChunkBytes={props.bridgeMaxChunkBytes}
            />
            <Text style={{ marginTop: 8, color: props.theme.colors.textSecondary, fontSize: 12, ...Typography.default() }}>
                Editing is experimental. Save to write changes back to the session worktree.
            </Text>
        </View>
    );
}
