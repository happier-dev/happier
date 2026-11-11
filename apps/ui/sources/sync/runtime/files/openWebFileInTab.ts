/**
 * Browser-tab handoff for a finished file the browser renders natively (a PDF).
 *
 * The bytes are fetched first, with Happier still in front: a tab opened at the press would hide
 * Happier while its transfer runs. When the press has expired by then and the browser blocks the
 * tab, the caller offers `open` again from a new press.
 *
 * A `blob:` URL created here has Happier's origin, so only kinds admitted by
 * `canOpenFileInDefaultApp` (no HTML, no SVG) may be shown this way.
 */
export type WebFileTabResult =
  | Readonly<{ opened: true }>
  | Readonly<{ opened: false; open: () => boolean }>;

/** One file's bytes stay alive while its tab may still read them; opening another file releases them. */
let shownUrl: string | null = null;

export async function openWebFileInTab(
  file: Blob,
  mimeType: string,
): Promise<WebFileTabResult> {
  // Copy out of the transfer's temporary storage, which is removed once this resolves.
  const blob = new Blob([await file.arrayBuffer()], { type: mimeType });
  const url = URL.createObjectURL(blob);
  if (shownUrl) URL.revokeObjectURL(shownUrl);
  shownUrl = url;
  const open = (): boolean => {
    const tab = window.open(url, '_blank');
    if (!tab) return false;
    try {
      tab.opener = null;
    } catch {}
    return true;
  };
  return open() ? { opened: true } : { opened: false, open };
}
