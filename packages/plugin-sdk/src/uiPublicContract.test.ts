import type {
    PluginUiHostApi,
    RenderSurface,
    ResourceContent,
    UiHost,
    UiResource,
} from './ui.js';
import type {
    AgentUiBehaviorDeclarationV1 as CanonicalAgentUiBehaviorDeclarationV1,
    AgentUiComponentsDeclarationV1 as CanonicalAgentUiComponentsDeclarationV1,
    AgentUiMessageDeclarationV1 as CanonicalAgentUiMessageDeclarationV1,
    PluginDeclarativeNodeV2 as CanonicalPluginDeclarativeNodeV2,
} from '@happier-dev/protocol/plugins/manifest';
import type {
    ComposerAttachmentAuthorPresentationV1,
    ComposerAttachmentPresentationV1,
    PluginSessionHeaderActionDescriptor,
    PluginUiChannel,
    PluginUiDeclarativeNodeV2,
    PluginUiDeclarativeToneV2,
    PluginUiIconTokenV1,
    PluginUiPageHeaderActionV1,
    PluginUiSemanticCommandV1,
    PluginUiSessionServerStartDraftV1,
    PluginUiViewV2Input,
} from './ui/publicContract.js';
import type { SessionServerStartSpawnDraftV1 } from './services/sessions.js';
import type { ContributionSurfaceIcon } from './targetedContributionAuthoring.js';
import type {
    PluginUiIconTokenV1 as CanonicalPluginUiIconTokenV1,
    PluginUiToneV1 as CanonicalPluginUiToneV1,
} from '@happier-dev/protocol/plugins/contributions/ui/tokens';
import type { PluginUiChannelV1 as CanonicalPluginUiChannelV1 } from '@happier-dev/protocol/plugins/ui';
import type {
    PluginUiViewDestinationBindingInputV2 as CanonicalPluginUiViewDestinationBindingInputV2,
} from '@happier-dev/protocol/plugins/contributions/ui';
import type { PluginUiViewDestinationBindingInputV2 as SdkPluginUiViewDestinationBindingInputV2 } from './ui/publicContract.js';

/**
 * The Registry row — not a literal restated in this file — owns which container
 * admits page header actions and which instance policies it can key. Comparing
 * the SDK arms to a literal still passes after the Registry moves, so the whole
 * capability map is derived from BOTH sides and compared. `ViewArmFor`
 * distributes because the SDK collapses the four pane containers onto one arm
 * while the canonical grammar keeps one arm per Registry row.
 */
type ViewArmLike = { container: string; instancePolicy?: unknown; headerActions?: unknown };
type ViewArmFor<TBinding extends ViewArmLike, TContainer extends string> =
    TBinding extends ViewArmLike ? (TContainer extends TBinding['container'] ? TBinding : never) : never;
type AdmitsPageHeaderActions<T> = NonNullable<T> extends readonly [] ? false : true;
type ViewArmCapabilities<TBinding extends ViewArmLike> = {
    [TContainer in TBinding['container']]: Readonly<{
        instancePolicy: NonNullable<ViewArmFor<TBinding, TContainer>['instancePolicy']>;
        admitsPageHeaderActions: AdmitsPageHeaderActions<ViewArmFor<TBinding, TContainer>['headerActions']>;
    }>;
};

type CanonicalPluginUiDeclarativeToneV2 = NonNullable<
    Extract<CanonicalPluginDeclarativeNodeV2, Readonly<{ kind: 'text' }>>['tone']
>;
/**
 * Protocol owns the declarative grammar; `src/manifest.ts` declares an
 * SDK-local projection of it so an external author's own emitted `.d.ts` never
 * names Protocol's declaration site (which they cannot resolve — see the
 * comment on that projection). These assertions are the only thing keeping the
 * two in step, so they compare every union member individually as well as the
 * whole union: a whole-union `toEqualTypeOf` failure collapses into one
 * unreadable message, and the per-member form names the exact arm that drifted.
 */
type SdkDeclarativeNodeOfKind<TKind extends PluginUiDeclarativeNodeV2['kind']> =
    Extract<PluginUiDeclarativeNodeV2, { kind: TKind }>;
type CanonicalDeclarativeNodeOfKind<TKind extends CanonicalPluginDeclarativeNodeV2['kind']> =
    Extract<CanonicalPluginDeclarativeNodeV2, Readonly<{ kind: TKind }>>;
