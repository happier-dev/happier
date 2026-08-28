import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import type { Disposable } from '@happier-dev/plugin-sdk';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import * as pluginUi from '../hostApi/index.js';
import { PluginHostApiProviderInternal } from '../hostApi/context.js';

type ComposerRef = Parameters<PluginUiHostApi['readComposer']>[0];
type ComposerReadResult = Awaited<ReturnType<PluginUiHostApi['readComposer']>>;
type ComposerTransaction = Parameters<PluginUiHostApi['applyComposer']>[1];
type ComposerTransactionResult = Awaited<ReturnType<PluginUiHostApi['applyComposer']>>;
type ComposerFocusResult = Awaited<ReturnType<PluginUiHostApi['focusComposer']>>;
type ComposerDecorations = Parameters<PluginUiHostApi['setComposerDecorations']>[2];
type ComposerDecorationResult = Awaited<ReturnType<PluginUiHostApi['setComposerDecorations']>>;
type ComposerLockRequest = Parameters<PluginUiHostApi['acquireComposerInputLock']>[1];
type ComposerContentPickMediaRequest = Parameters<PluginUiHostApi['pickComposerMedia']>[1];
type ComposerContentHandle = Awaited<ReturnType<PluginUiHostApi['pickComposerMedia']>>;
type ComposerContentInspectRequest = Parameters<PluginUiHostApi['inspectComposerContent']>[1];
type ComposerContentInspectResult = Awaited<ReturnType<PluginUiHostApi['inspectComposerContent']>>;

type ComposerHandle = Readonly<{
  ref: ComposerRef;
  read(): Promise<ComposerReadResult>;
  observe(listener: Parameters<PluginUiHostApi['watchComposer']>[1]): Promise<Disposable>;
  apply(transaction: ComposerTransaction): Promise<ComposerTransactionResult>;
  focus(): Promise<ComposerFocusResult>;
  setDecorations(key: string, decorations: ComposerDecorations): Promise<ComposerDecorationResult>;
  acquireInputLock(request: ComposerLockRequest): Promise<Disposable>;
  content: Readonly<{
    pickMedia(request: ComposerContentPickMediaRequest): Promise<ComposerContentHandle>;
    inspect(handle: ComposerContentHandle, request: ComposerContentInspectRequest): Promise<ComposerContentInspectResult>;
    release(handle: ComposerContentHandle): Promise<void>;
  }>;
}>;

type ComposersService = Readonly<{
  current(): ComposerHandle | null;
  active(): Promise<ComposerHandle | null>;
  get(ref: ComposerRef): Promise<ComposerHandle | null>;
}>;

type UseComposer = () => ComposersService;

function ComposerProbe({ onService }: Readonly<{ onService(service: ComposersService): void }>) {
  // Keep RED meaningful while the public hook does not yet exist: this fails
  // at the public package boundary rather than from an unresolvable test-only
  // module import.
  const candidate = Reflect.get(pluginUi, 'useComposer');
  if (typeof candidate !== 'function') {
    throw new Error('@happier-dev/plugin-ui must export useComposer.');
  }
  onService((candidate as UseComposer)());
  return null;
}

