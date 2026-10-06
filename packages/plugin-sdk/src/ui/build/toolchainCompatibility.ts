import { PublicToolchainCompatibilityV1Schema as canonicalPublicToolchainCompatibilityV1Schema, assertCoherentPublicToolchainCompatibilityV1 } from '@happier-dev/protocol/plugins/public-toolchain-compatibility';
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
        '@types/node'
        | '@types/react'
        | 'typescript'
        | '@typescript/native',
        string
    >>;
    toolchain: Readonly<{
        expo: string;
        runtime: string;
    }>;
}>;

/**
 * The sole package-json/config projection used by generated author projects.
 * It is deliberately a pure projection of the strict public packet: callers
 * cannot supply defaults or mix a dependency from another candidate.
 */
export function createPublicToolchainScaffoldBindingsV1(
    candidate: unknown,
): PublicToolchainScaffoldBindingsV1 {
    const packet = createPublicToolchainCompatibilityV1(candidate);
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
            '@types/node': packet.authoringDependencies.nodeTypes.dependencySpec,
            '@types/react': packet.authoringDependencies.reactTypes.dependencySpec,
            typescript: packet.authoringDependencies.typescript.dependencySpec,
            '@typescript/native': packet.authoringDependencies.typescriptNative.dependencySpec,
        }),
        toolchain: Object.freeze({
            expo: packet.framework.expo,
            runtime: packet.framework.runtime,
        }),
    });
}
