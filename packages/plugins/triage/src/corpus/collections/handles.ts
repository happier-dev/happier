import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginAccountCollection } from '@happier-dev/plugin-sdk/collections';

/**
 * How a bound corpus Collection is typed.
 *
 * The corpus declares its schemas as plain JSON, so the SDK types a bound handle
 * over the generic stored-value shape. Row types stay explicit in `rows.ts` and
 * are applied at the one decoding boundary rather than by re-declaring the SDK
 * interface here.
 */
export type CorpusStoredValueV1 = Readonly<Record<string, JsonValue>>;

export type CorpusCollectionHandleV1 = PluginAccountCollection<CorpusStoredValueV1>;

/**
 * The narrowest handle an identity derivation needs. Deriving a tag requires
 * the collection it belongs to, which is exactly what keeps one collection's
 * tag from being reused as another's.
 */
export type CorpusIdentityTagHandleV1 = Pick<CorpusCollectionHandleV1, 'identityTag'>;
