import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/** Source projection tests follow the same package condition as their Vite imports. */
export function createSdkSourceProgram(options: Readonly<{
    rootNames?: readonly string[];
    compilerOptions?: ts.CompilerOptions;
}> = {}): ts.Program {
    const configPath = fileURLToPath(new URL('../../tsconfig.json', import.meta.url));
    const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic(diagnostic) {
            throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
        },
    });
    if (!parsed) throw new Error(`Unable to parse ${configPath}`);
    return ts.createProgram({
        rootNames: [...(options.rootNames ?? parsed.fileNames)],
        options: {
            ...parsed.options,
            ...options.compilerOptions,
            // Expanded Zod declarations dominate the emitted Protocol graph.
            // These tests inspect current source, while the
            // publication and external-consumer lanes inspect emitted types.
            customConditions: [...new Set([...(parsed.options.customConditions ?? []), 'happier-source'])],
        },
        projectReferences: parsed.projectReferences,
    });
}
