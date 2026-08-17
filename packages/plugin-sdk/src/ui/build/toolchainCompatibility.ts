import {
    PublicToolchainCompatibilityV1Schema as canonicalPublicToolchainCompatibilityV1Schema,
    assertCoherentPublicToolchainCompatibilityV1,
} from '@happier-dev/protocol';
import type {
    PluginUiSchema,
    PublicToolchainAuthoringDependencyV1,
    PublicToolchainCompatibilityV1,
} from '../publicContract.js';

export {
    type PublicToolchainAuthoringDependencyV1,
    type PublicToolchainCompatibilityV1,
} from '../publicContract.js';

/** Protocol remains the sole parser and coherence owner for this release packet. */
export const PublicToolchainCompatibilityV1Schema: PluginUiSchema<PublicToolchainCompatibilityV1> =
    canonicalPublicToolchainCompatibilityV1Schema;

function freezePacketValue<T>(value: T): T {
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
        return value;
    }
    for (const nested of Object.values(value)) {
        freezePacketValue(nested);
    }
    return Object.freeze(value);
}

/**
 * The public SDK projection of the release-packaging packet. Candidate facts
 * remain release-owner inputs; this function deliberately has no defaults or
 * copied framework/version table that an authoring consumer could drift from.
 */
export function createPublicToolchainCompatibilityV1(
    candidate: unknown,
): PublicToolchainCompatibilityV1 {
    return freezePacketValue(assertCoherentPublicToolchainCompatibilityV1(candidate));
}

export type PublicToolchainScaffoldBindingsV1 = Readonly<{
    dependencies: Readonly<Record<
        '@happier-dev/plugin-sdk'
        | '@happier-dev/plugin-ui'
        | 'react'
        | 'react-dom'
        | 'react-native'
        | 'react-native-web',
        string
    >>;
    devDependencies: Readonly<Record<
        '@callstack/repack'
        | '@react-native-community/cli'
        | '@rspack/core'
        | '@swc/helpers'
        | '@types/node'
        | '@types/react'
        | '@typescript/native'
        | '@vitejs/plugin-react'
        | 'vite',
        string
    >>;
    reactNativeCompatibility: Readonly<{
        hostUiApiVersion: string;
        reactVersion: string;
        reactNativeVersion: string;
        viteVersion: string;
    }>;
    toolchain: Readonly<{
        expo: string;
        repack: string;
        runtime: string;
    }>;
}>;

function findRequiredBuildTool(
    packet: PublicToolchainCompatibilityV1,
    packageName: string,
    executable: string,
): Readonly<{ packageVersion: string }> {
    const tool = packet.buildTools.find((candidate) => (
        candidate.packageName === packageName && candidate.executable === executable
    ));
    if (!tool) {
        throw new Error(`Public toolchain packet is missing ${packageName}/${executable}.`);
    }
    return tool;
}

/**
 * The sole package-json/config projection used by generated author projects.
 * It is deliberately a pure projection of the strict public packet: callers
 * cannot supply defaults or mix a dependency from another candidate.
 */
export function createPublicToolchainScaffoldBindingsV1(
    candidate: unknown,
): PublicToolchainScaffoldBindingsV1 {
    const packet = createPublicToolchainCompatibilityV1(candidate);
    const vite = findRequiredBuildTool(packet, 'vite', 'vite');
    const repack = findRequiredBuildTool(packet, '@callstack/repack', 'react-native');
    if (vite.packageVersion !== packet.framework.vite) {
        throw new Error('Public toolchain packet Vite build-tool version disagrees with the framework fact.');
    }
    if (repack.packageVersion !== packet.framework.repack) {
        throw new Error('Public toolchain packet Re.Pack build-tool version disagrees with the framework fact.');
    }

    return Object.freeze({
        dependencies: Object.freeze({
            '@happier-dev/plugin-sdk': packet.pluginSdk.version,
            '@happier-dev/plugin-ui': packet.pluginUi.version,
            react: packet.framework.react,
            'react-dom': packet.authoringDependencies.reactDom.dependencySpec,
            'react-native': packet.framework.reactNative,
            'react-native-web': packet.framework.reactNativeWeb,
        }),
        devDependencies: Object.freeze({
            '@callstack/repack': packet.framework.repack,
            '@react-native-community/cli': packet.authoringDependencies.reactNativeCommunityCli.dependencySpec,
            '@rspack/core': packet.authoringDependencies.rspack.dependencySpec,
            '@swc/helpers': packet.authoringDependencies.swcHelpers.dependencySpec,
            '@types/node': packet.authoringDependencies.nodeTypes.dependencySpec,
            '@types/react': packet.authoringDependencies.reactTypes.dependencySpec,
            '@typescript/native': packet.authoringDependencies.typescriptNative.dependencySpec,
            '@vitejs/plugin-react': packet.authoringDependencies.viteReactPlugin.dependencySpec,
            vite: packet.framework.vite,
        }),
        reactNativeCompatibility: Object.freeze({
            hostUiApiVersion: packet.ui.hostApiVersion,
            reactVersion: packet.framework.react,
            reactNativeVersion: packet.framework.reactNative,
            viteVersion: packet.framework.vite,
        }),
        toolchain: Object.freeze({
            expo: packet.framework.expo,
            repack: packet.framework.repack,
            runtime: packet.framework.runtime,
        }),
    });
}
