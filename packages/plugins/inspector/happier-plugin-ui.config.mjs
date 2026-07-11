import { createRequire } from 'node:module';
import { readdir, readFile } from 'node:fs/promises';
import { relative, join, sep } from 'node:path';

import { defineReactNativeRepackBuildPreset } from '@happier-dev/plugin-sdk/experimental/ui/reactNativeBuild';
import { resolveRepackBundleCommandOptions } from '@happier-dev/plugin-sdk/ui/build';

/**
 * NATIVE-PIPELINE (LEDGER DEC-6 follow-up, item 2): the REAL
 * `happier-plugin-build-ui` config for the inspector's iOS artifact — the
 * first plugin in this repo to exercise the `reactNative`/repack build
 * surface end-to-end (`buildUiArtifacts` → digest → `ui-artifacts.json`).
 *
 * BUNDLER-DISPATCH: `managedBundler.ts`'s generic managed-installable
 * dispatch is fixed — it now emits the argv each real bundler actually
 * accepts (`vite build`; `bundle --platform <p> --dev false --minify false
 * --reset-cache`), so the old "generic CLI-arg forwarding is broken" reason
 * for this config's direct path is gone. `runBundler` here remains an
 * in-process invocation of Re.Pack's exported `bundle` command function for
 * ONE remaining structural reason: the standalone `happier-plugin-build-ui`
 * bin has no host `ExecRuntimeServiceV1` wired into config loading yet, so a
 * plain config file cannot construct `createManagedRuntimeBundlerRunner`
 * (tracked residual, owned by the bin/exec-wiring seam). To keep the two
 * paths from drifting, the bundle options are no longer hand-rolled — they
 * derive from the SDK's canonical shared contract
 * (`resolveRepackBundleCommandOptions`, the in-process mirror of the generic
 * dispatch's CLI argv; both read `PLUGIN_UI_REPACK_BUNDLE_SETTINGS_V1`).
 */
const require = createRequire(import.meta.url);

const preset = defineReactNativeRepackBuildPreset({
    contributionId: 'inspector-app-native',
    platform: 'ios',
    sourceEntry: 'ui/renderSurface.tsx',
    repackVersion: '5.2.5',
    hostUiApiVersion: '1.0.0',
    compatibility: { reactVersion: '19.2.0', reactNativeVersion: '0.83.4' },
});

async function listFilesRecursive(root) {
    const entries = await readdir(root, { withFileTypes: true });
    const files = await Promise.all(entries.map(async (entry) => {
        const absolute = join(root, entry.name);
        if (entry.isDirectory()) {
            return listFilesRecursive(absolute);
        }
        return [absolute];
    }));
    return files.flat();
}

async function runRepackBundle(surface, context) {
    const commands = require('@callstack/repack/commands/rspack');
    const bundleCommand = commands.find((command) => command.name === 'bundle');
    const reactNativePath = require.resolve('react-native/package.json', { paths: [context.projectRoot] })
        .replace(/[/\\]package\.json$/u, '');

    await bundleCommand.func([], {
        root: context.projectRoot,
        platforms: [surface.preset.platform],
        reactNativePath,
    }, resolveRepackBundleCommandOptions(surface, {
        configPath: join(context.projectRoot, 'rspack.config.mjs'),
    }));

    const emittedRoot = join(context.projectRoot, surface.preset.output.root);
    const absoluteFiles = await listFilesRecursive(emittedRoot);
    const files = await Promise.all(absoluteFiles.map(async (absolutePath) => ({
        relativePath: `react-native/${surface.preset.contributionId}/${relative(emittedRoot, absolutePath).split(sep).join('/')}`,
        bytes: new Uint8Array(await readFile(absolutePath)),
    })));
    return { files };
}

export default {
    surfaces: [
        {
            kind: 'reactNative',
            preset,
            hostUiApiVersion: '1.0.0',
            compatibility: { reactVersion: '19.2.0', reactNativeVersion: '0.83.4' },
        },
    ],
    runBundler: runRepackBundle,
};
