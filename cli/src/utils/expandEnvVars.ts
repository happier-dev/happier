import { logger } from '@/ui/logger';

/**
 * Expands ${VAR} references in environment variable values.
 *
 * CONTEXT:
 * Profiles can use ${VAR} syntax to reference daemon's environment:
 * Example: { ANTHROPIC_AUTH_TOKEN: "${Z_AI_AUTH_TOKEN}" }
 *
 * When daemon spawns sessions:
 * - Tmux mode: tmux launches a shell, but shells do not expand ${VAR} placeholders embedded inside env values automatically
 * - Non-tmux mode: Node.js spawn does NOT expand ${VAR} placeholders
 *
 * This utility ensures ${VAR} expansion works in both modes.
 *
 * @param envVars - Environment variables that may contain ${VAR} references
 * @param sourceEnv - Source environment (usually process.env) to resolve references from
 * @returns New object with all ${VAR} references expanded to actual values
 *
 * @example
 * ```typescript
 * const daemon_env = { Z_AI_AUTH_TOKEN: "sk-real-key" };
 * const profile_vars = { ANTHROPIC_AUTH_TOKEN: "${Z_AI_AUTH_TOKEN}" };
 *
 * const expanded = expandEnvironmentVariables(profile_vars, daemon_env);
 * // Result: { ANTHROPIC_AUTH_TOKEN: "sk-real-key" }
 * ```
 */
export function expandEnvironmentVariables(
    envVars: Record<string, string>,
    sourceEnv: NodeJS.ProcessEnv = process.env,
    options?: {
        warnOnUndefined?: boolean;
    }
): Record<string, string> {
    const expanded: Record<string, string> = {};
    const undefinedVars: string[] = [];
    const assignedEnv: Record<string, string> = {};
    const maxDepth = 5;

    function readEnv(varName: string): string | undefined {
        if (Object.prototype.hasOwnProperty.call(assignedEnv, varName)) {
            return assignedEnv[varName];
        }
        return sourceEnv[varName];
    }

    function findClosingBrace(value: string, startAfterOpeningBrace: number): number | null {
        let nesting = 1;
        for (let i = startAfterOpeningBrace; i < value.length; i++) {
            const ch = value[i];
            if (ch === '$' && value[i + 1] === '{') {
                nesting++;
                i++;
                continue;
            }
            if (ch === '}') {
                nesting--;
                if (nesting === 0) return i;
            }
        }
        return null;
    }

    function splitTopLevelOperator(expr: string): { varName: string; operator: ':-' | ':=' | null; defaultValue?: string } {
        let nesting = 0;
        for (let i = 0; i < expr.length - 1; i++) {
            const ch = expr[i];
            if (ch === '$' && expr[i + 1] === '{') {
                nesting++;
                i++;
                continue;
            }
            if (ch === '}' && nesting > 0) {
                nesting--;
                continue;
            }

            if (nesting === 0 && ch === ':' && (expr[i + 1] === '-' || expr[i + 1] === '=')) {
                const operator = expr[i + 1] === '-' ? ':-' : ':=';
                const varName = expr.substring(0, i);
                const defaultValue = expr.substring(i + 2);
                return { varName, operator, defaultValue };
            }
        }

        return { varName: expr, operator: null };
    }

    function expandValue(value: string, depth: number): string {
        if (depth > maxDepth) return value;

        let cursor = 0;
        let out = '';

        while (cursor < value.length) {
            const start = value.indexOf('${', cursor);
            if (start === -1) {
                out += value.substring(cursor);
                break;
            }

            out += value.substring(cursor, start);

            const end = findClosingBrace(value, start + 2);
            if (end === null) {
                out += value.substring(start);
                break;
            }

            const expr = value.substring(start + 2, end);
            const { varName, operator, defaultValue } = splitTopLevelOperator(expr);

            const resolvedValue = readEnv(varName);
            const shouldTreatEmptyAsMissing = defaultValue !== undefined;
            const isMissing = resolvedValue === undefined || (shouldTreatEmptyAsMissing && resolvedValue === '');

            if (!isMissing) {
                if (process.env.DEBUG) {
                    logger.debug(`[EXPAND ENV] Expanded ${varName} from daemon env`);
                }

                if (resolvedValue === '' && !Object.prototype.hasOwnProperty.call(assignedEnv, varName)) {
                    logger.warn(`[EXPAND ENV] WARNING: ${varName} is set but EMPTY in daemon environment`);
                }

                out += resolvedValue;
            } else if (defaultValue !== undefined) {
                if (process.env.DEBUG) {
                    logger.debug(`[EXPAND ENV] Using default value for ${varName}`);
                }

                const expandedDefault = expandValue(defaultValue, depth + 1);
                if (operator === ':=') {
                    assignedEnv[varName] = expandedDefault;
                }
                out += expandedDefault;
            } else {
                undefinedVars.push(varName);
                out += value.substring(start, end + 1);
            }

            cursor = end + 1;
        }

        return out;
    }

    for (const [key, value] of Object.entries(envVars)) {
        expanded[key] = expandValue(value, 0);
    }

    // Log warning if any variables couldn't be resolved
    const warnOnUndefined = options?.warnOnUndefined ?? true;
    const uniqueUndefinedVars = Array.from(new Set(undefinedVars));
    if (warnOnUndefined && uniqueUndefinedVars.length > 0) {
        logger.warn(`[EXPAND ENV] Undefined variables referenced in profile environment: ${uniqueUndefinedVars.join(', ')}`);
        logger.warn(`[EXPAND ENV] Session may fail to authenticate. Set these in daemon environment before launching:`);
        uniqueUndefinedVars.forEach(varName => {
            logger.warn(`[EXPAND ENV]   ${varName}=<your-value>`);
        });
    }

    return expanded;
}
