import {
  type BrowserContextAnnotationItemV2,
  type BrowserContextAnnotationStructuredBlockV2,
} from './v1.js';

/** One annotation carries the full marks document and its browser-owned source facts. */
export function buildBrowserContextAnnotationStructuredBlockV2(
  item: BrowserContextAnnotationItemV2,
): BrowserContextAnnotationStructuredBlockV2 {
  return {
    v: 2,
    kind: 'browser.annotation.v2',
    annotationId: item.annotationId,
    browserSessionId: item.browserSessionId,
    sourceViewId: item.sourceViewId,
    contextIds: [item.contextId],
    imageRef: item.imageRef,
    marks: item.marks,
    elements: item.elements,
    ...(item.pageUrl ? { pageUrl: item.pageUrl } : {}),
    ...(item.pageTitle ? { pageTitle: item.pageTitle } : {}),
  };
}
