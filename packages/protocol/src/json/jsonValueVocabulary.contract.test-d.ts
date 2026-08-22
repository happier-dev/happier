/**
 * Declaration-level fixture for the two Protocol JSON vocabularies.
 *
 * `JsonValue` (this folder) is the strict, already-normalized runtime value
 * produced by `normalizeStrictJsonValue`. `PluginJsonValueV2` is the mutable
 * structural JSON DTO that declaration and wire payloads are authored and
 * validated as. They are related but not interchangeable, and this fixture
 * pins exactly what may be passed where so a fifth spelling cannot accumulate
 * unnoticed.
 */
import type { ProtocolJsonValue } from '../plugins/actions/protocolComposableSchema.js';
import type { PluginJsonValueV2 } from '../plugins/contributions/jsonSchema.js';
import type { JsonValue, normalizeStrictJsonValue } from './strictJsonValue.js';

type Assert<Condition extends true> = Condition;
type IsAssignable<From, To> = [From] extends [To] ? true : false;
type IsRejected<From, To> = IsAssignable<From, To> extends false ? true : false;
type AreMutuallyAssignable<Left, Right> = IsAssignable<Left, Right> extends true
  ? IsAssignable<Right, Left>
  : false;

// The strict runtime value has exactly one meaning. `ProtocolJsonValue` is the
// public authoring spelling of that same contract, not a second one.
type _ProtocolJsonValueIsTheStrictRuntimeValue = Assert<
  AreMutuallyAssignable<ProtocolJsonValue, JsonValue>
>;

// The strict normalizer is the runtime authority for that contract.
type _StrictNormalizerProducesTheStrictRuntimeValue = Assert<
  AreMutuallyAssignable<ReturnType<typeof normalizeStrictJsonValue>, JsonValue>
>;

// An author may hand mutable declaration/payload JSON to a strict runtime
// value position; normalization still applies at the runtime authority.
type _AuthoredJsonWidensToTheStrictRuntimeValue = Assert<
  IsAssignable<PluginJsonValueV2, JsonValue>
>;

// The reverse is not available: an already-normalized strict value must not be
// handed to a position that may mutate it in place.
type _StrictRuntimeValueIsNotAuthoredJson = Assert<
  IsRejected<JsonValue, PluginJsonValueV2>
>;

// Neither vocabulary admits non-JSON data.
type _UndefinedIsNotStrictJson = Assert<IsRejected<undefined, JsonValue>>;
type _UndefinedIsNotAuthoredJson = Assert<IsRejected<undefined, PluginJsonValueV2>>;
type _BigIntIsNotStrictJson = Assert<IsRejected<bigint, JsonValue>>;
type _BigIntIsNotAuthoredJson = Assert<IsRejected<bigint, PluginJsonValueV2>>;
type _DateIsNotStrictJson = Assert<IsRejected<Date, JsonValue>>;
type _DateIsNotAuthoredJson = Assert<IsRejected<Date, PluginJsonValueV2>>;
type _FunctionIsNotStrictJson = Assert<IsRejected<() => void, JsonValue>>;
type _FunctionIsNotAuthoredJson = Assert<IsRejected<() => void, PluginJsonValueV2>>;
type _MapIsNotStrictJson = Assert<IsRejected<Map<string, string>, JsonValue>>;
type _NestedNonJsonMemberIsRejected = Assert<
  IsRejected<{ readonly at: Date }, JsonValue>
>;
