import {
  createPublicToolchainCompatibilityV1,
  createPublicToolchainScaffoldBindingsV1,
  type PublicToolchainCompatibilityV1,
  type PublicToolchainScaffoldBindingsV1,
} from './toolchainCompatibility.js';
import { PUBLIC_TOOLCHAIN_COMPATIBILITY_V1 as generatedPacket } from './publicToolchainCompatibility.generated.js';

/**
 * The one source-derived compatibility packet for public plugin authoring.
 * The generator owns its bytes; this module owns validation and the public
 * SDK export so consumers never read generated internals directly.
 */
export const PUBLIC_TOOLCHAIN_COMPATIBILITY_V1: PublicToolchainCompatibilityV1 =
  createPublicToolchainCompatibilityV1(generatedPacket);

/**
 * The package-json/build-config projection of the same frozen packet.
 */
export const PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1: PublicToolchainScaffoldBindingsV1 =
  createPublicToolchainScaffoldBindingsV1(PUBLIC_TOOLCHAIN_COMPATIBILITY_V1);
