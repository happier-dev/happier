import * as React from 'react';
import type { CodeEditorLanguageIntelligence } from '../editor/codeEditorTypes';
import type { CodeLine } from '../model/codeLineTypes';
import { projectCodeSemanticTokens } from '../model/codeSemanticTokens';

export type CodeLinesSemanticBinding = Readonly<{
    controller: Pick<CodeEditorLanguageIntelligence, 'getSnapshot' | 'subscribe' | 'request'>;
    enabled: boolean;
}>;
const noSubscription = () => () => undefined;
const noCapability = () => '';

/** Visible demand only: reading never starts a server, and pointer/caret publications do no work. */
export function useCodeLinesSemanticTokens(binding: CodeLinesSemanticBinding | undefined, lines: readonly CodeLine[]) {
    const controller = binding?.controller;
    const capability = React.useSyncExternalStore(controller?.subscribe ?? noSubscription,
        controller ? () => {
            const snapshot = controller.getSnapshot();
            if (!snapshot.capabilities?.semanticTokensRange && !snapshot.capabilities?.semanticTokensDelta) return '';
            const servers = snapshot.servers;
            if (servers && !servers.some(server => server.state === 'ready' && !server.loading)) return '';
            return JSON.stringify(servers?.map(server => [server.serverId, server.generation, server.state, server.loading]) ?? true);
        } : noCapability, noCapability);
    const [visible, setVisible] = React.useState<Readonly<{ first: number; last: number }> | null>(null);
    const onVisibleIndices = React.useCallback((indices: readonly number[]) => {
        const first = Math.min(...indices), last = Math.max(...indices);
        setVisible(previous => !indices.length ? previous === null ? previous : null
            : previous?.first === first && previous.last === last ? previous : { first, last });
    }, []);
    const firstLine = visible ? lines[visible.first] : undefined;
    const lastLine = visible ? lines[visible.last] : undefined;
    const start = firstLine?.newLine;
    const end = lastLine?.newLine;
    const endCharacter = lastLine?.renderCodeText.length;
    const enabled = binding?.enabled === true && capability !== '';
    const [answer, setAnswer] = React.useState<Readonly<{ lines: readonly CodeLine[]; first: number; last: number; capability: string;
        tokens: ReturnType<typeof projectCodeSemanticTokens> }> | null>(null);
    React.useEffect(() => {
        if (!enabled || !controller || start == null || end == null || endCharacter === undefined) return;
        const abort = new AbortController();
        const range = { start: { line: start - 1, character: 0 }, end: { line: end - 1, character: endCharacter } };
        void controller.request('semanticTokens', { range }, abort.signal).then(result => {
            if (abort.signal.aborted) return;
            setAnswer(result?.status === 'ok' && result.kind === 'semanticTokens'
                ? { lines, first: start, last: end, capability, tokens: projectCodeSemanticTokens(result.tokens, range) } : null);
        }).catch(() => { if (!abort.signal.aborted) setAnswer(null); });
        return () => abort.abort();
    }, [controller, enabled, capability, lines, start, end, endCharacter]);
    return { onVisibleIndices, tokens: enabled && answer?.capability === capability && answer.lines === lines && answer.first === start && answer.last === end ? answer.tokens : undefined };
}