describe('Composer facade', () => {
  it('binds current and exact handles to the canonical flat Host API', async () => {
    const mountedRef = { kind: 'session', sessionId: 'session-mounted' } as const;
    const activeRef = { kind: 'newSession', instanceId: 'new-active' } as const;
    const exactRef = { kind: 'pendingMessage', sessionId: 'session-exact', localId: 'pending-exact' } as const;
    const snapshot = {
      revision: 7,
      ref: exactRef,
      text: 'draft',
      references: [],
      attachments: [],
      layout: 'wrap',
      capabilities: { text: true, references: true, attachments: true, submit: true },
      state: { focused: true, editable: true, submittable: true, submitting: false, running: false },
    } as const;
    const unavailable = { status: 'unavailable' as const, reason: 'scopeClosed' as const };
    const observation = { dispose: vi.fn() };
    const lock = { dispose: vi.fn() };
    const stagedMedia = {
      v: 1,
      id: 'stage-1',
      executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
      owner: { pluginId: 'acme.issues', localId: 'issue' },
      mediaKind: 'image' as const,
      mimeType: 'image/png' as const,
      name: 'issue.png',
      sizeBytes: 42,
      sha256: 'a'.repeat(64),
    };
    const inspection = { offset: 0, bytes: new Uint8Array([1, 2, 3]), eof: true };
    const hostApi = {
      version: () => ({ apiVersion: '1.0.0', wireVersion: 1, methods: [] }),
      context: vi.fn(async () => { throw new Error('not used'); }),
      watchContext: vi.fn(async (): Promise<Disposable> => ({ dispose: vi.fn() })),
      executeAction: vi.fn(async () => null),
      selectActionInput: vi.fn(async () => ({ kind: 'cancelled' as const })),
      readResource: vi.fn(async () => { throw new Error('not used'); }),
      statOpenableContent: vi.fn(async () => { throw new Error('not used'); }),
      readOpenableContent: vi.fn(async () => { throw new Error('not used'); }),
      watchResource: vi.fn(async () => { throw new Error('not used'); }),
      openSurface: vi.fn(async () => undefined),
      notify: vi.fn(async () => undefined),
      confirm: vi.fn(async () => false),
      activeComposer: vi.fn(async () => activeRef),
      readComposer: vi.fn(async (ref: ComposerRef) => (
        ref.kind === mountedRef.kind && ref.sessionId === mountedRef.sessionId
          ? { status: 'ready' as const, snapshot: { ...snapshot, ref: mountedRef } }
          : unavailable
      )),
      watchComposer: vi.fn(async () => observation),
      applyComposer: vi.fn(async () => ({ status: 'applied' as const, revision: 8 })),
      focusComposer: vi.fn(async () => ({ status: 'focused' as const })),
      setComposerDecorations: vi.fn(async () => ({ status: 'set' as const })),
      acquireComposerInputLock: vi.fn(async () => lock),
      pickComposerMedia: vi.fn(async () => stagedMedia),
      inspectComposerContent: vi.fn(async () => inspection),
      releaseComposerContent: vi.fn(async () => undefined),
      diagnostic: vi.fn(),
      readClipboard: vi.fn(async () => ''),
      writeClipboard: vi.fn(async () => undefined),
      openExternalLink: vi.fn(async () => undefined),
    } as PluginUiHostApi;
    let service: ComposersService | undefined;

    await act(async () => {
      renderer.create(
        <PluginHostApiProviderInternal
          hostApi={hostApi}
          composerRef={mountedRef}
        >
          <ComposerProbe onService={(next) => { service = next; }} />
        </PluginHostApiProviderInternal>,
      );
    });

    if (!service) throw new Error('Composer service was not provided.');
    const current = service.current();
    if (!current) throw new Error('Mounted Composer handle was not provided.');
    expect(current.ref).toEqual(mountedRef);
    await expect(current.read()).resolves.toEqual({
      status: 'ready',
      snapshot: { ...snapshot, ref: mountedRef },
    });
    await expect(service.active()).resolves.toMatchObject({ ref: activeRef });
    const exact = await service.get(exactRef);
    if (!exact) throw new Error('Exact Composer handle was not provided.');

    // `get` has no availability preflight: the raw host-owned unavailable
    // result remains the first exact-handle operation outcome.
    await expect(exact.read()).resolves.toEqual(unavailable);
    const listener = vi.fn();
    await expect(exact.observe(listener)).resolves.toBe(observation);
    await expect(exact.apply({ expectedRevision: 7, operations: [{ kind: 'text.clear' }] })).resolves.toEqual({
      status: 'applied',
      revision: 8,
    });
    await expect(exact.focus()).resolves.toEqual({ status: 'focused' });
    await expect(exact.setDecorations('preview', null)).resolves.toEqual({ status: 'set' });
    await expect(exact.acquireInputLock({ reason: 'Applying', mode: 'submit' })).resolves.toBe(lock);
    await expect(exact.content.pickMedia({
      attachmentLocalId: 'issue',
      kinds: ['image'],
    })).resolves.toEqual(stagedMedia);
    await expect(exact.content.inspect(stagedMedia, {
      offset: 0,
      maxBytes: 3,
    })).resolves.toEqual(inspection);
    await expect(exact.content.release(stagedMedia)).resolves.toBeUndefined();

    expect(hostApi.activeComposer).toHaveBeenCalledOnce();
    expect(hostApi.activeComposer).toHaveBeenCalledWith(undefined);
    expect(hostApi.readComposer).toHaveBeenNthCalledWith(1, mountedRef, undefined);
    expect(hostApi.readComposer).toHaveBeenNthCalledWith(2, exactRef, undefined);
    expect(hostApi.watchComposer).toHaveBeenCalledWith(exactRef, listener, undefined);
    expect(hostApi.applyComposer).toHaveBeenCalledWith(exactRef, {
      expectedRevision: 7,
      operations: [{ kind: 'text.clear' }],
    }, undefined);
    expect(hostApi.focusComposer).toHaveBeenCalledWith(exactRef, undefined);
    expect(hostApi.setComposerDecorations).toHaveBeenCalledWith(exactRef, 'preview', null, undefined);
    expect(hostApi.acquireComposerInputLock).toHaveBeenCalledWith(exactRef, {
      reason: 'Applying',
      mode: 'submit',
    }, undefined);
    expect(hostApi.pickComposerMedia).toHaveBeenCalledWith(exactRef, {
      attachmentLocalId: 'issue',
      kinds: ['image'],
    }, undefined);
    expect(hostApi.inspectComposerContent).toHaveBeenCalledWith(stagedMedia, {
      offset: 0,
      maxBytes: 3,
    }, undefined);
    expect(hostApi.releaseComposerContent).toHaveBeenCalledWith(stagedMedia, undefined);
  });

  it('preserves every exact Composer ref against runtime retargeting', async () => {
    const refs = [
      { kind: 'session', sessionId: 'session-immutable' },
      { kind: 'newSession', instanceId: 'new-session-immutable' },
      { kind: 'pendingMessage', sessionId: 'pending-session-immutable', localId: 'pending-immutable' },
      { kind: 'participantMessage', sessionId: 'participant-session-immutable', instanceId: 'participant-immutable' },
      { kind: 'automationAuthoring', sessionId: 'automation-session-immutable', instanceId: 'automation-immutable' },
    ] as const;
    const unavailable = { status: 'unavailable' as const, reason: 'scopeClosed' as const };
    const readComposer = vi.fn(async () => unavailable);
    const hostApi = {
      version: () => ({ methods: [] }),
      readResource: vi.fn(async () => { throw new Error('Not used by Composer facade tests.'); }),
      readComposer,
    } as unknown as PluginUiHostApi;
    let service: ComposersService | undefined;

    await act(async () => {
      renderer.create(
        <PluginHostApiProviderInternal hostApi={hostApi} composerRef={null}>
          <ComposerProbe onService={(next) => { service = next; }} />
        </PluginHostApiProviderInternal>,
      );
    });

    if (!service) throw new Error('Composer service was not provided.');
    // Exact lookup is deliberately independent from a Composer-bound mount:
    // generic destinations can address a known document while `current()`
    // truthfully remains absent for this surface.
    expect(service.current()).toBeNull();
    for (const suppliedRef of refs) {
      const originalRef = { ...suppliedRef };
      const handle = await service.get(suppliedRef);
      if (!handle) throw new Error('Exact Composer handle was not provided.');

      try {
        Object.assign(handle.ref, { kind: '__retargeted__' });
      } catch {
        // Frozen refs reject direct mutation in strict mode.
      }
      expect(handle.ref).toEqual(originalRef);

      try {
        Object.assign(suppliedRef, { kind: '__input-retargeted__' });
      } catch {
        // An upstream immutable ref is also acceptable at this boundary.
      }
      await expect(handle.read()).resolves.toEqual(unavailable);
      expect(readComposer).toHaveBeenLastCalledWith(originalRef, undefined);
    }
  });

  it('updates current only when the host-private mounted reference changes', async () => {
    const firstRef = { kind: 'session', sessionId: 'session-first' } as const;
    const secondRef = { kind: 'newSession', instanceId: 'new-second' } as const;
    const hostApi = {
      version: () => ({ methods: [] }),
      readResource: vi.fn(async () => { throw new Error('not used'); }),
    } as unknown as PluginUiHostApi;
    let service: ComposersService | undefined;
    let tree: renderer.ReactTestRenderer;

    await act(async () => {
      tree = renderer.create(
        <PluginHostApiProviderInternal hostApi={hostApi} composerRef={firstRef}>
          <ComposerProbe onService={(next) => { service = next; }} />
        </PluginHostApiProviderInternal>,
      );
    });
    expect(service?.current()?.ref).toEqual(firstRef);

    await act(async () => {
      tree!.update(
        <PluginHostApiProviderInternal hostApi={hostApi} composerRef={secondRef}>
          <ComposerProbe onService={(next) => { service = next; }} />
        </PluginHostApiProviderInternal>,
      );
    });
    expect(service?.current()?.ref).toEqual(secondRef);
  });
});
