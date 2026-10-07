import { act } from 'react';
import { describe, expect, it } from 'vitest';
import type { PluginUiReadStoredImageResultV1, StoredImageRefV1 } from '@happier-dev/plugin-sdk/ui';
import { mountThroughReactNativeWebAsync } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { PluginUiProvider } from './PluginUiProvider.js';
import { StoredImage } from './StoredImage.js';
import { PluginUiPresentationHostProviderInternal } from '../presentationHost/context.js';

describe('authorized StoredImage reference presentation', () => {
  it('renders admitted image data and cancels the reference read when the viewer unmounts', async () => {
    const context = createSurfaceContext();
    let signal: AbortSignal | undefined;
    let complete: ((image: PluginUiReadStoredImageResultV1) => void) | undefined;
    const image: StoredImageRefV1 = { mediaId: 'media-1', mediaKind: 'image', width: 100, height: 60, sizeBytes: 24,
      file: { sessionId: 'session-1', storage: 'daemon', path: '.happier/uploads/artifacts/session-1/image.png',
        sha256: 'a'.repeat(64), mimeType: 'image/png' } };
    const references: StoredImageRefV1[] = [];
    const hostApi = createHostApiStub(context, {
      // The host API/decoder are external boundaries of this author component.
      readStoredImage: (ref, options) => { references.push(ref); signal = options?.signal; return new Promise((resolve) => { complete = resolve; }); },
    });
    const render = (reference: StoredImageRefV1) => <PluginUiProvider hostApi={hostApi} context={context}>
      <PluginUiPresentationHostProviderInternal host={{ renderMarkdown: () => null, renderCodeBlock: () => null,
        renderPopover: () => null, renderIcon: () => null,
        storedImageHost: { renderImage: ({ uri }) => <img src={uri} alt="Admitted image" /> } }}>
        <StoredImage image={reference} accessibilityLabel="Capture" />
      </PluginUiPresentationHostProviderInternal>
    </PluginUiProvider>;
    const mount = await mountThroughReactNativeWebAsync(render(image));
    expect(mount.container.querySelector('img')).toBeNull();
    expect(references).toEqual([image]);
    await act(async () => { complete?.({ bytesBase64: 'cG5n', mimeType: 'image/png', width: 100, height: 60 }); });
    expect(mount.container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,cG5n');
    expect(mount.container.querySelector('[aria-label="Capture"]')).not.toBeNull();
    await mount.render(render({ ...image, file: { ...image.file } }));
    expect(references).toEqual([image]);
    const oldSignal = signal;
    const changedImage = { ...image, file: { ...image.file, sha256: 'b'.repeat(64) } };
    await mount.render(render(changedImage));
    expect(oldSignal?.aborted).toBe(true);
    expect(references).toEqual([image, changedImage]);
    expect(mount.container.querySelector('img')).toBeNull();
    mount.unmount();
    expect(signal?.aborted).toBe(true);
  });
});
