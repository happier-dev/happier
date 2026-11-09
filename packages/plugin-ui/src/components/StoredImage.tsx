import { useEffect, useState, type ReactElement } from 'react';
import type { StoredImageRefV1, PluginUiReadStoredImageResultV1 } from '@happier-dev/plugin-sdk/ui';
import { usePluginHostApi } from '../hostApi/context.js';
import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';
import { HappierStoredImage } from '../presentation/content/StoredImage.js';
import { isHappierAlphaCapableImageMimeType } from '../presentation/media/imageMimeAlpha.js';
import { usePluginTheme } from './PluginUiProvider.js';
import { Icon } from './Icon.js';

export type StoredImageProps = Readonly<{
  /** File-backed native Session-image reference; the current Account's access to that Session decides the read. */
  image: StoredImageRefV1;
  accessibilityLabel: string;
  /** Opens the host's shared stage when available. Defaults to true. */
  expandable?: boolean;
  /** Used when expansion is disabled or this host has no Media stage. */
  onPress?: () => void;
  testID?: string;
}>;

/** Read a native Session image under the current Account's actual access to that Session. */
export function StoredImage({ image, accessibilityLabel, testID, expandable = true, onPress }: StoredImageProps): ReactElement {
  const hostApi = usePluginHostApi();
  const presentationHost = useOptionalPluginUiPresentationHost();
  const theme = usePluginTheme();
  const { mediaId, width, height, sizeBytes } = image;
  const { sessionId, storage, path, sha256, mimeType } = image.file;
  const identity = JSON.stringify([mediaId, width, height, sizeBytes, sessionId, storage, path, sha256, mimeType]);
  const [preview, setPreview] = useState<Readonly<{
    identity: string;
    status: 'loading' | 'loaded' | 'error';
    image?: PluginUiReadStoredImageResultV1;
    uri?: string;
  }>>({ identity, status: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    setPreview({ identity, status: 'loading' });
    void hostApi.readStoredImage({ mediaId, mediaKind: 'image', width, height, sizeBytes,
      file: { sessionId, storage, path, sha256, mimeType } }, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setPreview({ identity, status: 'loaded', image: result,
          uri: `data:${result.mimeType};base64,${result.bytesBase64}` });
      }, () => { if (!controller.signal.aborted) setPreview({ identity, status: 'error' }); });
    return () => controller.abort();
  }, [hostApi, identity, mediaId, width, height, sizeBytes, sessionId, storage, path, sha256, mimeType]);
  const current: typeof preview = preview.identity === identity ? preview : { identity, status: 'loading' };
  const stage = presentationHost?.mediaStage;
  const uri = current.uri;
  const loadedImage = current.image;
  const activate = expandable && stage && current.status === 'loaded' && uri && loadedImage
    ? () => stage.open([{ kind: 'image', uri, title: accessibilityLabel, mimeType: loadedImage.mimeType }], 0)
    : onPress;
  return <HappierStoredImage identity={identity} status={current.status} uri={current.uri}
    dimensions={current.image} accessibilityLabel={accessibilityLabel} testID={testID}
    borderColor={theme.colors.border} backgroundColor={theme.colors.control}
    checkerboardColor={isHappierAlphaCapableImageMimeType(current.image?.mimeType ?? mimeType) ? theme.colors.text : undefined}
    host={presentationHost?.storedImageHost}
    onPress={activate}
    placeholder={<Icon name={current.status === 'error' ? 'warning' : 'preview'} />} />;
}
