import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { buildCodeLinesFromTextDiff } from '@/components/ui/code/model/buildCodeLinesFromTextDiff';
import { CodeLinesView } from '@/components/ui/code/view/CodeLinesView';
import { useSetting } from '@/sync/domains/state/storage';

interface ToolDiffViewProps {
    oldText: string;
    newText: string;
    style?: any;
    showLineNumbers?: boolean;
    showPlusMinusSymbols?: boolean;
}

export const ToolDiffView = React.memo<ToolDiffViewProps>(({ 
    oldText, 
    newText, 
    style, 
    showLineNumbers = false,
    showPlusMinusSymbols = false 
}) => {
    const wrapLines = useSetting('wrapLinesInDiffs');

    const lines = React.useMemo(() => {
        return buildCodeLinesFromTextDiff({
            oldText,
            newText,
            contextLines: 3,
        });
    }, [newText, oldText]);

    const diffView = (
        <View style={{ flex: 1, ...(style ?? null) }}>
            <CodeLinesView
                lines={lines}
                wrapLines={wrapLines}
                virtualized={false}
                showLineNumbers={showLineNumbers}
                showPrefix={showPlusMinusSymbols}
            />
        </View>
    );

    if (wrapLines) {
        // When wrapping lines, no horizontal scroll needed
        return <View style={{ flex: 1 }}>{diffView}</View>;
    }
    
    // When not wrapping, use horizontal scroll
    return (
        <ScrollView 
            horizontal 
            showsHorizontalScrollIndicator={true}
            contentContainerStyle={{ flexGrow: 1 }}
        >
            {diffView}
        </ScrollView>
    );
});
