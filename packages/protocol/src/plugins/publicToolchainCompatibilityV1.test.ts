import { describe, expect, it } from 'vitest';

import {
  PublicToolchainCompatibilityV1Schema,
  assertCoherentPublicToolchainCompatibilityV1,
} from './publicToolchainCompatibilityV1.js';

const packet = {
  schemaVersion: 1,
  host: { buildIdentity: 'happier-0.2.0' },
  pluginSdk: { version: '0.2.0' },
  pluginUi: { version: '0.2.0', pluginSdkVersion: '0.2.0' },
  framework: {
    react: '19.2.0',
    reactNative: '0.83.4',
    reactNativeWeb: '0.21.2',
    vite: '7.3.1',
    repack: '5.2.5',
    expo: '54.0.0',
    runtime: '0.2.0',
  },
  ui: { artifactGrammarVersion: 1, hostApiVersion: '1.0.0' },
  authoringDependencies: {
    nodeTypes: { packageName: '@types/node', dependencySpec: '22.15.3', resolvedVersion: '22.15.3' },
    reactDom: { packageName: 'react-dom', dependencySpec: '19.2.0', resolvedVersion: '19.2.0' },
    reactTypes: { packageName: '@types/react', dependencySpec: '19.2.0', resolvedVersion: '19.2.0' },
    reactNativeCommunityCli: { packageName: '@react-native-community/cli', dependencySpec: '20.1.2', resolvedVersion: '20.1.2' },
    rspack: { packageName: '@rspack/core', dependencySpec: '2.1.3', resolvedVersion: '2.1.3' },
    swcHelpers: { packageName: '@swc/helpers', dependencySpec: '0.5.23', resolvedVersion: '0.5.23' },
    typescript: { packageName: 'typescript', dependencySpec: '5.9.3', resolvedVersion: '5.9.3' },
    typescriptNative: { packageName: '@typescript/native', dependencySpec: 'npm:typescript@7.0.2', resolvedVersion: '7.0.2' },
    viteReactPlugin: { packageName: '@vitejs/plugin-react', dependencySpec: '4.7.0', resolvedVersion: '4.7.0' },
  },
  buildTools: [{ packageName: 'vite', packageVersion: '7.3.1', executable: 'vite', executableVersion: '7.3.1' }],
} as const;

describe('public toolchain compatibility packet', () => {
  it('keeps exact build provenance separate from an optional author-declared host range', () => {
    expect(PublicToolchainCompatibilityV1Schema.parse(packet)).toEqual(packet);
    expect(PublicToolchainCompatibilityV1Schema.parse({
      ...packet,
      host: { ...packet.host, enginesHappier: '^0.2.0' },
    })).toEqual({
      ...packet,
      host: { ...packet.host, enginesHappier: '^0.2.0' },
    });
  });

  it('is strict and fails closed when its SDK relationship disagrees', () => {
    expect(() => assertCoherentPublicToolchainCompatibilityV1({
      ...packet,
      pluginUi: { ...packet.pluginUi, pluginSdkVersion: '0.1.0' },
    })).toThrow(/plugin SDK/i);
    expect(PublicToolchainCompatibilityV1Schema.safeParse({
      ...packet,
      copiedVersionTable: true,
    }).success).toBe(false);
    expect(() => assertCoherentPublicToolchainCompatibilityV1({
      ...packet,
      authoringDependencies: {
        ...packet.authoringDependencies,
        reactTypes: { ...packet.authoringDependencies.reactTypes, packageName: '@types/node' },
      },
    })).toThrow(/duplicate authoring dependency/i);
  });
});
