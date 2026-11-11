import * as React from 'react';

import { useIconSvgCssUrlReader } from '@/components/ui/icons/iconSvgMarkup';
import { resolveReferenceChipIconName } from '@/components/ui/referenceChip/referenceChipIcon';
import type { ComposerEditorReference } from './composerEditorTypes';

export type ComposerChipViewProps = Readonly<{
  reference: ComposerEditorReference;
  selected: boolean;
  onOpen?: () => void;
  onRemove?: () => void;
}>;

/**
 * The composer's inline reference chip (lab CA): the shared reference-chip anatomy
 * (`referenceChipStyles.ts`) with the reference's glyph or picture and its current label.
 * It holds no control; Open and Remove live in the chip's hover card.
 */
export const ComposerChipView = React.memo(function ComposerChipView({
  reference,
  onOpen,
}: ComposerChipViewProps) {
  const icon = reference.thumbnail ? null : resolveReferenceChipIconName({ ref: reference.ref });
  const readIconSvgCssUrl = useIconSvgCssUrlReader(icon !== null);
  const glyph = icon ? readIconSvgCssUrl(icon) : null;
  return (
    <span
      data-composer-chip-view=""
      data-happier-ref-chip=""
      data-state={reference.state ?? 'ready'}
      onClick={reference.state === 'removed' ? undefined : onOpen}
    >
      {reference.thumbnail ? (
        <span data-happier-ref-thumb="">{reference.thumbnail}</span>
      ) : glyph ? (
        <span data-happier-ref-glyph="" style={{ ['--happier-ref-glyph' as string]: glyph }} />
      ) : null}
      <span data-happier-ref-label="">{reference.label}</span>
    </span>
  );
});
