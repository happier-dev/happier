import { DATABASE_STATEMENT_RUN_ACTION_ID_V1, DATABASE_STATEMENT_EXPLAIN_ACTION_ID_V1,
    type DatabaseDescriptorV1, type DatabaseOperationResultV1, type DatabaseStatementV1, type DatabaseValueV1 } from '@happier-dev/database-protocol';
import type { PluginUiActionControlController } from '@happier-dev/plugin-sdk/ui';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import type { createConsoleState } from './consoleState.js';
import type { WorkbenchClient, WorkbenchOptions, WorkbenchControlBinding } from './models.js';
import { createKeyedState } from './state.js';
import { selectConsoleStatements, type ConsoleSelection } from './consoleSelection.js';
import { databaseActionSettlement } from './actionSettlement.js';

export type ConsoleExecution = Readonly<{
    mode: 'read' | 'write'; running: boolean;
    result?: DatabaseOperationResultV1;
    error?: Readonly<{ message: string; code?: string; range?: ConsoleSelection; statementRange?: ConsoleSelection }>;
}>;
export type WorkbenchConsoleHost = Readonly<{
    consoleState(targetKey: string): ReturnType<typeof createConsoleState>;
    target(targetKey: string): DatabaseDescriptorV1;
    statementRanges: WorkbenchOptions['statementRanges'];
    client: Pick<WorkbenchClient, 'presentDeviceStorageError'>;
}>;
export function createConsole(instance: WorkbenchConsoleHost, targetKey: string) {
    const text = instance.consoleState(targetKey);
    const selection = createKeyedState<ConsoleSelection>(() => ({ start: 0, end: 0 }));
    const execution = createKeyedState<ConsoleExecution>(() => ({ mode: 'read', running: false }));
    let parameters: readonly (readonly DatabaseValueV1[])[] = [];
    let cancellation = new AbortController();
    let closed = false;
    function binding(explainMode?: 'plan' | 'analyze'): WorkbenchControlBinding {
        let submitted: ReturnType<typeof selectConsoleStatements> = [];
        let submittedMode: ConsoleExecution['mode'] = 'read';
        const controller: PluginUiActionControlController = {
            prepare({ signal }) {
                if (closed || signal.aborted || execution.get('run').running) return null;
                submittedMode = execution.get('run').mode;
                submitted = selectConsoleStatements(text.get().sql, selection.get('selection'), explainMode ? 'read' : submittedMode,
                    instance.statementRanges(text.get().sql, instance.target(targetKey).engine));
                if (!submitted.length) return null;
                const operands: DatabaseStatementV1[] = submitted.map((statement, index) => ({ sql: statement.sql, parameters: [...(parameters[index] ?? [])] }));
                const target = instance.target(targetKey).target;
                execution.set('run', { mode: submittedMode, running: true });
                return { input: projectNativeJsonValueForTransport(explainMode
                    ? { operation: 'statement.explain', target, statement: operands[0]!, mode: explainMode, accessMode: 'read' }
                    : submittedMode === 'read' ? { operation: 'statement.run', target, mode: submittedMode, statement: operands[0]! }
                        : { operation: 'statement.run', target, mode: submittedMode, executionMode: 'transaction', statements: operands }) };
            },
            onSettled(value) {
                if (closed) return;
                const settled = databaseActionSettlement(value, explainMode ? 'statement.explain' : 'statement.run');
                const mode = execution.get('run').mode;
                if (settled.status === 'success') {
                    const result = settled.result;
                    if (result.ok) {
                        execution.set('run', { mode, running: false, result });
                        void text.recordMany(submitted.map(({ sql }) => ({ sql }))).catch(instance.client.presentDeviceStorageError);
                    } else {
                        const cause = 'cause' in result ? result.cause : undefined;
                        const statement = submitted[cause?.statementIndex ?? 0];
                        const characters = statement ? [...statement.sql] : [];
                        const offset = cause?.position && statement ? characters.slice(0, cause.position - 1).join('').length + statement.range.start : undefined;
                        execution.set('run', { mode, running: false, result, error: { code: result.code,
                            message: cause?.message ?? ('reason' in result ? result.reason ?? result.code : result.code),
                            ...(statement ? { statementRange: statement.range } : {}), ...(offset === undefined ? {} : { range: { start: offset, end: offset + (characters[(cause?.position ?? 1) - 1]?.length ?? 0) } }) } });
                    }
                } else if (settled.status === 'error' || settled.status === 'outcomeUnknown') {
                    execution.set('run', { mode, running: false, error: { code: settled.code, message: settled.message } });
                } else execution.set('run', { mode, running: false });
                submitted = [];
            },
        };
        return { action: explainMode ? DATABASE_STATEMENT_EXPLAIN_ACTION_ID_V1 : DATABASE_STATEMENT_RUN_ACTION_ID_V1,
            controller, get signal() { return cancellation.signal; } };
    }
    const run = binding();
    const explain = binding('plan');
    const analyze = binding('analyze');
    return {
        text, selection, execution,
        setText: (sql: string) => text.edit(sql).catch(instance.client.presentDeviceStorageError),
        setSelection: (value: ConsoleSelection) => { const held = selection.get('selection'); if (held.start !== value.start || held.end !== value.end) selection.set('selection', value); },
        setMode: (mode: ConsoleExecution['mode']) => { const held = execution.get('run'); if (held.mode !== mode) execution.set('run', { ...held, mode }); },
        setParameters: (value: typeof parameters) => { parameters = value; },
        run: () => run, explain: (mode: 'plan' | 'analyze' = 'plan') => mode === 'analyze' ? analyze : explain,
        cancel: async () => {
            if (!execution.get('run').running) return;
            const running = cancellation;
            cancellation = new AbortController();
            running.abort();
        },
        clearHistory: () => text.clearHistory().catch(instance.client.presentDeviceStorageError),
        close() { closed = true; parameters = []; execution.set('run', { mode: 'read', running: false }); },
    };
}
export type WorkbenchConsole = ReturnType<typeof createConsole>;