/* @sdk-negative-type-case:src-uiPublicContract-test-ts-declarative-node-kind:ZGVjbGFyYXRpdmUgbm9kZSBraW5kcyBhcmUgY2xvc2VkIGJ5IHRoZSBjYW5vbmljYWwgUHJvdG9jb2wgZ3JhbW1hci4=:Y29uc3QgaW52YWxpZERlY2xhcmF0aXZlTm9kZTogUGx1Z2luVWlEZWNsYXJhdGl2ZU5vZGVWMiA9IHsga2luZDogJ3VuYm91bmRlZCcgfTs= */
void undefined; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-uiPublicContract-test-ts-declarative-tone:ZGVjbGFyYXRpdmUgdGV4dCB0b25lcyBhcmUgY2xvc2VkIGJ5IHRoZSBjYW5vbmljYWwgUHJvdG9jb2wgZ3JhbW1hci4=:Y29uc3QgaW52YWxpZERlY2xhcmF0aXZlVG9uZTogUGx1Z2luVWlEZWNsYXJhdGl2ZU5vZGVWMiA9IHsga2luZDogJ3RleHQnLCB0ZXh0OiAnTm90IGNhbm9uaWNhbCcsIHRvbmU6ICduZXV0cmFsJyB9Ow== */
void undefined; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-uiPublicContract-test-ts-44:LS0gc3VwcG9ydGVkIFVJIGNvbnRyYWN0cyB1c2UgdW5zdWZmaXhlZCBuYW1lcy4:aW1wb3J0IHR5cGUgeyBQbHVnaW5Ib3N0ZWRXZWJDb250cmlidXRpb25WMSB9IGZyb20gJy4vdWkuanMnOw */
type PluginHostedWebContributionV1 = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-uiPublicContract-test-ts-45:LS0gZXhlY3V0YWJsZSBhcnRpZmFjdCByb3dzIGFyZSBnZW5lcmF0ZWQgYnVpbGQgb3V0cHV0LCBub3Qgbm9ybWFsIFVJIGF1dGhvcmluZyBBUEku:aW1wb3J0IHR5cGUgeyBQbHVnaW5VaUFydGlmYWN0Q29udHJpYnV0aW9uIH0gZnJvbSAnLi91aS5qcyc7 */
type PluginUiArtifactContribution = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-uiPublicContract-test-ts-46:LS0gZXhlY3V0YWJsZSBhcnRpZmFjdCByb3dzIGFyZSBnZW5lcmF0ZWQgYnVpbGQgb3V0cHV0LCBub3Qgbm9ybWFsIFVJIGF1dGhvcmluZyBBUEku:aW1wb3J0IHsgZGVmaW5lVWlBcnRpZmFjdCB9IGZyb20gJy4vdWkuanMnOw */
const defineUiArtifact = undefined as never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-uiPublicContract-test-ts-47:LS0gaG9zdGVkIGJyaWRnZSB3aXJlIGVudmVsb3BlcyBhcmUgZXhwZXJpbWVudGFsLCBub3Qgbm9ybWFsIFVJIGF1dGhvcmluZy4:aW1wb3J0IHR5cGUgeyBQbHVnaW5Ib3N0ZWRXZWJCcmlkZ2VFbnZlbG9wZVYxIH0gZnJvbSAnLi91aS5qcyc7 */
type PluginHostedWebBridgeEnvelopeV1 = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-uiPublicContract-test-ts-48:LS0gc2V0dGluZ3MgYXJlIG1hbmlmZXN0LW93bmVkIGFuZCBhcmUgbm90IGEgVUkgY29udmVuaWVuY2UgZXhwb3J0Lg:aW1wb3J0IHR5cGUgeyBTZXR0aW5nRGVmaW5pdGlvbk1hcCB9IGZyb20gJy4vdWkuanMnOw */
type SettingDefinitionMap = never; /* @sdk-negative-type-case-end */

