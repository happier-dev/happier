/**
 * Declaration-level fixture for the SDK's published JSON vocabulary.
 *
 * The SDK publishes two JSON types to authors and they are not
 * interchangeable: `JsonValue` (root) and `ProtocolJsonValue` (`/protocol`)
 * are two names for the one strict, already-normalized runtime value, while
 * `PluginJsonValueV2` is the mutable structural JSON authored into
 * declarations and carried on wire payloads. This fixture pins what an author
 * may and may not pass where, and pins each SDK projection to its Protocol
 * owner so a further spelling cannot accumulate unnoticed.
 */
import type { JsonValue as ProtocolOwnedStrictJsonValue } from '@happier-dev/protocol';
import type { PluginJsonValueV2 as ProtocolOwnedAuthoredJson } from '@happier-dev/protocol';

import type { JsonValue, PluginJsonValueV2 } from './identity.js';
import type { ProtocolJsonValue } from './protocol/protocolFacade.js';

type Assert<Condition extends true> = Condition;
type IsAssignable<From, To> = [From] extends [To] ? true : false;
type IsRejected<From, To> = IsAssignable<From, To> extends false ? true : false;
type AreMutuallyAssignable<Left, Right> = IsAssignable<Left, Right> extends true
    ? IsAssignable<Right, Left>
    : false;

// The two published strict names are one contract.
type _RootStrictNameMatchesProtocolEntrypointName = Assert<
    AreMutuallyAssignable<JsonValue, ProtocolJsonValue>
>;

// Each SDK projection stays exactly its Protocol owner's contract.
type _StrictProjectionMatchesProtocolOwner = Assert<
    AreMutuallyAssignable<JsonValue, ProtocolOwnedStrictJsonValue>
>;
type _AuthoredProjectionMatchesProtocolOwner = Assert<
    AreMutuallyAssignable<PluginJsonValueV2, ProtocolOwnedAuthoredJson>
>;

// An author may hand authored declaration/payload JSON to a strict position.
type _AuthoredJsonWidensToStrictValue = Assert<
    IsAssignable<PluginJsonValueV2, JsonValue>
>;

// An author may not hand a strict runtime value back to a mutable authoring
// position such as a JSON Schema `default`, `const`, or `enum` member.
type _StrictValueIsNotAuthoredJson = Assert<
    IsRejected<JsonValue, PluginJsonValueV2>
>;

// Neither published vocabulary admits non-JSON data.
type _UndefinedIsNotStrictJson = Assert<IsRejected<undefined, JsonValue>>;
type _UndefinedIsNotAuthoredJson = Assert<IsRejected<undefined, PluginJsonValueV2>>;
type _BigIntIsNotStrictJson = Assert<IsRejected<bigint, JsonValue>>;
type _BigIntIsNotAuthoredJson = Assert<IsRejected<bigint, PluginJsonValueV2>>;
type _DateIsNotStrictJson = Assert<IsRejected<Date, JsonValue>>;
type _DateIsNotAuthoredJson = Assert<IsRejected<Date, PluginJsonValueV2>>;
type _FunctionIsNotStrictJson = Assert<IsRejected<() => void, JsonValue>>;
type _FunctionIsNotAuthoredJson = Assert<IsRejected<() => void, PluginJsonValueV2>>;
type _NestedNonJsonMemberIsRejected = Assert<
    IsRejected<{ readonly at: Date }, JsonValue>
>;
