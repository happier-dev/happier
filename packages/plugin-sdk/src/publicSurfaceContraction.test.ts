import { describe, expect, it } from 'vitest';

// The supported preview surface intentionally omits unused convenience aliases,
// host-policy vocabulary, and authoring helpers whose source of truth is the
// cold JSON manifest.

// @ts-expect-error -- deprecation records are generated contract metadata, not a standalone runtime author primitive.
import type { PluginDeprecationData } from './runtime/index.js';
// @ts-expect-error -- localized manifest fields are owned by PluginManifest rather than a duplicate runtime alias.
import type { PluginLocalizedString } from './runtime/index.js';
// @ts-expect-error -- MCP elicitation transport DTOs are not consumed by the public MCP service contract.
import type { PluginMcpElicitationRequest } from './runtime/index.js';
// @ts-expect-error -- MCP elicitation transport DTOs are not consumed by the public MCP service contract.
import type { PluginMcpElicitationResult } from './runtime/index.js';
// @ts-expect-error -- final policy evaluation is host-owned and is not a runtime authoring result.
import type { PluginPolicyResult } from './runtime/index.js';
// @ts-expect-error -- callers use the kind-indexed client handle rather than an uncorrelated client union.
import type { PluginProtocolClient } from './runtime/index.js';
// @ts-expect-error -- SCM authors implement the canonical SCM runtime, not the abandoned generic operation map.
import type { PluginScmOperation } from './runtime/index.js';
// @ts-expect-error -- SCM authors implement the canonical SCM runtime, not the abandoned generic operation map.
import type { PluginScmOperationHandler } from './runtime/index.js';
// @ts-expect-error -- SCM authors implement the canonical SCM runtime, not the abandoned generic operation map.
import type { PluginScmOperationRequestMap } from './runtime/index.js';
// @ts-expect-error -- SCM authors implement the canonical SCM runtime, not the abandoned generic operation map.
import type { PluginScmOperationResultMap } from './runtime/index.js';
// @ts-expect-error -- authors narrow the canonical PluginSessionEvent union directly.
import type { PluginSessionActivityEvent } from './runtime/index.js';
// @ts-expect-error -- authors narrow the canonical PluginSessionEvent union directly.
import type { PluginSessionChangedEvent } from './runtime/index.js';
// @ts-expect-error -- authors narrow the canonical PluginSessionEvent union directly.
import type { PluginSessionMessageEnvelope } from './runtime/index.js';
// @ts-expect-error -- authors narrow the canonical PluginSessionEvent union directly.
import type { PluginSessionMessageEvent } from './runtime/index.js';
// @ts-expect-error -- authors narrow the canonical PluginSessionEvent union directly.
import type { PluginSessionRemovedEvent } from './runtime/index.js';
// @ts-expect-error -- work-state field values are already carried by PluginSessionWorkStateItem.
import type { PluginSessionWorkStateOrigin } from './runtime/index.js';
// @ts-expect-error -- work-state field values are already carried by PluginSessionWorkStateItem.
import type { PluginSessionWorkStateStatusReason } from './runtime/index.js';
// @ts-expect-error -- storage scopes are exposed as fixed service properties, not an independent selector.
import type { PluginStorageScope } from './runtime/index.js';

// @ts-expect-error -- file-follow path disclosure is host-private observation composition, not Agent SDK.
import type { AgentExternalSessionsResolveFollowTranscriptPathRequest } from './sessions/index.js';
// @ts-expect-error -- file-follow path disclosure is host-private observation composition, not Agent SDK.
import type { AgentExternalSessionsResolveFollowTranscriptPathResult } from './sessions/index.js';

