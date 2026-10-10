import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { transform } from 'esbuild';

/** Loads the installed SDK's real serializer without its unrelated native entrypoint. */
export async function loadInstalledExpoPathSerializer() {
    const require = createRequire(import.meta.url);
    // Published CommonJS requires bypass Vitest's RN aliases. Preserve the exact SDK
    // serializers and pure navigation validator rather than mocking path/query logic.
    const evaluate = async (path: string, overrides: Readonly<Record<string, unknown>>) => {
        const module: { exports: Record<string, unknown> } = { exports: {} };
        const sdkRequire = createRequire(path);
        const { code } = await transform(await readFile(path, 'utf8'), { loader: 'js', format: 'cjs' });
        new Function('exports', 'require', 'module', '__filename', '__dirname', code)(module.exports,
            (id: string) => Object.hasOwn(overrides, id) ? overrides[id] : sdkRequire(id), module, path, dirname(path));
        return module.exports;
    };
    const navigation = await evaluate(require.resolve('@react-navigation/core').replace(/index\.js$/, 'validatePathConfig.js'), {});
    const forks = await evaluate(require.resolve('expo-router/build/fork/getPathFromState-forks'), { '@react-navigation/native': navigation });
    return evaluate(require.resolve('expo-router/build/fork/getPathFromState'), { './getPathFromState-forks': forks });
}