import { createPluginUiHostApiClient } from './ui/client.js';
/* @sdk-negative-type-case:src-uiPublicContract-test-ts-49:LS0gY2FsbGVycyBpbmZlciB0aGUgb3B0aW9uYWwgY2xpZW50IG9wdGlvbnMgZnJvbSB0aGUgcmV0YWluZWQgZmFjdG9yeS4:aW1wb3J0IHR5cGUgeyBDcmVhdGVQbHVnaW5VaUhvc3RBcGlDbGllbnRPcHRpb25zIH0gZnJvbSAnLi91aS9jbGllbnQuanMnOw */
type CreatePluginUiHostApiClientOptions = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-uiPublicContract-test-ts-50:LS0gUGx1Z2luVWlIb3N0QXBpIGhhcyBvbmUgbm9ybWFsIG93bmVyOiB0aGUgVUkgYWdncmVnYXRlLg:aW1wb3J0IHR5cGUgeyBQbHVnaW5VaUhvc3RBcGkgYXMgRHVwbGljYXRlQ2xpZW50UGx1Z2luVWlIb3N0QXBpIH0gZnJvbSAnLi91aS9jbGllbnQuanMnOw */
type DuplicateClientPluginUiHostApi = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-uiPublicContract-test-ts-51:LS0gY2FsbGVycyBpbmZlciB0aGUgY2xpZW50IGZhY3RvcnkgcmVzdWx0IGluc3RlYWQgb2YgaW1wb3J0aW5nIGEgY29udmVuaWVuY2UgZnVuY3Rpb24gdHlwZS4:aW1wb3J0IHR5cGUgeyBDcmVhdGVQbHVnaW5VaUhvc3RBcGlDbGllbnQgfSBmcm9tICcuL3VpL2NsaWVudC5qcyc7 */
type CreatePluginUiHostApiClient = never; /* @sdk-negative-type-case-end */

import {
    createReactNativeWebVitePlugins,
    defineBuildConfig,
    defineReactNativeWebViteBuildPreset,
} from './ui/build/index.js';
import type {
    PluginUiArtifactPlatform,
    PluginUiBuildConfig,
    PluginUiBuildTarget,
} from './ui/build/index.js';
/* @sdk-negative-type-case:src-uiPublicContract-test-ts-56:LS0gaG9zdGVkLXdlYiBwcmVzZXQgY29uc3RydWN0aW9uIGlzIGhvc3QgYnVpbGQgbWFjaGluZXJ5OyBhdXRob3JzIGRlY2xhcmUgYnVpbGQgdGFyZ2V0cy4:aW1wb3J0IHR5cGUgeyBIb3N0ZWRXZWJWaXRlQnVpbGRQcmVzZXRJbnB1dCB9IGZyb20gJy4vdWkvYnVpbGQvaW5kZXguanMnOw */
type HostedWebViteBuildPresetInput = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-uiPublicContract-test-ts-57:LS0gUmUuUGFjayBwcmVzZXQgY29uc3RydWN0aW9uIGlzIGhvc3QgYnVpbGQgbWFjaGluZXJ5OyBhdXRob3JzIGRlY2xhcmUgYnVpbGQgdGFyZ2V0cy4:aW1wb3J0IHR5cGUgeyBSZWFjdE5hdGl2ZVJlcGFja0J1aWxkUHJlc2V0SW5wdXQgfSBmcm9tICcuL3VpL2J1aWxkL2luZGV4LmpzJzs */
type ReactNativeRepackBuildPresetInput = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-uiPublicContract-test-ts-58:LS0gc3VwcG9ydGVkIGJ1aWxkIGlucHV0cyB1c2UgdW5zdWZmaXhlZCBuYW1lcy4:aW1wb3J0IHR5cGUgeyBIb3N0ZWRXZWJWaXRlQnVpbGRQcmVzZXRJbnB1dFYxIH0gZnJvbSAnLi91aS9idWlsZC9pbmRleC5qcyc7 */
type HostedWebViteBuildPresetInputV1 = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-uiPublicContract-test-ts-59:LS0gdGhlIG1hbmFnZWQgYnVuZGxlciBydW5uZXIgaXMgaG9zdCBidWlsZCBtYWNoaW5lcnksIG5vdCBub3JtYWwgYXV0aG9yIEFQSS4:aW1wb3J0IHR5cGUgeyBNYW5hZ2VkQnVuZGxlclJ1bm5lcklucHV0VjEgfSBmcm9tICcuL3VpL2J1aWxkL2luZGV4LmpzJzs */
type ManagedBundlerRunnerInputV1 = never; /* @sdk-negative-type-case-end */

