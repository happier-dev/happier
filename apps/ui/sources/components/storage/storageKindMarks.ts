import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { mixHappierColorOverPaper } from '@happier-dev/plugin-ui/presentation';
import type { StorageInventoryKindV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';

import { usageSignatureAccent } from '@/components/settings/usage/usageAccent';

/** How one stored kind is drawn: its colour, hatched when it is what can be cleared (old versions). */
export type StorageKindMark = Readonly<{ color: string; hatched: boolean }>;

type StorageInkTheme = Readonly<{
  colors: Readonly<{
    text: Readonly<{
      primary: string;
      tertiary: string;
      disabled: string;
      link: string;
      secondary: string;
    }>;
    surface: Readonly<{ base: string }>;
    border: Readonly<{ strong: string }>;
  }>;
}>;

/**
 * The ink steps over the page's paper for what the Artifact limit does not count (lab `storage-view-1119` `--sv-k2..4`):
 * `mid` is a storage bar's ordinary ink, a clear grey against the track in both themes, never the near-black or pale
 * text ink that reads as a full or an empty bar; `soft` and `faint` follow it for the smaller kinds.
 */
const INK_STEPS = { mid: 0.46, soft: 0.3, faint: 0.18 } as const;

function inkStep(
  theme: StorageInkTheme,
  share: number,
  fallback: string,
): string {
  return (
    mixHappierColorOverPaper(
      theme.colors.text.primary,
      theme.colors.surface.base,
      share,
    ) ?? fallback
  );
}

/** A storage size bar's ordinary ink (Machines › Storage, the Account's kinds and items, the Artifacts table). */
export function readStorageBarInk(theme: StorageInkTheme): string {
  return inkStep(theme, INK_STEPS.mid, theme.colors.text.tertiary);
}

/**
 * Each stored kind's mark, decided once for every Storage picture: the Account bar and its legend, a kind's row bar,
 * an item's size bar and its Map tile. The usage accent marks what the Artifact limit counts (Artifacts solid, their
 * old versions hatched); the other kinds take ink steps, attachments the mid one.
 */
export function useStorageKindMarks(): Readonly<
  Record<StorageInventoryKindV1, StorageKindMark>
> {
  const { theme } = useUnistyles();
  return React.useMemo(() => {
    const accent = usageSignatureAccent(theme);
    const mid = readStorageBarInk(theme);
    const soft = inkStep(theme, INK_STEPS.soft, theme.colors.text.disabled);
    const faint = inkStep(theme, INK_STEPS.faint, theme.colors.border.strong);
    return {
      artifacts: { color: accent, hatched: false },
      artifactOldVersions: { color: accent, hatched: true },
      discussionAttachments: { color: mid, hatched: false },
      accountPets: { color: soft, hatched: false },
      pluginCollections: { color: faint, hatched: false },
      pluginArtifacts: { color: faint, hatched: false },
      profilePictures: { color: faint, hatched: false },
      avatars: { color: faint, hatched: false },
      teamLogos: { color: faint, hatched: false },
    };
  }, [theme]);
}
