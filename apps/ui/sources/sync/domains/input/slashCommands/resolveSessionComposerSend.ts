import { parseSessionSlashCommand } from './parseSessionSlashCommand';
import type { ActionId } from '@happier-dev/protocol';

export type SessionComposerSendResolution =
    | { kind: 'noop' }
    | { kind: 'send'; text: string }
    | { kind: 'client.clear_input' }
    | { kind: 'action'; actionId: ActionId; rest: string };

export function resolveSessionComposerSend(args: {
    input: string;
    executionRunsEnabled: boolean;
}): SessionComposerSendResolution {
    const trimmedStart = args.input.trimStart();

    if (trimmedStart.startsWith('//')) {
        // Escape hatch: `//cmd` should send `/cmd` to the agent unchanged, bypassing local interception.
        const rest = trimmedStart.slice(2).trim();
        if (rest.length === 0) return { kind: 'noop' };
        return { kind: 'send', text: `/${rest}` };
    }

    const parsedSlash = parseSessionSlashCommand(args.input);
    if (!parsedSlash) return { kind: 'send', text: args.input };

    if (parsedSlash.kind === 'client.clear_input') {
        return { kind: 'client.clear_input' };
    }

    if (parsedSlash.kind === 'action') {
        const actionId = String(parsedSlash.actionId ?? '').trim();
        // If the UI feature is disabled, do not intercept execution-run start commands: pass through as normal message.
        if (
            !args.executionRunsEnabled &&
            (actionId === 'review.start' || actionId === 'plan.start' || actionId === 'delegate.start')
        ) {
            return { kind: 'send', text: args.input };
        }
        return parsedSlash;
    }

    // Exhaustive guard for future variants.
    return { kind: 'send', text: args.input };
}
