import {
  useContainingHappierMaterialRole,
  useHappierMaterialColorResolver,
} from '@happier-dev/plugin-ui/presentation';

import { glassSurfaceBackgroundColor } from '@/components/ui/glass/glassSurfacePaint';

/**
 * The paint of a list that fills a page (`ItemList`, a page-hosted `SelectionList`). Directly on the page it
 * takes the glass content plane, which is the solid base while glass is off; inside a material it takes that
 * material's nested fill. One owner, so a list never paints an opaque slab over a glass page.
 */
export function usePageContentBackgroundColor(color: string): string {
  const materialRole = useContainingHappierMaterialRole();
  const paintColor = useHappierMaterialColorResolver();
  return materialRole === undefined
    ? glassSurfaceBackgroundColor(color, 'content', true)
    : paintColor(color, 'transparent');
}
