import type {
  ComposerDecorationSetV1 as SdkComposerDecorationSetV1,
  PluginUiHostApi,
} from '@happier-dev/plugin-sdk/ui';

/** Exact Composer scope type, consumed from the canonical Host API. */
export type ComposerRefV1 = Parameters<PluginUiHostApi['readComposer']>[0];
/** Exact read outcome, including the host-owned unavailable result. */
export type ComposerReadResultV1 = Awaited<ReturnType<PluginUiHostApi['readComposer']>>;
/** Exact immutable semantic snapshot returned by a ready Composer read. */
export type ComposerSnapshotV1 = Extract<ComposerReadResultV1, Readonly<{ status: 'ready' }>>['snapshot'];
/** Exact Composer observation callback. */
export type ComposerObserverV1 = Parameters<PluginUiHostApi['watchComposer']>[1];
/** Exact revision-checked transaction grammar. */
export type ComposerTransactionV1 = Parameters<PluginUiHostApi['applyComposer']>[1];
/** Exact atomic transaction outcome. */
export type ComposerTransactionResultV1 = Awaited<ReturnType<PluginUiHostApi['applyComposer']>>;
/** Exact focus outcome. */
export type ComposerFocusResultV1 = Awaited<ReturnType<PluginUiHostApi['focusComposer']>>;
/** Exact non-null keyed decoration payload from the canonical SDK contract. */
export type ComposerDecorationSetV1 = SdkComposerDecorationSetV1;
/** Exact decoration outcome. */
export type ComposerDecorationResultV1 = Awaited<ReturnType<PluginUiHostApi['setComposerDecorations']>>;
/** Exact input-lock request. */
export type ComposerInputLockRequestV1 = Parameters<PluginUiHostApi['acquireComposerInputLock']>[1];
/** Exact request for host-owned media selection and staging. */
export type ComposerContentPickMediaRequestV1 = Parameters<PluginUiHostApi['pickComposerMedia']>[1];
/** Opaque staged-media claim produced only by the host-owned carrier. */
export type ComposerContentHandleV1 = Awaited<ReturnType<PluginUiHostApi['pickComposerMedia']>>;
/** Exact bounded request for a staged-media inspection. */
export type ComposerContentInspectRequestV1 = Parameters<PluginUiHostApi['inspectComposerContent']>[1];
/** Exact bounded inspection result; it carries no source path or URI. */
export type ComposerContentInspectResultV1 = Awaited<ReturnType<PluginUiHostApi['inspectComposerContent']>>;
/** Shared cancellation options consumed unchanged by Composer operations. */
export type ComposerRequestOptions = Parameters<PluginUiHostApi['readComposer']>[1];
