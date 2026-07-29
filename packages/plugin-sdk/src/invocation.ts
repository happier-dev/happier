import type { PluginServices } from './services/index.js';
import type { PluginDiagnosticData } from './diagnostics.js';
import type {
    JsonValue,
    PluginIdentity,
    PluginInvocationContributionIdentity,
} from './identity.js';

export type PluginInvocationSurface = 'cli' | 'mcp' | 'agent' | 'ui';

export type PluginUiSeverity = 'info' | 'warning' | 'error';

export type PluginUiApprovalRequest = Readonly<{
    title: string;
    description?: string;
    subject: Readonly<{
        kind: 'tool';
        name: string;
        input: JsonValue;
    }>;
    allowSessionPersistence?: boolean;
}>;

export type PluginUiApprovalResult =
    | Readonly<{ status: 'approved'; persistence: 'once' | 'session' }>
    | Readonly<{ status: 'denied'; rationale?: string }>
    | Readonly<{ status: 'cancelled'; diagnostic?: PluginDiagnosticData }>
    | Readonly<{ status: 'unavailable'; diagnostic: PluginDiagnosticData }>;

export type PluginUiQuestionChoice = Readonly<{
    id: string;
    label?: string;
    description?: string;
}>;

export type PluginUiQuestion =
    | Readonly<{
        id: string;
        prompt: string;
        type: 'text';
        required?: boolean;
    }>
    | Readonly<{
        id: string;
        prompt: string;
        type: 'single' | 'multiple';
        required?: boolean;
        choices: readonly [PluginUiQuestionChoice, ...PluginUiQuestionChoice[]];
        allowCustom?: boolean;
    }>;

export type PluginUiChoiceAnswer =
    | Readonly<{ type: 'choice'; choiceId: string }>
    | Readonly<{ type: 'custom'; value: string }>;

export type PluginUiQuestionAnswer =
    | Readonly<{ type: 'text'; value: string }>
    | Readonly<{ type: 'single'; answer: PluginUiChoiceAnswer }>
    | Readonly<{ type: 'multiple'; answers: readonly [PluginUiChoiceAnswer, ...PluginUiChoiceAnswer[]] }>;

export type PluginUiQuestionsResult =
    | Readonly<{ status: 'answered'; answers: Readonly<Record<string, PluginUiQuestionAnswer>> }>
    | Readonly<{ status: 'cancelled'; diagnostic?: PluginDiagnosticData }>
    | Readonly<{ status: 'unavailable'; diagnostic: PluginDiagnosticData }>;

export type PluginUiWidget = Readonly<{
    placement: 'beforeComposer' | 'afterComposer';
    lines: readonly string[];
}>;

/**
 * Author-facing UI intent for the current invocation.
 *
 * The host owns target selection, correlation, deduplication, reconnect state,
 * and present-user interaction custody. Structured questions return a typed
 * terminal result; presentation effects reject with `PluginError` when they are
 * unavailable, conflicted, cancelled, or may have been applied without a
 * conclusive acknowledgement.
 */
export interface PluginInvocationUi {
    requestApproval(request: PluginUiApprovalRequest): Promise<PluginUiApprovalResult>;
    askQuestions(
        questions: readonly [PluginUiQuestion, ...PluginUiQuestion[]],
        options?: Readonly<{ title?: string }>,
    ): Promise<PluginUiQuestionsResult>;
    confirm(message: string, options?: Readonly<{ title?: string }>): Promise<boolean>;
    notify(message: string, options?: Readonly<{ severity?: PluginUiSeverity }>): Promise<void>;
    readonly status: Readonly<{
        set(key: string, text: string | null): Promise<void>;
    }>;
    readonly widget: Readonly<{
        set(key: string, widget: PluginUiWidget | null): Promise<void>;
    }>;
    readonly title: Readonly<{
        set(title: string | null): Promise<void>;
    }>;
    readonly composer: Readonly<{
        replace(text: string): Promise<void>;
    }>;
}

export interface PluginInvocationContext {
    readonly plugin: PluginIdentity;
    readonly contribution: PluginInvocationContributionIdentity;
    readonly surface?: PluginInvocationSurface;
    readonly session?: Readonly<{ id: string }>;
    readonly signal: AbortSignal;
    readonly services: PluginServices;
    readonly ui: PluginInvocationUi;
}

export interface AgentRuntimeFactoryContext {
    readonly plugin: PluginIdentity;
    readonly agent: Readonly<{ id: string }>;
    readonly signal: AbortSignal;
}
