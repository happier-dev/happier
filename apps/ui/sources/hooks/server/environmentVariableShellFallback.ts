export const ENV_VAR_SHELL_FALLBACK_UNSET_MARKER = '__HAPPY_UNSET__';

const ENV_VAR_SHELL_FALLBACK_SET_STATE = 'S';
const ENV_VAR_SHELL_FALLBACK_UNSET_STATE = 'U';

function parseNullDelimitedShellFallbackOutput(stdout: string): Record<string, string | null> | null {
    if (!stdout.includes('\0')) return null;

    const values: Record<string, string | null> = {};
    const parts = stdout.split('\0');
    let parsedAny = false;

    for (let index = 0; index + 2 < parts.length; index += 3) {
        const state = parts[index];
        const name = parts[index + 1];
        const value = parts[index + 2];

        if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) continue;
        if (state !== ENV_VAR_SHELL_FALLBACK_SET_STATE && state !== ENV_VAR_SHELL_FALLBACK_UNSET_STATE) continue;

        values[name] = state === ENV_VAR_SHELL_FALLBACK_SET_STATE ? value : null;
        parsedAny = true;
    }

    return parsedAny ? values : null;
}

function parseLineBasedShellFallbackOutput(stdout: string): Record<string, string | null> {
    const values: Record<string, string | null> = {};
    const lines = stdout.split(/\r?\n/).filter((line) => line.length > 0);

    lines.forEach((line) => {
        if (!/^[A-Z_][A-Z0-9_]*=/.test(line)) return;

        const equalsIndex = line.indexOf('=');
        if (equalsIndex === -1) return;

        const name = line.substring(0, equalsIndex);
        const value = line.substring(equalsIndex + 1);
        values[name] = value === ENV_VAR_SHELL_FALLBACK_UNSET_MARKER ? null : value;
    });

    return values;
}

export function buildEnvironmentVariableShellFallbackCommand(varNames: string[]): string {
    return [
        `for name in ${varNames.join(' ')}; do`,
        'if [ -n "${!name+x}" ]; then',
        'printf \'S\\0%s\\0%s\\0\' "$name" "${!name}";',
        `else`,
        'printf \'U\\0%s\\0\\0\' "$name";',
        `fi;`,
        `done`,
    ].join(' ');
}

export function parseEnvironmentVariableShellFallbackOutput(stdout: string): Record<string, string | null> {
    return parseNullDelimitedShellFallbackOutput(stdout) ?? parseLineBasedShellFallbackOutput(stdout);
}
