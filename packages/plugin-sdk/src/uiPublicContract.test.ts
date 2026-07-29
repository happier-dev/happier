import type {
    PluginUiHostApi,
    PluginUiRenderSurface,
} from './ui.js';
// @ts-expect-error -- supported UI contracts use unsuffixed names.
import type { PluginHostedWebContributionV1 } from './ui.js';
// @ts-expect-error -- executable artifact rows are generated build output, not normal UI authoring API.
import type { PluginUiArtifactContribution } from './ui.js';
// @ts-expect-error -- executable artifact rows are generated build output, not normal UI authoring API.
import { defineUiArtifact } from './ui.js';
// @ts-expect-error -- hosted bridge wire envelopes are experimental, not normal UI authoring.
import type { PluginHostedWebBridgeEnvelopeV1 } from './ui.js';
// @ts-expect-error -- settings are manifest-owned and are not a UI convenience export.
import type { SettingDefinitionMap } from './ui.js';

import { createPluginUiHostApiClient } from './ui/client.js';
// @ts-expect-error -- callers infer the optional client options from the retained factory.
import type { CreatePluginUiHostApiClientOptions } from './ui/client.js';
// @ts-expect-error -- PluginUiHostApi has one normal owner: the UI aggregate.
import type { PluginUiHostApi as DuplicateClientPluginUiHostApi } from './ui/client.js';
// @ts-expect-error -- callers infer the client factory result instead of importing a convenience function type.
import type { CreatePluginUiHostApiClient } from './ui/client.js';

import {
    createReactNativeWebVitePlugins,
    definePluginUiBuildConfig,
    defineReactNativeWebViteBuildPreset,
} from './ui/build/index.js';
// @ts-expect-error -- callers infer build configuration from the retained factory.
import type { PluginUiBuildConfig } from './ui/build/index.js';
// @ts-expect-error -- callers infer build targets from the retained factory input.
import type { PluginUiBuildTarget } from './ui/build/index.js';
// @ts-expect-error -- callers infer artifact platforms from the retained target input.
import type { PluginUiArtifactPlatform } from './ui/build/index.js';
// @ts-expect-error -- callers infer the RNW preset input from the retained preset factory.
import type { ReactNativeWebViteBuildPresetInput } from './ui/build/index.js';
// @ts-expect-error -- hosted-web preset construction is host build machinery; authors declare build targets.
import type { HostedWebViteBuildPresetInput } from './ui/build/index.js';
// @ts-expect-error -- Re.Pack preset construction is host build machinery; authors declare build targets.
import type { ReactNativeRepackBuildPresetInput } from './ui/build/index.js';
// @ts-expect-error -- supported build inputs use unsuffixed names.
import type { HostedWebViteBuildPresetInputV1 } from './ui/build/index.js';
// @ts-expect-error -- the managed bundler runner is host build machinery, not normal author API.
import type { ManagedBundlerRunnerInputV1 } from './ui/build/index.js';

import { createPluginTestkit } from './testing/index.js';
// @ts-expect-error -- callers infer the testkit contract from the retained factory.
import type { PluginTestkit } from './testing/index.js';
// @ts-expect-error -- callers infer invocation options from the retained testkit method.
import type { PluginTestkitInvokeOptions } from './testing/index.js';
// @ts-expect-error -- callers infer registrations from the retained testkit method.
import type { PluginTestkitRegistration } from './testing/index.js';
// @ts-expect-error -- registration-scope state is a host boundary, not the normal author testkit.
import type { createPluginRegistrationScope as NormalCreatePluginRegistrationScope } from './testing/index.js';
// @ts-expect-error -- the zero-consumer service-reference adapter is not supported author API.
import type { createPluginServiceReferenceAdapter } from './testing/index.js';

import type {
    PluginHostedWebBridgeEnvelopeV1 as ExperimentalBridgeEnvelope,
    defineHostedWebBridgeMessage,
} from './experimental/uiHostedWebBridgeV1.js';
import type {
    PluginAgentRuntimeRegistration,
    PluginRegistrationRight,
    PluginRuntimeRegistration,
    createPluginRegistrationScope,
} from './experimental/testingRegistrationScope.js';

type InferredClientOptions = Parameters<typeof createPluginUiHostApiClient>[0];
type InferredBuildConfig = Parameters<typeof definePluginUiBuildConfig>[0];
type InferredBuildTarget = InferredBuildConfig['targets'][number];
type InferredArtifactPlatform = InferredBuildTarget['platforms'][number];
type InferredReactNativeWebPresetInput =
    Parameters<typeof defineReactNativeWebViteBuildPreset>[0];
type InferredTestkit = Awaited<ReturnType<typeof createPluginTestkit>>;
type InferredTestkitInvokeOptions =
    Parameters<InferredTestkit['invokeAction']>[2];
type InferredTestkitRegistration =
    ReturnType<InferredTestkit['registrations']>[number];

type PublicContractProof =
    | PluginUiHostApi
    | PluginUiRenderSurface
    | InferredClientOptions
    | DuplicateClientPluginUiHostApi
    | InferredArtifactPlatform
    | InferredBuildConfig
    | InferredBuildTarget
    | InferredReactNativeWebPresetInput
    | InferredTestkit
    | InferredTestkitInvokeOptions
    | InferredTestkitRegistration
    | ExperimentalBridgeEnvelope
    | PluginRegistrationRight
    | PluginAgentRuntimeRegistration
    | PluginRuntimeRegistration;

void (undefined as unknown as PublicContractProof);
void (undefined as unknown as typeof defineHostedWebBridgeMessage);
void (undefined as unknown as typeof createPluginRegistrationScope);
void (undefined as unknown as typeof NormalCreatePluginRegistrationScope);
void (undefined as unknown as typeof createReactNativeWebVitePlugins);

describe('UI/testing public type contract', () => {
    it('is enforced by the TypeScript imports in this module', () => {
        expect(true).toBe(true);
    });
});
import { describe, expect, it } from 'vitest';
