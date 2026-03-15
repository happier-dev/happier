import * as React from 'react';
import { CodeBlockView } from '@/components/ui/code/blocks/CodeBlockView';
import { useSetting } from '@/sync/domains/state/storage';


interface CodeViewProps {
    code: string;
    language?: string;
}

export const CodeView = React.memo<CodeViewProps>(({ 
    code, 
    language
}) => {
    const jsonInferenceMaxBytes = useSetting('filesCodeViewJsonInferenceMaxBytes') as number | null;

    const resolvedLanguage = React.useMemo(() => {
        if (typeof language === 'string' && language.trim()) return language.trim();
        const trimmed = String(code ?? '').trim();
        if (!trimmed) return null;
        // Best-effort: infer JSON for common tool input/output blocks (frequently `JSON.stringify`).
        const budget = typeof jsonInferenceMaxBytes === 'number' ? jsonInferenceMaxBytes : 0;
        const canInferJson = budget > 0 && trimmed.length <= budget;

        if (canInferJson && (trimmed.startsWith('{') || trimmed.startsWith('['))) {
            try {
                JSON.parse(trimmed);
                return 'json';
            } catch {
                // ignore
            }
        }
        return null;
    }, [code, jsonInferenceMaxBytes, language]);

    return (
        <CodeBlockView
            code={code}
            language={resolvedLanguage}
            selectable={true}
            wrap={false}
            showCopyButton={true}
        />
    );
});