import { createPluginTestkit } from './testing/index.js';
import type { PluginTestkit } from './testing/index.js';
import type {
    PluginUiHostApiWireIdentityV1,
    PluginUiTestkitExecuteActionInput,
    PluginUiTestkitOpenSurfaceInput,
    PluginUiTestkitReadOpenableContentInput,
    PluginUiTestkitReadResourceInput,
    PluginUiTestkitStatOpenableContentInput,
    PluginUiTestkitWatchResourceInput,
} from './testing/index.js';
/* @sdk-negative-type-case:src-uiPublicContract-test-ts-60:LS0gY2FsbGVycyBpbmZlciBpbnZvY2F0aW9uIG9wdGlvbnMgZnJvbSB0aGUgcmV0YWluZWQgdGVzdGtpdCBtZXRob2Qu:aW1wb3J0IHR5cGUgeyBQbHVnaW5UZXN0a2l0SW52b2tlT3B0aW9ucyB9IGZyb20gJy4vdGVzdGluZy9pbmRleC5qcyc7 */
type PluginTestkitInvokeOptions = never; /* @sdk-negative-type-case-end */
import type { PluginTestkitRegistration } from './testing/index.js';
/* @sdk-negative-type-case:src-uiPublicContract-test-ts-61:LS0gcmVnaXN0cmF0aW9uLXNjb3BlIHN0YXRlIGlzIGEgaG9zdCBib3VuZGFyeSwgbm90IHRoZSBub3JtYWwgYXV0aG9yIHRlc3RraXQu:aW1wb3J0IHR5cGUgeyBjcmVhdGVQbHVnaW5SZWdpc3RyYXRpb25TY29wZSBhcyBOb3JtYWxDcmVhdGVQbHVnaW5SZWdpc3RyYXRpb25TY29wZSB9IGZyb20gJy4vdGVzdGluZy9pbmRleC5qcyc7 */
type NormalCreatePluginRegistrationScope = never;
declare const NormalCreatePluginRegistrationScope: never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-uiPublicContract-test-ts-62:LS0gdGhlIHplcm8tY29uc3VtZXIgc2VydmljZS1yZWZlcmVuY2UgYWRhcHRlciBpcyBub3Qgc3VwcG9ydGVkIGF1dGhvciBBUEku:aW1wb3J0IHR5cGUgeyBjcmVhdGVQbHVnaW5TZXJ2aWNlUmVmZXJlbmNlQWRhcHRlciB9IGZyb20gJy4vdGVzdGluZy9pbmRleC5qcyc7 */
type createPluginServiceReferenceAdapter = never; /* @sdk-negative-type-case-end */

import type {
    PluginHostedWebBridgeEnvelopeV1 as ExperimentalBridgeEnvelope,
} from './experimental/uiHostedWebBridgeV1.js';
import type {
    AgentUiBehaviorDeclarationV1,
    AgentUiComponentsDeclarationV1,
    AgentUiMessageDeclarationV1,
    PluginCollectionProjectedScalarFieldRefV1,
    PluginCollectionRowCommandV1,
    PluginContributionReference,
    PluginDeclarativeActionNodeV2,
    PluginDeclarativeActionPanelNodeV2,
    PluginDeclarativeActionVariantV2,
    PluginDeclarativeCollectionListNodeV2,
    PluginDeclarativeComposerApplyEffectV1,
    PluginDeclarativeControlV2,
    PluginDeclarativeItemNodeV2,
    PluginDeclarativeListNodeV2,
    PluginDeclarativeMetadataEntryV2,
    PluginDeclarativeMetadataNodeV2,
    PluginDeclarativeRowNodeV2,
    PluginDeclarativeSectionNodeV2,
    PluginDeclarativeStateNodeV2,
    PluginDeclarativeStateV2,
    PluginDeclarativeTargetedSurfaceNodeV2,
    PluginDeclarativeTargetedSurfaceReferenceV1,
    PluginDeclarativeToneV2,
    PluginLocalizedStringV2,
} from './manifest.js';
/**
 * EU-4b graduation proof. `watchResource` and its invalidation event now have a
 * real host producer end to end, so both are published on `./ui` and reached
 * here through the normal author entrypoint rather than an unreleased area.
 */
import type { ResourceSubscriptionEvent } from './ui.js';
import type { defineHostedWebBridgeMessage } from './ui.js';

type InferredClientOptions = Parameters<typeof createPluginUiHostApiClient>[0];
type InferredBuildConfig = Parameters<typeof defineBuildConfig>[0];
type InferredBuildTarget = InferredBuildConfig['targets'][number];
type InferredReactNativeBuildTarget = Extract<InferredBuildTarget, { kind: 'reactNative' }>;
type InferredArtifactPlatform = InferredReactNativeBuildTarget['platforms'][number];
type InferredReactNativeWebPresetInput =
    Parameters<typeof defineReactNativeWebViteBuildPreset>[0];
