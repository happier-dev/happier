import type { JsonValue } from './contracts.js';
import type { PluginActionReadObserver } from './contracts.js';

const ACTION_INPUT_PARSER_PROPERTY = 'happierProtocolActionInputParser' as const;
const ACTION_RESULT_PARSER_PROPERTY = 'happierProtocolActionResultParser' as const;
const ACTION_READ_OBSERVER_PROPERTY = 'happierActionReadObserver' as const;

/** Captures an observer on the same immutable Action registration as its handler and parsers. */
export function withPluginActionReadObserver<I extends JsonValue, O extends JsonValue | void, TContext>(
    handler: (input: I, context: TContext) => O | Promise<O>,
    observer: PluginActionReadObserver<I, TContext>,
): (input: I, context: TContext) => O | Promise<O> {
    const captured = (input: I, context: TContext) => handler(input, context);
    for (const key of [ACTION_INPUT_PARSER_PROPERTY, ACTION_RESULT_PARSER_PROPERTY]) {
        const descriptor = Object.getOwnPropertyDescriptor(handler, key);
        if (descriptor) Object.defineProperty(captured, key, descriptor);
    }
    Object.defineProperty(captured, ACTION_READ_OBSERVER_PROPERTY, { value: observer });
    return Object.freeze(captured);
}

export function readPluginActionReadObserver(value: unknown): PluginActionReadObserver | undefined {
    if (typeof value !== 'function') return undefined;
    const observer: unknown = Reflect.get(value, ACTION_READ_OBSERVER_PROPERTY);
    return typeof observer === 'function' ? observer as PluginActionReadObserver : undefined;
}

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

type ActionHandlerWithInputParser = ((...args: never[]) => unknown) & Readonly<{
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
export function attachPluginActionInputParser<THandler extends (...args: never[]) => unknown>(
    handler: THandler,
    schema: ProtocolActionInputSchema,
): THandler {
    Object.defineProperty(handler, ACTION_INPUT_PARSER_PROPERTY, {
        value: createPluginActionParser(schema),
        configurable: false,
        enumerable: false,
        writable: false,
    });
    return handler;
}

/** Installs definePlugin's executable result semantics on its fresh handler wrapper. */
export function attachPluginActionResultParser<THandler extends (...args: never[]) => unknown>(
    handler: THandler,
    schema: ProtocolActionInputSchema,
): THandler {
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
