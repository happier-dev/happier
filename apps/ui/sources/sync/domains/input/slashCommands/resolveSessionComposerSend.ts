import { parseSessionSlashCommand } from './parseSessionSlashCommand';
import type { ActionId, PromptInvocationBehaviorV1, PromptInvocationsV1 } from '@happier-dev/protocol';
import { normalizePromptInvocationTokenV1 } from '@happier-dev/protocol';
import { findBuiltInPrompt } from './builtInPrompts';
import { renderPromptTemplateTextV1 } from './renderPromptTemplateTextV1';

export type SessionComposerSendResolution =
    | { kind: 'noop' }
    | { kind: 'send'; text: string }
    | { kind: 'action'; actionId: ActionId; rest: string }
    | { kind: 'goal'; command: 'open' | 'status' | 'pause' | 'resume' | 'complete' | 'clear' }
    | { kind: 'goal'; command: 'set'; objective: string }
    | {
        kind: 'template';
        invocationId: string;
        token: string;
        title: string;
        targetArtifactId: string;
        behavior: PromptInvocationBehaviorV1;
        allowArgs: boolean;
        rest: string;
    };

const RESERVED_TOKENS: ReadonlySet<string> = new Set(['/clear', '/compact']);

function resolveGoalCommand(input: string): Extract<SessionComposerSendResolution, { kind: 'goal' }> | null {
    const trimmed = input.trim();
    if (!trimmed.startsWith('/goal')) return null;

    const firstSpace = trimmed.search(/\s/);
    const token = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
    if (token !== '/goal') return null;

    const rest = firstSpace === -1 ? '' : trimmed.slice(firstSpace).trim();
    if (!rest) return { kind: 'goal', command: 'open' };

    const commandEnd = rest.search(/\s/);
    const command = commandEnd === -1 ? rest : rest.slice(0, commandEnd);
    const commandRest = commandEnd === -1 ? '' : rest.slice(commandEnd).trim();

    if (command === 'set') {
        return commandRest.length > 0 ? { kind: 'goal', command: 'set', objective: commandRest } : null;
    }
    if (
        command === 'status' ||
        command === 'pause' ||
        command === 'resume' ||
        command === 'complete' ||
        command === 'clear'
    ) {
        return commandRest.length === 0 ? { kind: 'goal', command } : null;
    }

    return null;
}

export function resolveSessionComposerSend(args: {
    input: string;
    executionRunsEnabled: boolean;
    goalControlsAvailable?: boolean;
    promptInvocationsV1?: PromptInvocationsV1 | null;
}): SessionComposerSendResolution {
    const trimmedStart = args.input.trimStart();

    if (trimmedStart.startsWith('//')) {
        // Escape hatch: `//cmd` should send `/cmd` to the agent unchanged, bypassing local interception.
        const rest = trimmedStart.slice(2).trim();
        if (rest.length === 0) return { kind: 'noop' };
        return { kind: 'send', text: `/${rest}` };
    }

    const parsedSlash = parseSessionSlashCommand(args.input);
    if (parsedSlash?.kind === 'action') {
        const actionId = String(parsedSlash.actionId ?? '').trim();
        // If the UI feature is disabled, do not intercept execution-run start commands: pass through as normal message.
        if (
            !args.executionRunsEnabled &&
            (actionId === 'review.start' || actionId === 'subagents.plan.start' || actionId === 'subagents.delegate.start')
        ) {
            return { kind: 'send', text: args.input };
        }
        return parsedSlash;
    }

    const goalCommand = resolveGoalCommand(args.input);
    if (goalCommand) {
        return args.goalControlsAvailable === false
            ? { kind: 'send', text: args.input }
            : goalCommand;
    }

    // Built-in core slash prompts (for example /happier-diagnose) are available without
    // a live provider process and cannot be shadowed by user prompt invocations.
    {
        const trimmed = args.input.trim();
        if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
            const firstSpace = trimmed.search(/\s/);
            const rawToken = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
            const normalizedToken = normalizePromptInvocationTokenV1(rawToken);
            if (!RESERVED_TOKENS.has(normalizedToken)) {
                const rest = firstSpace === -1 ? '' : trimmed.slice(firstSpace).trim();
                const builtIn = findBuiltInPrompt(normalizedToken);
                if (builtIn) {
                    if (!builtIn.allowArgs && rest.length > 0) {
                        return { kind: 'send', text: args.input };
                    }
                    return {
                        kind: 'send',
                        text: renderPromptTemplateTextV1({
                            templateMarkdown: builtIn.body,
                            argsText: rest,
                        }),
                    };
                }
            }
        }
    }

    // NOTE: Template invocations are opt-in via settings and never override reserved tokens.
    const invocations = args.promptInvocationsV1?.entries;
    if (Array.isArray(invocations) && invocations.length > 0) {
        const trimmed = args.input.trim();
        if (trimmed.startsWith('/')) {
            const firstSpace = trimmed.search(/\s/);
            const rawToken = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
            const normalizedToken = normalizePromptInvocationTokenV1(rawToken);

            if (!RESERVED_TOKENS.has(normalizedToken)) {
                const rest = firstSpace === -1 ? '' : trimmed.slice(firstSpace).trim();
                for (const entry of invocations) {
                    if (!entry || typeof entry !== 'object') continue;
                    const token = typeof (entry as any).token === 'string' ? String((entry as any).token) : '';
                    if (!token) continue;
                    if (normalizePromptInvocationTokenV1(token) !== normalizedToken) continue;

                    const allowArgs = (entry as any).allowArgs === true;
                    if (!allowArgs && rest.trim().length > 0) {
                        return { kind: 'send', text: args.input };
                    }

                    const invocationId = typeof (entry as any).id === 'string' ? String((entry as any).id) : '';
                    const title = typeof (entry as any).title === 'string' ? String((entry as any).title) : token;
                    const rawBehavior = typeof (entry as any).behavior === 'string' ? String((entry as any).behavior) : '';
                    const behavior = rawBehavior === 'insert_and_send' || rawBehavior === 'insert_on_send'
                        ? rawBehavior
                        : 'insert';
                    const targetArtifactId = typeof (entry as any).target?.artifactId === 'string'
                        ? String((entry as any).target.artifactId)
                        : '';

                    if (!invocationId || !targetArtifactId) return { kind: 'send', text: args.input };

                    return {
                        kind: 'template',
                        invocationId,
                        token,
                        title,
                        targetArtifactId,
                        behavior,
                        allowArgs,
                        rest,
                    };
                }
            }
        }
    }

    // Exhaustive guard for future variants.
    return { kind: 'send', text: args.input };
}
