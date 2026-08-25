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

/**
 * `watch` is deliberately outside this handle.
 *
 * No corpus owner watches — freshness is decided by the surface's own pass and
 * by the Data-owned UI-query pager, not by a per-collection change feed — and
 * omitting it is what lets one domain writer run over either the daemon's
 * Account storage scope or a mounted surface's Account Data client. Adding a
 * watcher here would silently make every writer daemon-only again.
 */
export type CorpusCollectionHandleV1 = Omit<PluginAccountCollection<CorpusStoredValueV1>, 'watch'>;

/**
 * The narrowest handle an identity derivation needs. Deriving a tag requires
 * the collection it belongs to, which is exactly what keeps one collection's
 * tag from being reused as another's.
 */
export type CorpusIdentityTagHandleV1 = Pick<CorpusCollectionHandleV1, 'identityTag'>;
