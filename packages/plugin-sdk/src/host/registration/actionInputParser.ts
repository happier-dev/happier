import type { ActionHandler } from '../../actions/contracts.js';
import type { JsonValue } from '../../identity.js';

const ACTION_INPUT_PARSER_PROPERTY = 'happierProtocolActionInputParser' as const;
const ACTION_RESULT_PARSER_PROPERTY = 'happierProtocolActionResultParser' as const;

type PluginActionInputParserIssue = Readonly<{
    path: readonly (string | number)[];
    code: string;
    message: string;
}>;

type PluginActionInputParser = (input: JsonValue) => Readonly<
    | { success: true; data: unknown }
    | { success: false; issues: readonly PluginActionInputParserIssue[] }
>;

type PluginActionResultParser = PluginActionInputParser;

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
    [ACTION_RESULT_PARSER_PROPERTY]?: PluginActionResultParser;
}>;

function createPluginActionParser(schema: ProtocolActionInputSchema): PluginActionInputParser {
    return (input) => {
        const parsed = schema.safeParse(input);
        return parsed.success
            ? Object.freeze({ success: true as const, data: parsed.data })
            : Object.freeze({ success: false as const, issues: parsed.error.issues });
    };
}

/** Installs definePlugin's executable input semantics on its fresh handler wrapper. */
export function attachPluginActionInputParser(
    handler: ActionHandler,
    schema: ProtocolActionInputSchema,
): ActionHandler {
    Object.defineProperty(handler, ACTION_INPUT_PARSER_PROPERTY, {
        value: createPluginActionParser(schema),
        configurable: false,
        enumerable: false,
        writable: false,
    });
    return handler;
}

/** Installs definePlugin's executable result semantics on its fresh handler wrapper. */
export function attachPluginActionResultParser(
    handler: ActionHandler,
    schema: ProtocolActionInputSchema,
): ActionHandler {
    Object.defineProperty(handler, ACTION_RESULT_PARSER_PROPERTY, {
        value: createPluginActionParser(schema),
        configurable: false,
        enumerable: false,
        writable: false,
    });
    return handler;
}

/** Reads the one structural executable-parser carrier at registration/dispatch boundaries. */
export function readPluginActionInputParser(value: unknown): PluginActionInputParser | undefined {
    if (typeof value !== 'function') return undefined;
    const parser = (value as ActionHandlerWithInputParser)[ACTION_INPUT_PARSER_PROPERTY];
    return typeof parser === 'function' ? parser : undefined;
}

/** Reads the one structural executable result-parser carrier at registration/dispatch boundaries. */
export function readPluginActionResultParser(value: unknown): PluginActionResultParser | undefined {
    if (typeof value !== 'function') return undefined;
    const parser = (value as ActionHandlerWithInputParser)[ACTION_RESULT_PARSER_PROPERTY];
    return typeof parser === 'function' ? parser : undefined;
}
