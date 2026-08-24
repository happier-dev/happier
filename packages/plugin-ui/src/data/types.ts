import type {
  PluginAccountCollectionDefinition,
  PluginAccountCollectionForDefinition,
  PluginCollectionUiQueryErrorV1,
  PluginCollectionUiQueryRequestV1,
  PluginCollectionUiQueryResultV1,
} from '@happier-dev/plugin-sdk/collections';
import type { ScopedSettingsService } from '@happier-dev/plugin-sdk/settings';
import type { AccountKvService } from '@happier-dev/plugin-sdk/storage';

/**
 * The direct Account Collection operations that an executable plugin surface
 * may use. AccountChange remains owned by the Data UI-query pager; this
 * carrier deliberately does not manufacture a second synchronous watch API.
 *
 * `limits` and `measureBatch` are carried because a surface that writes a large
 * set must size its batches against the deployment policy actually in force and
 * the real sealed wire cost. Without them a plugin UI would have to guess the
 * private-envelope expansion, which is exactly the guess the host owns.
 *
 * `identityTag` is carried for the same reason and a sharper one: on an E2EE
 * Account a durable row address is a mode-derived tag, and that derivation is
 * host-owned because no plugin code holds Account key material. A surface
 * writes the very rows its daemon side writes, so without this it could not
 * address them at all — and the only alternatives are a plaintext natural key
 * or a second derivation, both of which the closed operation exists to prevent.
 */
export type PluginUiAccountCollectionForDefinition<
  TDefinition extends PluginAccountCollectionDefinition,
> = Pick<
  PluginAccountCollectionForDefinition<TDefinition>,
  'identityTag' | 'get' | 'put' | 'delete' | 'query' | 'batch' | 'limits' | 'measureBatch'
>;

export type PluginUiCollectionQueryInput = Readonly<{
  collectionId: PluginCollectionUiQueryRequestV1['collectionId'];
  uiQueryId: PluginCollectionUiQueryRequestV1['uiQueryId'];
  parameters: PluginCollectionUiQueryRequestV1['parameters'];
  signal?: AbortSignal;
}>;

export type PluginUiCollectionQuerySnapshot = Readonly<{
  rows: readonly PluginCollectionUiQueryResultV1['rows'][number][];
  hasMore: boolean;
  status: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error';
  error?: PluginCollectionUiQueryErrorV1;
}>;

/**
 * Data owns query validation, AccountChange wakeups, cursor continuation, and
 * disposal/currentness. Plugin UI only subscribes and presents this snapshot.
 */
export type PluginUiCollectionQueryPager = Readonly<{
  getSnapshot(): PluginUiCollectionQuerySnapshot;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<void>;
  loadMore(): Promise<void>;
  dispose(): void;
}>;

/**
 * The plugin's own Account KV, reached directly from a mounted surface.
 *
 * It is the same service a daemon plugin gets from `storage.account.kv` — same
 * keys, same per-key versions, same conditional-write and tombstone rules —
 * because both realms apply the one Protocol row owner over the one Account
 * row. A surface therefore reads and writes exactly what its daemon side wrote,
 * with no daemon reachable.
 */
export type PluginUiAccountKv = AccountKvService;

/**
 * The plugin's own Account Settings scope, reached directly from a mounted
 * surface.
 *
 * It is the same record, the same declared fields, the same JSON-schema
 * admission and the same revision CAS the plugin's daemon side gets from
 * `settings.forScope({ kind: 'account' })` — because both realms drive the one
 * Account Settings record owner over the one Account. A surface therefore reads
 * and writes exactly what its daemon side wrote, with no daemon reachable.
 *
 * `describe` and `watch` are deliberately absent rather than stubbed. A mounted
 * surface already receives its declaration through the host, and inventing a
 * second change feed here would be a second freshness owner for a record the
 * Account owner already fences by revision.
 */
export type PluginUiAccountSettings = Pick<
  ScopedSettingsService,
  'snapshot' | 'get' | 'set' | 'reset'
>;

/**
 * Host-private provider input exposed to authors only through the public hook.
 * The host creates it for one captured Account lifetime; authors receive no
 * transport, Account scope, or persisted contract facts.
 */
export type PluginUiDataClient = Readonly<{
  collection<TDefinition extends PluginAccountCollectionDefinition>(
    definition: TDefinition,
  ): PluginUiAccountCollectionForDefinition<TDefinition>;
  openCollectionQuery(
    input: PluginUiCollectionQueryInput,
  ): Promise<PluginUiCollectionQueryPager>;
  /** The plugin's own Account KV scope for this mounted surface. */
  readonly accountKv: PluginUiAccountKv;
  /** The plugin's own Account Settings scope for this mounted surface. */
  readonly accountSettings: PluginUiAccountSettings;
}>;
