import { execFile, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import * as Zod from 'zod';
import { z } from 'zod/mini';
import * as ZodCore from 'zod/v4/core';
import EnglishLocale from 'zod/v4/locales/en.js';
import { ProtocolComposerRefV1Schema } from '@happier-dev/plugin-sdk/protocol';
import { MachineProvisionerCheckResultV1Schema } from '@happier-dev/plugin-sdk/machine-provisioners';
import { PluginUiArtifactsManifestV2Schema } from '@happier-dev/protocol/plugins/ui/uiArtifactsManifest';

import { compileUniversalPluginUiCommonJs } from '../../../../../packages/plugin-sdk/src/ui/build/universalCommonJsCompiler';
import { loadPluginModule } from './loadPluginModule';

const execute = promisify(execFile);
const bunCommand = process.env.HAPPIER_BUN_PATH || 'bun';
const hasBun = spawnSync(bunCommand, ['--version'], { encoding: 'utf8' }).status === 0;
const jitiEntry = createRequire(import.meta.url).resolve('jiti');

describe('portable CommonJS plugin host modules', () => {
    it('loads compiler output outside the installation with the host SDK and Zod identities', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-portable-host-'));
        const entryPath = join(root, 'entry.ts');
        const artifactPath = join(root, 'entry.cjs.bundle');
        try {
            await writeFile(entryPath, [
                "import { z } from 'zod/mini';",
                "import * as classic from 'zod';",
                "import defaultZod from 'zod';",
                "import * as core from 'zod/v4/core';",
                "import english from 'zod/v4/locales/en.js';",
                "import { ProtocolComposerRefV1Schema } from '@happier-dev/plugin-sdk/protocol';",
                "import { MachineProvisionerCheckResultV1Schema } from '@happier-dev/plugin-sdk/machine-provisioners';",
                "import { PluginUiArtifactsManifestV2Schema } from '@happier-dev/protocol/plugins/ui/uiArtifactsManifest';",
                'export const read = () => ({ mini: z.string, classic: classic.string, defaultClassic: defaultZod.string, core: core.$ZodError, english, composer: ProtocolComposerRefV1Schema, machine: MachineProvisionerCheckResultV1Schema, manifest: PluginUiArtifactsManifestV2Schema, parsed: z.string().safeParse(42) });',
            ].join('\n'));
            const compiled = await compileUniversalPluginUiCommonJs({
                projectRoot: root, entryPath, artifactId: 'account-runtime', requestedExports: ['read'],
            });
            await writeFile(artifactPath, compiled.bytes);
            const source = { kind: 'file_backed' as const, entryPath: artifactPath,
                committedAuthorization: { pluginId: 'acme.portable-host', immutableGenerationId: artifactPath } };
            const first = await loadPluginModule({ source });
            const second = await loadPluginModule({ source });
            expect(second).toBe(first);
            if (typeof first.read !== 'function') throw new Error('Missing authored read export');
            expect(first.read()).toEqual({ mini: z.string, classic: Zod.string, defaultClassic: Zod.string, core: ZodCore.$ZodError,
                english: EnglishLocale, composer: ProtocolComposerRefV1Schema, machine: MachineProvisionerCheckResultV1Schema,
                manifest: PluginUiArtifactsManifestV2Schema, parsed: expect.objectContaining({ success: false }) });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('refuses a Protocol subpath the host does not provide instead of loading another copy', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-portable-missing-'));
        const artifactPath = join(root, 'entry.cjs.bundle');
        try {
            await writeFile(artifactPath, "module.exports.read = require('@happier-dev/protocol/not/provided').value;");
            await expect(loadPluginModule({ source: { kind: 'file_backed', entryPath: artifactPath,
                committedAuthorization: { pluginId: 'acme.portable-missing', immutableGenerationId: artifactPath } } }))
                .rejects.toMatchObject({ code: 'PLUGIN_DAEMON_MODULE_LOAD_FAILED',
                    cause: expect.objectContaining({ code: 'unknown_host_module', specifier: '@happier-dev/protocol/not/provided' }) });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('preserves artifact-relative native dependencies, CommonJS module identity and generation replacement', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-portable-native-'));
        const entryPath = join(root, 'entry.cjs.bundle');
        const source = { kind: 'file_backed' as const, entryPath,
            committedAuthorization: { pluginId: 'acme.portable-native', immutableGenerationId: root } };
        try {
            await writeFile(join(root, 'dependency.cjs'), 'module.exports = { value: 7 };');
            await writeFile(entryPath, 'exports.read = () => ({ value: require("./dependency.cjs").value, same: require.cache[__filename].exports === module.exports, path: require.resolve("./dependency.cjs") });');
            const first = await loadPluginModule({ source, cacheKey: 'first' });
            if (typeof first.read !== 'function') throw new Error('Missing native dependency fixture');
            expect(first.read()).toEqual({ value: 7, same: true, path: join(root, 'dependency.cjs') });
            await writeFile(entryPath, 'module.exports = { value: 8 };');
            expect(await loadPluginModule({ source, cacheKey: 'first' })).toBe(first);
            expect(await loadPluginModule({ source, cacheKey: 'second' })).toEqual({ value: 8 });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it.for(['node', 'bun-source', 'bun-compiled'] as const)('executes shared host bindings in the %s payload', async (runtime, context) => {
        if (runtime !== 'node' && !hasBun) return context.skip();
        const repoRoot = resolve(import.meta.dirname, '../../../../..');
        const payloadRoot = await mkdtemp(join(repoRoot, '.project/tmp/cli-cjs-payload-'));
        const artifactRoot = await mkdtemp(join(tmpdir(), 'happier-portable-payload-artifact-'));
        try {
            const authorPath = join(artifactRoot, 'entry.ts');
            const artifactPath = join(artifactRoot, 'entry.cjs.bundle');
            await writeFile(authorPath, "import { ProtocolComposerRefV1Schema } from '@happier-dev/plugin-sdk/protocol'; import { MachineProvisionerCheckResultV1Schema } from '@happier-dev/plugin-sdk/machine-provisioners'; import { z } from 'zod/mini'; export const read = () => ({ schema: ProtocolComposerRefV1Schema, machine: MachineProvisionerCheckResultV1Schema, string: z.string });");
            const compiled = await compileUniversalPluginUiCommonJs({ projectRoot: artifactRoot,
                entryPath: authorPath, artifactId: 'account-runtime', requestedExports: ['read'] });
            await writeFile(artifactPath, compiled.bytes);
            const probePath = join(payloadRoot, 'probe.ts');
            await writeFile(probePath, [
                `import { loadPluginModule } from ${JSON.stringify(join(repoRoot, 'apps/cli/src/plugins/runtime/loadPluginModule.ts'))};`,
                "import { ProtocolComposerRefV1Schema } from '@happier-dev/plugin-sdk/protocol';",
                "import { MachineProvisionerCheckResultV1Schema } from '@happier-dev/plugin-sdk/machine-provisioners';",
                "import { z } from 'zod/mini';",
                'const entryPath = process.argv[2];',
                'const source = { kind: "file_backed", entryPath, committedAuthorization: { pluginId: "acme.portable-payload", immutableGenerationId: entryPath } };',
                'const first = await loadPluginModule({ source }); const second = await loadPluginModule({ source });',
                'const value = first.read();',
                'if (value.schema !== ProtocolComposerRefV1Schema || value.machine !== MachineProvisionerCheckResultV1Schema || value.string !== z.string || first !== second) throw new Error("Shared host identity failed");',
                'console.log("portable-host-shared:PASS");',
            ].join('\n'));
            const payloadPath = join(payloadRoot, 'probe.mjs');
            await build({ entryPoints: [probePath], outfile: payloadPath, bundle: true, platform: 'node',
                format: 'esm', conditions: ['happier-source'],
                plugins: [{ name: 'native-jiti-host', setup(builder) {
                    builder.onResolve({ filter: /^jiti$/ }, () => ({ path: jitiEntry, external: true }));
                } }],
                tsconfig: join(repoRoot, 'apps/cli/tsconfig.json'),
                banner: { js: 'import { createRequire as createPayloadRequire } from "node:module"; const require = createPayloadRequire(import.meta.url);' } });
            let executable = runtime === 'node' ? process.execPath : bunCommand;
            let args = [payloadPath, artifactPath];
            if (runtime === 'bun-compiled') {
                executable = join(payloadRoot, process.platform === 'win32' ? 'probe.exe' : 'probe');
                await execute(bunCommand, ['build', payloadPath, '--compile', '--external', jitiEntry, '--outfile', executable], { cwd: repoRoot });
                args = [artifactPath];
            }
            const result = await execute(executable, args, { cwd: repoRoot });
            expect(result.stdout.trim()).toBe('portable-host-shared:PASS');
        } finally {
            await rm(payloadRoot, { recursive: true, force: true });
            await rm(artifactRoot, { recursive: true, force: true });
        }
    });
});
