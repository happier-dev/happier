import type {
    ComposerRefV1 as CanonicalComposerRefV1,
} from '@happier-dev/protocol/plugins/ui/composerRef';
import { ComposerRefV1Schema as canonicalComposerRefV1Schema } from '@happier-dev/protocol/plugins/ui/composerRef';

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
 *
 * The published type is a declaration-neutral structural projection of the
 * canonical Protocol `ComposerRefV1` (deep-readonly at the Protocol owner), so
 * the compiled `/protocol` declaration closure carries no private Protocol
 * type identity. The compile-time equality fence below keeps any Protocol arm
 * or field change loud at this projection instead of silently diverging; the
 * `ui.test.ts` `toEqualTypeOf` fence asserts the same fact from the tests.
 */
export type ProtocolComposerRefV1 =
    | Readonly<{ kind: 'session'; sessionId: string }>
    | Readonly<{ kind: 'newSession'; instanceId: string }>
    | Readonly<{ kind: 'pendingMessage'; sessionId: string; localId: string }>
    | Readonly<{ kind: 'participantMessage'; sessionId: string; instanceId: string }>
    | Readonly<{ kind: 'automationAuthoring'; sessionId: string; instanceId: string }>
    | Readonly<{
        kind: 'workflowAuthoring';
        draftId: string;
        blockId: string;
        instanceId: string;
    }>;

/** The canonical Protocol parser remains the sole schema owner. */
export const ProtocolComposerRefV1Schema: ProtocolComposableSchema<ProtocolComposerRefV1> =
    canonicalComposerRefV1Schema;

/**
 * Compile-time drift fence. Neither alias is exported, so the canonical
 * Protocol type stays runtime-only and never enters the emitted declaration;
 * drift on either side fails here with a `true`-constraint error.
 */
type ProtocolComposerRefTypeEquality<TLeft, TRight> =
    (<T>() => T extends TLeft ? 1 : 2) extends
    (<T>() => T extends TRight ? 1 : 2) ? true : false;
type AssertProtocolComposerRefTypeEquality<T extends true> = T;
type _ProtocolComposerRefV1MustEqualCanonicalComposerRef = AssertProtocolComposerRefTypeEquality<
    ProtocolComposerRefTypeEquality<ProtocolComposerRefV1, CanonicalComposerRefV1>
>;
