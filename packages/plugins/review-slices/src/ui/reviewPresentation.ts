import type { PluginDynamicResourceRuntime } from '@happier-dev/plugin-sdk/resources';
import { definePluginDeclarativeDocumentV1, PLUGIN_DECLARATIVE_DOCUMENT_CONTENT_TYPE_V1 } from '@happier-dev/plugin-sdk/ui';
import type { PluginUiDeclarativeNodeV2, PluginUiJsonObjectV1 } from '@happier-dev/plugin-sdk/ui';

/** The Resource reads only the demanded context; execution and Review access stay with their owners. */
const runtime: PluginDynamicResourceRuntime = {
  read({ context }) {
    const review = context.kind === 'surface' ? context.review : undefined;
    const children: PluginUiDeclarativeNodeV2[] = [];
    if (review?.kind === 'finding' && review.namespace === 'happier.review.slices') {
      const evidence = review.extension !== null && typeof review.extension === 'object' && !Array.isArray(review.extension)
        // Array.isArray's type predicate does not eliminate readonly JSON arrays.
        ? review.extension as PluginUiJsonObjectV1 : {};
      for (const [field, label] of [
        ['featureId', 'Slice'], ['confidence', 'Confidence'], ['reproduction', 'Reproduction'],
        ['whyTestsDoNotAlreadyCoverThis', 'Existing coverage'], ['suggestedRegressionTest', 'Regression test'],
        ['minimumFixScope', 'Minimum fix'],
      ] as const) {
        const value = evidence[field];
        if (typeof value === 'string' && value.length > 0) children.push({ kind: 'group', title: label,
          children: [{ kind: 'text', text: value }] });
      }
    } else if (review?.kind === 'engineOptions') {
      children.push({ kind: 'text', text: 'Slice review uses the selected provider, model and repository slices.' });
      for (const [field, label] of [['provider', 'Native provider'], ['model', 'Model'], ['featureIds', 'Selected slices']] as const) {
        const value = review.options[field];
        const display = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').join(', ')
          : typeof value === 'string' ? value : '';
        if (display) children.push({ kind: 'status', label, value: display });
      }
    } else if (review?.kind === 'page') {
      children.push({ kind: 'text', text: 'Slice evidence appears with each finding in this Review, including reproduction and regression guidance.' });
    }
    return JSON.stringify(definePluginDeclarativeDocumentV1({ version: 1, root: { kind: 'stack', gap: 'medium', children } }));
  },
  // Context changes are pushed by the existing surface Resource binding; there is no background source.
  observe() { return { dispose() {} }; },
};

export const reviewPresentationResource = {
  source: 'dynamic' as const, kind: 'config' as const, contentType: PLUGIN_DECLARATIVE_DOCUMENT_CONTENT_TYPE_V1,
  // The declarative-document media contract requires an explicit Resource ceiling of at most 512 KiB.
  maxBytes: 512 * 1024,
  scope: 'surface' as const, execution: { target: 'daemon' as const }, runtime,
};
