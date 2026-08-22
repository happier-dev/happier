import {
    ComposerRefV1Schema as canonicalComposerRefV1Schema,
} from '@happier-dev/protocol/plugins/ui/composerRef';

import type { ProtocolComposableSchema } from './protocolFacade.js';

/**
 * One exact host-owned Composer scope, as a feature protocol embeds it.
 *
 * `@happier-dev/plugin-sdk/ui` publishes the same value as
 * `ComposerRefV1Schema`, declared `PluginUiSchema<ComposerRefV1>`: a
 * parse/safeParse pair for reading Host API payloads. That projection is
 * deliberately opaque and cannot be composed. This entrypoint publishes the
 * composable projection instead, for authors declaring their own protocol
 * objects. Both names are the one canonical Protocol value; the SDK adds no
 * second parser, grammar, or JSON-Schema owner.
 */
export type ProtocolComposerRefV1 =
    | Readonly<{ kind: 'session'; sessionId: string }>
    | Readonly<{ kind: 'newSession'; instanceId: string }>
    | Readonly<{ kind: 'pendingMessage'; sessionId: string; localId: string }>
    | Readonly<{ kind: 'participantMessage'; sessionId: string; instanceId: string }>
    | Readonly<{ kind: 'automationAuthoring'; sessionId: string; instanceId: string }>;

/** The canonical Protocol parser remains the sole schema owner. */
export const ProtocolComposerRefV1Schema: ProtocolComposableSchema<ProtocolComposerRefV1> =
    canonicalComposerRefV1Schema;
