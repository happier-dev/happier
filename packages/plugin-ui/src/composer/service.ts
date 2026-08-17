import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import type { Disposable } from '@happier-dev/plugin-sdk';

import type {
  ComposerDecorationResultV1,
  ComposerDecorationSetV1,
  ComposerContentHandleV1,
  ComposerContentInspectRequestV1,
  ComposerContentInspectResultV1,
  ComposerContentPickMediaRequestV1,
  ComposerFocusResultV1,
  ComposerInputLockRequestV1,
  ComposerObserverV1,
  ComposerReadResultV1,
  ComposerRefV1,
  ComposerRequestOptions,
  ComposerTransactionResultV1,
  ComposerTransactionV1,
} from './types.js';

/**
 * One exact Composer handle's media-content operations.
 *
 * This facade owns no staging state or capability decision: it forwards each
 * operation to the negotiated host API with the same exact Composer reference.
 */
export interface ComposerContentService {
  pickMedia(
    request: ComposerContentPickMediaRequestV1,
    options?: ComposerRequestOptions,
  ): Promise<ComposerContentHandleV1>;
  inspect(
    handle: ComposerContentHandleV1,
    request: ComposerContentInspectRequestV1,
    options?: ComposerRequestOptions,
  ): Promise<ComposerContentInspectResultV1>;
  release(handle: ComposerContentHandleV1, options?: ComposerRequestOptions): Promise<void>;
}

/**
 * One exact-scoped semantic Composer handle.
 *
 * This is author ergonomics only. It owns no document state, availability
 * cache, transaction grammar, subscription channel, or disposer protocol.
 */
export interface ComposerHandle {
  readonly ref: ComposerRefV1;
  readonly content: ComposerContentService;

  read(options?: ComposerRequestOptions): Promise<ComposerReadResultV1>;
  observe(listener: ComposerObserverV1, options?: ComposerRequestOptions): Promise<Disposable>;
  apply(
    transaction: ComposerTransactionV1,
    options?: ComposerRequestOptions,
  ): Promise<ComposerTransactionResultV1>;
  focus(options?: ComposerRequestOptions): Promise<ComposerFocusResultV1>;
  setDecorations(
    key: string,
    decorations: ComposerDecorationSetV1 | null,
    options?: ComposerRequestOptions,
  ): Promise<ComposerDecorationResultV1>;
  acquireInputLock(
    request: ComposerInputLockRequestV1,
    options?: ComposerRequestOptions,
  ): Promise<Disposable>;
}

/**
 * Author-facing Composer document facade over the one flat negotiated Host API.
 *
 * `get` intentionally constructs an exact local handle without an availability
 * probe. The first delegated operation retains the canonical unavailable result
 * when the referenced live scope has already closed.
 */
export interface ComposersService {
  current(): ComposerHandle | null;
  active(options?: ComposerRequestOptions): Promise<ComposerHandle | null>;
  get(ref: ComposerRefV1, options?: ComposerRequestOptions): Promise<ComposerHandle | null>;
}

function createComposerHandle(hostApi: PluginUiHostApi, ref: ComposerRefV1): ComposerHandle {
  const exactRef: ComposerRefV1 = Object.freeze({ ...ref });
  const content: ComposerContentService = Object.freeze({
    pickMedia: (
      request: ComposerContentPickMediaRequestV1,
      options?: ComposerRequestOptions,
    ) => hostApi.pickComposerMedia(exactRef, request, options),
    inspect: (
      handle: ComposerContentHandleV1,
      request: ComposerContentInspectRequestV1,
      options?: ComposerRequestOptions,
    ) => hostApi.inspectComposerContent(handle, request, options),
    release: (handle: ComposerContentHandleV1, options?: ComposerRequestOptions) => (
      hostApi.releaseComposerContent(handle, options)
    ),
  });
  return Object.freeze({
    ref: exactRef,
    content,
    read: (options?: ComposerRequestOptions) => hostApi.readComposer(exactRef, options),
    observe: (listener: ComposerObserverV1, options?: ComposerRequestOptions) => (
      hostApi.watchComposer(exactRef, listener, options)
    ),
    apply: (transaction: ComposerTransactionV1, options?: ComposerRequestOptions) => (
      hostApi.applyComposer(exactRef, transaction, options)
    ),
    focus: (options?: ComposerRequestOptions) => hostApi.focusComposer(exactRef, options),
    setDecorations: (
      key: string,
      decorations: ComposerDecorationSetV1 | null,
      options?: ComposerRequestOptions,
    ) => hostApi.setComposerDecorations(exactRef, key, decorations, options),
    acquireInputLock: (
      request: ComposerInputLockRequestV1,
      options?: ComposerRequestOptions,
    ) => hostApi.acquireComposerInputLock(exactRef, request, options),
  });
}

/** Internal constructor consumed by the existing provider-context hook. */
export function createComposersService(
  hostApi: PluginUiHostApi,
  currentRef: ComposerRefV1 | null,
): ComposersService {
  // `useComposer()` memoizes this service for one provider/ref lifetime. Keep
  // its mounted handle equally stable so composing `current()` directly with
  // `useComposerView` cannot manufacture a replacement on every render.
  const currentHandle = currentRef === null ? null : createComposerHandle(hostApi, currentRef);
  return Object.freeze({
    current: () => currentHandle,
    active: async (options?: ComposerRequestOptions) => {
      const ref = await hostApi.activeComposer(options);
      return ref === null ? null : createComposerHandle(hostApi, ref);
    },
    get: async (ref: ComposerRefV1, _options?: ComposerRequestOptions) => createComposerHandle(hostApi, ref),
  });
}