// @ts-expect-error -- AgentRuntimeContext is the sole unsuffixed invocation context.
import type { AgentRuntimeInvocationContext } from './agent-runtime.js';
// @ts-expect-error -- compact requests are typed by AgentSessionCompactRequest; no unconsumed schema alias is published.
import { AgentSessionCompactRequestSchema } from './agent-runtime.js';
// @ts-expect-error -- rollback reconciliation results are typed; no unconsumed schema alias is published.
import { AgentSessionConversationRollbackReconciliationResultSchema } from './agent-runtime.js';
// @ts-expect-error -- rollback requests are typed; no unconsumed schema alias is published.
import { AgentSessionConversationRollbackRequestSchema } from './agent-runtime.js';
// @ts-expect-error -- rollback results are typed; no unconsumed schema alias is published.
import { AgentSessionConversationRollbackResultSchema } from './agent-runtime.js';
// @ts-expect-error -- send requests are typed; no unconsumed schema alias is published.
import { AgentSessionSendRequestSchema } from './agent-runtime.js';
// @ts-expect-error -- authors narrow AgentSessionRuntimeEvent rather than importing extracted aliases.
import type { AgentSessionContextCompactionEvent } from './agent-runtime.js';
// @ts-expect-error -- delivery is already part of AgentSessionSendRequest.
import type { AgentSessionDelivery } from './agent-runtime.js';
// @ts-expect-error -- authors narrow AgentSessionRuntimeEvent rather than importing extracted aliases.
import type { AgentSessionFileEditEvent } from './agent-runtime.js';
// @ts-expect-error -- authors narrow AgentSessionRuntimeEvent rather than importing extracted aliases.
import type { AgentSessionInputCustodyEvent } from './agent-runtime.js';
// @ts-expect-error -- authors narrow AgentSessionRuntimeEvent rather than importing extracted aliases.
import type { AgentSessionInputDeliveryEvent } from './agent-runtime.js';
// @ts-expect-error -- authors narrow AgentSessionRuntimeEvent rather than importing extracted aliases.
import type { AgentSessionLifecycleEvent } from './agent-runtime.js';
// @ts-expect-error -- authors narrow AgentSessionRuntimeEvent rather than importing extracted aliases.
import type { AgentSessionOutputEvent } from './agent-runtime.js';
// @ts-expect-error -- authors narrow AgentSessionRuntimeEvent rather than importing extracted aliases.
import type { AgentSessionTranscriptEvent } from './agent-runtime.js';
// @ts-expect-error -- authors narrow AgentSessionRuntimeEvent rather than importing extracted aliases.
import type { AgentSessionUsageEvent } from './agent-runtime.js';

// @ts-expect-error -- session-header actions are cold PluginManifest data.
import type { PluginSessionHeaderActionDescriptor } from './ui.js';
// @ts-expect-error -- structured-message descriptors are cold PluginManifest data.
import type { PluginStructuredMessageDescriptor } from './ui.js';
// @ts-expect-error -- session-header actions are authored in the cold manifest.
import { defineSessionHeaderAction } from './ui.js';
// @ts-expect-error -- structured messages are authored in the cold manifest.
import { defineStructuredMessage } from './ui.js';
// @ts-expect-error -- UI placement descriptors are authored in PluginManifest JSON.
import type { PluginSurfacePlacementDescriptor } from './ui.js';
// @ts-expect-error -- UI translations are authored in PluginManifest JSON.
import type { PluginUiTranslationsContribution } from './ui.js';
// @ts-expect-error -- hosted-web contributions are authored in PluginManifest JSON.
import type { PluginHostedWebContribution } from './ui.js';
// @ts-expect-error -- React Native bundle contributions are authored in PluginManifest JSON.
import type { PluginReactNativeBundleContribution } from './ui.js';
// @ts-expect-error -- the manifest is the sole input contract for UI surface contributions.
import type { DefineSurfaceContributionInput } from './ui.js';
// @ts-expect-error -- the manifest is the sole authoring path for UI surface contributions.
import { defineSurfaceContribution } from './ui.js';
// @ts-expect-error -- the manifest is the sole authoring path for UI translations.
import { defineUiTranslations } from './ui.js';

describe('supported preview surface contraction', () => {
    it('keeps the negative compile contract in the TypeScript program', () => {
        expect(true).toBe(true);
    });
});