type InferredTestkit = Awaited<ReturnType<typeof createPluginTestkit>>;
type InferredTestkitInvokeOptions =
    Parameters<InferredTestkit['invokeAction']>[2];
type InferredTestkitRegistration =
    ReturnType<InferredTestkit['registrations']>[number];

/**
 * The SDK must preserve Protocol's readonly Composer contract at its public
 * Host API boundary. This deliberately checks the values a Plugin UI handle
 * closes over without creating a second handle abstraction here.
 */
function assertPublicComposerValuesAreReadonly(
    current: Readonly<{
        ref: Extract<Parameters<PluginUiHostApi['readComposer']>[0], { kind: 'session' }>;
    }>,
    snapshot: Extract<
        Awaited<ReturnType<PluginUiHostApi['readComposer']>>,
        { status: 'ready' }
    >['snapshot'],
    transaction: Parameters<PluginUiHostApi['applyComposer']>[1],
): void {
    /* @sdk-negative-type-case:src-uiPublicContract-test-ts-composer-ref-readonly:YSBwdWJsaWMgQ29tcG9zZXIgaGFuZGxlIGNhbm5vdCByZXRhcmdldCBpdHMgZXhhY3Qgc2NvcGUu:Y3VycmVudC5yZWYuc2Vzc2lvbklkID0gJ2RpZmZlcmVudC1zZXNzaW9uJzs */
    void current; /* @sdk-negative-type-case-end */
    /* @sdk-negative-type-case:src-uiPublicContract-test-ts-composer-attachments-readonly:YSBzbmFwc2hvdCBhdHRhY2htZW50IGxpc3QgaXMgb2JzZXJ2ZWQsIG5vdCBjYWxsZXItb3duZWQu:c25hcHNob3QuYXR0YWNobWVudHMucHVzaCgpOw */
    void snapshot; /* @sdk-negative-type-case-end */
    /* @sdk-negative-type-case:src-uiPublicContract-test-ts-composer-operations-readonly:YSB0cmFuc2FjdGlvbidzIG9wZXJhdGlvbiBsaXN0IGlzIGZpeGVkIG9uY2Ugc3VwcGxpZWQu:dHJhbnNhY3Rpb24ub3BlcmF0aW9ucyA9IFtdOw */
    void transaction; /* @sdk-negative-type-case-end */
}

void assertPublicComposerValuesAreReadonly;

type PublicContractProof =
    | PluginUiHostApi
    | RenderSurface
    | InferredClientOptions
    | DuplicateClientPluginUiHostApi
    | InferredArtifactPlatform
    | InferredBuildConfig
    | InferredBuildTarget
    | InferredReactNativeWebPresetInput
    | PluginUiArtifactPlatform
    | PluginUiBuildConfig
    | PluginUiBuildTarget
    | InferredTestkit
    | InferredTestkitInvokeOptions
    | InferredTestkitRegistration
    | PluginUiHostApiWireIdentityV1
    | PluginUiTestkitExecuteActionInput
    | PluginUiTestkitOpenSurfaceInput
    | PluginUiTestkitReadOpenableContentInput
    | PluginUiTestkitReadResourceInput
    | PluginUiTestkitStatOpenableContentInput
    | PluginUiTestkitWatchResourceInput
    | PluginDeclarativeCollectionListNodeV2
    | ExperimentalBridgeEnvelope
    | ResourceSubscriptionEvent
    | PluginUiHostApi['watchResource'];

void (undefined as unknown as PublicContractProof);
void (undefined as unknown as typeof defineHostedWebBridgeMessage);
void (undefined as unknown as typeof NormalCreatePluginRegistrationScope);
void (undefined as unknown as typeof createReactNativeWebVitePlugins);

