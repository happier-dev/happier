import * as React from 'react';
import type { PublicProfilePreparedAtmosphereV1 } from '@happier-dev/protocol/account/publicProfileAtmosphere';
import { PublicProfilePreparedAppearanceV1Schema, type PublicProfileAppearanceV1,
  type PublicProfilePreparedAppearanceV1 } from '@happier-dev/protocol/account/publicProfilePublication';

import { encodeBase64 } from '@/encryption/base64';

type PreparedPicture = Extract<
  PublicProfilePreparedAtmosphereV1,
  { source: 'picture' }
>['picture'];

/** The prepared copy Confirm sends, as local bytes for its review band; nothing is uploaded to show it. */
export function preparedPictureCopy(
  picture: PreparedPicture,
): Readonly<{ data: string; copyId: string }> {
  const { mimeType, base64 } = picture.content;
  return {
    data: `data:${mimeType};base64,${base64}`,
    copyId: `prepared-${base64.length}-${base64.slice(-24)}`,
  };
}

/** Reuse the draft's reviewed edition, including the normalized pixels already read on this device. */
export function prepareAppliedProfileAppearance(appearance: PublicProfileAppearanceV1 | null,
  pictureData: string | null): PublicProfilePreparedAppearanceV1 | null {
  if (!appearance) return null;
  if (appearance.atmosphere.source !== 'picture') return { theme: appearance.theme, atmosphere: appearance.atmosphere };
  const content = pictureData?.match(/^data:([^;]+);base64,(.+)$/u);
  if (!content) return null;
  const { ref: _ref, ...picture } = appearance.atmosphere.picture;
  const prepared = PublicProfilePreparedAppearanceV1Schema.safeParse({ theme: appearance.theme,
    atmosphere: { source: 'picture', picture: { ...picture, content: { mimeType: content[1], base64: content[2] } } } });
  return prepared.success ? prepared.data : null;
}

/**
 * The applied edition's public picture copy, read once from its public route (the same normalized
 * bytes visitors' pages are painted from) so the owner's band is painted locally like a candidate.
 */
export function useAppliedPictureCopy(
  url: string | null,
  copyId: string | null,
): string | null {
  const [copy, setCopy] = React.useState<Readonly<{
    copyId: string;
    data: string;
  }> | null>(null);
  React.useEffect(() => {
    if (!url || !copyId) return;
    let current = true;
    void (async () => {
      try {
        const response = await fetch(url);
        if (!response.ok) return;
        const mimeType =
          response.headers.get('content-type')?.split(';')[0]?.trim() ||
          'image/png';
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (current && bytes.length > 0)
          setCopy({
            copyId,
            data: `data:${mimeType};base64,${encodeBase64(bytes)}`,
          });
      } catch {
        // Unreadable right now: the band keeps the page colour, as the cold page does without art.
      }
    })();
    return () => {
      current = false;
    };
  }, [url, copyId]);
  return copy && copy.copyId === copyId ? copy.data : null;
}
