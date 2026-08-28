import type { ActionHandler } from '../../actions/contracts.js';
import type { JsonValue } from '../../identity.js';

const ACTION_INPUT_PARSER_PROPERTY = 'happierProtocolActionInputParser' as const;

type PluginActionInputParserIssue = Readonly<{
    path: readonly (string | number)[];
    code: string;
    message: string;
}>;

type PluginActionInputParser = (input: JsonValue) => Readonly<
    | { success: true; data: unknown }
    | { success: false; issues: readonly PluginActionInputParserIssue[] }
>;

type ProtocolActionInputSchema = Readonly<{
    safeParse(value: unknown): Readonly<
        | { success: true; data: JsonValue }
        | {
            success: false;
            error: Readonly<{
                issues: readonly PluginActionInputParserIssue[];
            }>;
        }
    >;
}>;

type ActionHandlerWithInputParser = ActionHandler & Readonly<{
    [ACTION_INPUT_PARSER_PROPERTY]?: PluginActionInputParser;
}>;

/** Installs definePlugin's executable input semantics on its fresh handler wrapper. */
export function attachPluginActionInputParser(
    handler: ActionHandler,
    schema: ProtocolActionInputSchema,
): ActionHandler {
    const inputParser: PluginActionInputParser = (input) => {
        const parsed = schema.safeParse(input);
        return parsed.success
            ? Object.freeze({ success: true as const, data: parsed.data })
            : Object.freeze({ success: false as const, issues: parsed.error.issues });
    };
    Object.defineProperty(handler, ACTION_INPUT_PARSER_PROPERTY, {
        value: inputParser,
        configurable: false,
        enumerable: false,
        writable: false,
    });
    return Object.freeze(handler);
}

/** Reads the one structural executable-parser carrier at registration/dispatch boundaries. */
export function readPluginActionInputParser(value: unknown): PluginActionInputParser | undefined {
    if (typeof value !== 'function') return undefined;
    const parser = (value as ActionHandlerWithInputParser)[ACTION_INPUT_PARSER_PROPERTY];
    return typeof parser === 'function' ? parser : undefined;
}