describe('UI/testing public type contract', () => {
    it('keeps the concise author host and resource vocabulary identical to the canonical UI types', () => {
        expectTypeOf<UiHost>().toEqualTypeOf<PluginUiHostApi>();
        expectTypeOf<UiResource>().toEqualTypeOf<ResourceContent>();
    });

    it('projects Protocol’s closed declarative node and tone grammar without a UI-local dialect', () => {
        expectTypeOf<PluginUiDeclarativeNodeV2['kind']>()
            .toEqualTypeOf<CanonicalPluginDeclarativeNodeV2['kind']>();
        expectTypeOf<SdkDeclarativeNodeOfKind<'text'>>()
            .toEqualTypeOf<CanonicalDeclarativeNodeOfKind<'text'>>();
        expectTypeOf<SdkDeclarativeNodeOfKind<'markdown'>>()
            .toEqualTypeOf<CanonicalDeclarativeNodeOfKind<'markdown'>>();
        expectTypeOf<SdkDeclarativeNodeOfKind<'stack'>>()
            .toEqualTypeOf<CanonicalDeclarativeNodeOfKind<'stack'>>();
        expectTypeOf<SdkDeclarativeNodeOfKind<'group'>>()
            .toEqualTypeOf<CanonicalDeclarativeNodeOfKind<'group'>>();
        expectTypeOf<SdkDeclarativeNodeOfKind<'field'>>()
            .toEqualTypeOf<CanonicalDeclarativeNodeOfKind<'field'>>();
        expectTypeOf<SdkDeclarativeNodeOfKind<'status'>>()
            .toEqualTypeOf<CanonicalDeclarativeNodeOfKind<'status'>>();
        expectTypeOf<SdkDeclarativeNodeOfKind<'action'>>()
            .toEqualTypeOf<CanonicalDeclarativeNodeOfKind<'action'>>();
        expectTypeOf<SdkDeclarativeNodeOfKind<'list'>>()
            .toEqualTypeOf<CanonicalDeclarativeNodeOfKind<'list'>>();
        expectTypeOf<SdkDeclarativeNodeOfKind<'section'>>()
            .toEqualTypeOf<CanonicalDeclarativeNodeOfKind<'section'>>();
        expectTypeOf<SdkDeclarativeNodeOfKind<'item'>>()
            .toEqualTypeOf<CanonicalDeclarativeNodeOfKind<'item'>>();
        expectTypeOf<SdkDeclarativeNodeOfKind<'state'>>()
            .toEqualTypeOf<CanonicalDeclarativeNodeOfKind<'state'>>();
        expectTypeOf<SdkDeclarativeNodeOfKind<'targetedSurface'>>()
            .toEqualTypeOf<CanonicalDeclarativeNodeOfKind<'targetedSurface'>>();
        expectTypeOf<SdkDeclarativeNodeOfKind<'metadata'>>()
            .toEqualTypeOf<CanonicalDeclarativeNodeOfKind<'metadata'>>();
        expectTypeOf<SdkDeclarativeNodeOfKind<'actionPanel'>>()
            .toEqualTypeOf<CanonicalDeclarativeNodeOfKind<'actionPanel'>>();
        expectTypeOf<SdkDeclarativeNodeOfKind<'collectionList'>>()
            .toEqualTypeOf<CanonicalDeclarativeNodeOfKind<'collectionList'>>();
        expectTypeOf<PluginUiDeclarativeNodeV2>().toEqualTypeOf<CanonicalPluginDeclarativeNodeV2>();
        expectTypeOf<PluginUiDeclarativeToneV2>().toEqualTypeOf<CanonicalPluginUiDeclarativeToneV2>();
        // Every named export the SDK derives from the grammar is pinned too, so
        // one drifting projection cannot hide behind an equal whole union.
        expectTypeOf<PluginDeclarativeActionNodeV2>()
            .toEqualTypeOf<CanonicalDeclarativeNodeOfKind<'action'>>();
        expectTypeOf<PluginDeclarativeActionPanelNodeV2>()
            .toEqualTypeOf<CanonicalDeclarativeNodeOfKind<'actionPanel'>>();
        expectTypeOf<PluginDeclarativeCollectionListNodeV2>()
            .toEqualTypeOf<CanonicalDeclarativeNodeOfKind<'collectionList'>>();
        expectTypeOf<PluginDeclarativeComposerApplyEffectV1>()
            .toEqualTypeOf<NonNullable<CanonicalDeclarativeNodeOfKind<'action'>['effect']>>();
        expectTypeOf<PluginDeclarativeControlV2>()
            .toEqualTypeOf<CanonicalDeclarativeNodeOfKind<'field'>['control']>();
        expectTypeOf<PluginDeclarativeItemNodeV2>()
            .toEqualTypeOf<CanonicalDeclarativeNodeOfKind<'item'>>();
        expectTypeOf<PluginDeclarativeListNodeV2>()
            .toEqualTypeOf<CanonicalDeclarativeNodeOfKind<'list'>>();
        expectTypeOf<PluginDeclarativeMetadataNodeV2>()
            .toEqualTypeOf<CanonicalDeclarativeNodeOfKind<'metadata'>>();
        expectTypeOf<PluginDeclarativeSectionNodeV2>()
            .toEqualTypeOf<CanonicalDeclarativeNodeOfKind<'section'>>();
        expectTypeOf<PluginDeclarativeStateNodeV2>()
            .toEqualTypeOf<CanonicalDeclarativeNodeOfKind<'state'>>();
        expectTypeOf<PluginDeclarativeTargetedSurfaceNodeV2>()
            .toEqualTypeOf<CanonicalDeclarativeNodeOfKind<'targetedSurface'>>();
        expectTypeOf<PluginDeclarativeTargetedSurfaceReferenceV1>()
            .toEqualTypeOf<CanonicalDeclarativeNodeOfKind<'targetedSurface'>['surface']>();
        expectTypeOf<PluginDeclarativeToneV2>().toEqualTypeOf<CanonicalPluginUiDeclarativeToneV2>();
        // The grammar's own leaf vocabularies, derived from the same canonical
        // union rather than reached through a second Protocol import path.
        expectTypeOf<PluginDeclarativeActionVariantV2>()
            .toEqualTypeOf<NonNullable<CanonicalDeclarativeNodeOfKind<'action'>['variant']>>();
        expectTypeOf<PluginDeclarativeStateV2>()
            .toEqualTypeOf<CanonicalDeclarativeNodeOfKind<'state'>['state']>();
        expectTypeOf<PluginDeclarativeMetadataEntryV2>()
            .toEqualTypeOf<CanonicalDeclarativeNodeOfKind<'metadata'>['entries'][number]>();
        expectTypeOf<PluginDeclarativeRowNodeV2>()
            .toEqualTypeOf<CanonicalDeclarativeNodeOfKind<'section'>['children'][number]>();
        expectTypeOf<PluginCollectionRowCommandV1>()
            .toEqualTypeOf<NonNullable<CanonicalDeclarativeNodeOfKind<'collectionList'>['primaryCommand']>>();
        expectTypeOf<PluginCollectionProjectedScalarFieldRefV1>()
            .toEqualTypeOf<CanonicalDeclarativeNodeOfKind<'collectionList'>['projection']['titleField']>();
        // The author-facing localized string and contribution reference are the
        // grammar's own leaves; a `Readonly<>` flip here is invisible to
        // assignability but silently breaks the projection above.
        expectTypeOf<PluginLocalizedStringV2>()
            .toEqualTypeOf<CanonicalDeclarativeNodeOfKind<'text'>['text']>();
        expectTypeOf<PluginContributionReference>()
            .toEqualTypeOf<NonNullable<CanonicalDeclarativeNodeOfKind<'item'>['action']>>();
    });

    it('projects Protocol’s Agent UI authoring grammar without a manifest-local dialect', () => {
        // `contributes.agents[].ui` is typed by the same rule as the
        // declarative node grammar above: Protocol owns the strict parser and
        // `src/manifest.ts` declares a structurally exact projection, because
        // aliasing Protocol's type would make a downstream author's own emitted
        // `.d.ts` name a declaration site they cannot resolve. Nothing but
        // these assertions keeps the projection honest — an author writing a
        // declaration the real parser refuses (or being refused one it accepts)
        // is silent at every other boundary.
        expectTypeOf<AgentUiBehaviorDeclarationV1>()
            .toEqualTypeOf<CanonicalAgentUiBehaviorDeclarationV1>();
        expectTypeOf<AgentUiMessageDeclarationV1>()
            .toEqualTypeOf<CanonicalAgentUiMessageDeclarationV1>();
        expectTypeOf<AgentUiComponentsDeclarationV1>()
            .toEqualTypeOf<CanonicalAgentUiComponentsDeclarationV1>();
    });

    it('keeps the public view grammar representable exactly where the canonical parser is', () => {
        // Protocol correlates container, target, instance policy and page
        // header actions on ONE Registry row. A flat public declaration let an
        // author's editor and the published JSON Schema accept `headerActions`
        // on a pane and `instancePolicy: 'multiple'` on a right-sidebar tab —
        // both of which `PluginUiViewV2Schema` rejects at install time.
        // Every container the Registry declares, both dimensions, compared to
        // the canonical arm. Restating the expectation as a literal here left
        // `browserPanel` and `servicesPanel` unanchored entirely, and could not
        // fail at all when the Registry itself moved.
        expectTypeOf<ViewArmCapabilities<SdkPluginUiViewDestinationBindingInputV2>>()
            .toEqualTypeOf<ViewArmCapabilities<CanonicalPluginUiViewDestinationBindingInputV2>>();
        // The admitted arm carries the SDK's own projected action row, not the
        // Protocol declaration site an external author cannot resolve.
        expectTypeOf<Extract<PluginUiViewV2Input, { container: 'appPage' }>['headerActions']>()
            .toEqualTypeOf<PluginUiPageHeaderActionV1[] | undefined>();
        // A header action names the same semantic command grammar the canonical
        // parser admits, not `unknown`.
        expectTypeOf<PluginUiPageHeaderActionV1['command']>()
            .toEqualTypeOf<string | PluginUiSemanticCommandV1>();
        expectTypeOf<PluginSessionHeaderActionDescriptor['command']>()
            .toEqualTypeOf<string | PluginUiSemanticCommandV1>();
    });

    it('aliases the canonical Session start draft instead of re-declaring it', () => {
        // The predecessor was a hand-copied `unknown`-typed mirror that had
        // already lost `sourceContext`; the alias cannot drift from the one
        // browser-safe draft projection the rest of the SDK publishes.
        expectTypeOf<PluginUiSessionServerStartDraftV1>()
            .toEqualTypeOf<SessionServerStartSpawnDraftV1>();
        expectTypeOf<PluginUiSessionServerStartDraftV1['sourceContext']>()
            .toEqualTypeOf<SessionServerStartSpawnDraftV1['sourceContext']>();
    });

    it('projects Protocol’s canonical UI tone vocabulary on every public tone-carrying field', () => {
        // `PluginUiDestinationBadgeV1Schema.tone` IS the full `PluginUiToneV1Schema`
        // (accent included), so a public badge type that omits `accent` denies an
        // author a value the canonical parser admits.
        expectTypeOf<NonNullable<PluginUiViewV2Input['badge']>['tone']>()
            .toEqualTypeOf<CanonicalPluginUiToneV1 | undefined>();
        // Composer attachment presentation is the one canonical narrowing
        // (`PluginUiToneV1Schema.exclude(['accent'])`), expressed as a derivation
        // of the same owner rather than a second hand-copied list.
        expectTypeOf<ComposerAttachmentAuthorPresentationV1['tone']>()
            .toEqualTypeOf<Exclude<CanonicalPluginUiToneV1, 'accent'> | undefined>();
        expectTypeOf<ComposerAttachmentPresentationV1['tone']>()
            .toEqualTypeOf<Exclude<CanonicalPluginUiToneV1, 'accent'> | undefined>();
    });

    it('projects Protocol’s canonical icon-token and UI-channel vocabularies once each', () => {
        // The tone comment above promised this file already held these; it did
        // not. `PluginUiIconTokenV1` was anchored only by the value assignment
        // in `src/ui.ts` (`readonly PluginUiIconTokenV1[] = PLUGIN_UI_ICON_TOKENS_V1`),
        // and `ContributionSurfaceIcon` — a byte-identical third copy of the same
        // 20 tokens — had no anchor at all. It types the `icon` of
        // `ContributionSurfaceFallback`, i.e. the `kind: 'state'` declarative node
        // whose canonical parser (`PluginDeclarativeStateNodeV2Schema`) reads
        // `PluginUiIconTokenV1Schema.optional()`. A token added to Protocol would
        // therefore reach `PluginUiIconTokenV1` under compiler pressure and leave
        // `ContributionSurfaceIcon` behind, denying an author a value the host
        // parses — the same failure the `accent` tone already produced once.
        expectTypeOf<PluginUiIconTokenV1>().toEqualTypeOf<CanonicalPluginUiIconTokenV1>();
        expectTypeOf<ContributionSurfaceIcon>().toEqualTypeOf<CanonicalPluginUiIconTokenV1>();
        // `PluginUiPlatform` is anchored, its file neighbour `PluginUiChannel` was
        // not, though `PluginUiCompatibilityV1Schema` reads both from the same
        // Protocol module.
        expectTypeOf<PluginUiChannel>().toEqualTypeOf<CanonicalPluginUiChannelV1>();
    });

    it('is enforced by the TypeScript imports in this module', () => {
        expect(true).toBe(true);
    });
});
import { describe, expect, expectTypeOf, it } from 'vitest';
