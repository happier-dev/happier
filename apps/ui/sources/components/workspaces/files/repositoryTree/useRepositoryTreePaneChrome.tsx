import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import type {
  PaneHeaderLine,
  PaneHeaderLineSegment,
} from '@/components/appShell/panes/paneHeaderSlot';
import { formatExactCount } from '@/components/ui/navigation/tabBadge/tabBadgeModel';
import { selectScmChangedFiles } from '@/scm/scmStatusFiles';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { ScrollEdgeIndicators } from '@/components/ui/scroll/ScrollEdgeIndicators';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { t } from '@/text';
import { leafFolderName } from '@/utils/path/pathUtils';

/**
 * What a Files pane draws around its tree, for a Session and a Project alike: the pane header's live line (where
 * this works, "folder on machine", then how many files changed in the Git pane's words) and the scroll edge fades.
 */
export function useRepositoryTreePaneChrome(
  input: Readonly<{
    /** Null where the files have no folder of their own to name (a folderless Session). */
    rootPath: string | null;
    machineName: string | null;
    /** The checkout's working snapshot; null until it has been read. */
    scmSnapshot: ScmWorkingSnapshot | null | undefined;
    /** Whether an unread snapshot can still arrive (its Machine answers). Out of reach, nothing will fill a reserved room. */
    changesReadable: boolean;
  }>,
) {
  const { theme } = useUnistyles();
  const { rootPath, machineName, scmSnapshot, changesReadable } = input;
  // Unknown until read; a folder that is not a repository, or one out of reach and never read, has no change fact.
  const changedCount = scmSnapshot == null ? (changesReadable ? 'pending' as const : null)
    : scmSnapshot.repo.isRepo ? selectScmChangedFiles(scmSnapshot).length : null;
  const paneHeaderLine = React.useMemo((): PaneHeaderLine | null => {
    const folder = leafFolderName(rootPath);
    const place =
      folder && machineName
        ? t('sessionGitPane.header.folderOnMachine', {
            folder,
            machine: machineName,
          })
        : (folder ?? machineName);
    if (!place) return null;
    const segments: PaneHeaderLineSegment[] = [place];
    if (changedCount === 'pending') {
      // The fact's room is kept, so its arrival fills the line instead of wrapping it (and the toolbar under it).
      segments.push({ text: t('sessionGitPane.header.changed', { count: formatExactCount(0) }), pending: true });
    } else if (changedCount !== null) {
      segments.push(
        changedCount > 0
          ? t('sessionGitPane.header.changed', {
              count: formatExactCount(changedCount),
            })
          : t('sessionGitPane.flow.header.noChanges'),
      );
    }
    return { segments };
  }, [changedCount, machineName, rootPath]);
  const scrollFades = useScrollEdgeFades({
    enabledEdges: { top: true, bottom: true },
    overflowThreshold: 1,
    edgeThreshold: 1,
  });
  const scrollProps = React.useMemo(
    () => ({
      onLayout: scrollFades.onViewportLayout,
      onContentSizeChange: scrollFades.onContentSizeChange,
      onScroll: scrollFades.onScroll,
      scrollEventThrottle: 16,
    }),
    [
      scrollFades.onViewportLayout,
      scrollFades.onContentSizeChange,
      scrollFades.onScroll,
    ],
  );
  const scrollOverlay = (
    <>
      <ScrollEdgeFades
        color={theme.colors.surface.base}
        size={18}
        edges={scrollFades.visibility}
      />
      <ScrollEdgeIndicators
        edges={scrollFades.visibility}
        color={theme.colors.text.secondary}
        size={14}
        opacity={0.35}
      />
    </>
  );
  return { paneHeaderLine, scrollProps, scrollOverlay };
}
