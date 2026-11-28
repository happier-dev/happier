import * as React from 'react';
import { captureSummaryFailed } from '@happier-dev/plugin-sdk/database';
import type { DatabaseCaptureCostMetadataV1, DatabaseCaptureSummaryV1 } from '@happier-dev/database-protocol';
import { usePluginTranslation } from '@happier-dev/plugin-ui';
import {
  CaptureList, CaptureTimeMeta, formatHappierDataValue, requestLabelOf,
  type CapturePageMore, type CollectionAnatomy,
} from '@happier-dev/plugin-ui/components';

const summaryKey = (item: DatabaseCaptureSummaryV1) => item.id;

/** A retained App LLM call (J4): the span its app reported, with the model and token fields the collector kept. */
export type CaptureAppLlmCallV1 = DatabaseCaptureSummaryV1 & Readonly<{
  serviceVersion?: string;
  genAi?: DatabaseCaptureCostMetadataV1;
}>;

/**
 * LLM calls: each model call the app made, newest first — the model in identifier type, its service, provider and
 * tokens on the second line, its time at the row's end. A row opens the call's own trace, as a trace row does.
 */
export function CaptureAppLlmCalls(
  props: Readonly<{
    items: readonly CaptureAppLlmCallV1[];
    loading: boolean;
    locale: string;
    onOpen: (call: CaptureAppLlmCallV1) => void;
    more?: CapturePageMore | null;
  }>,
) {
  const text = usePluginTranslation();
  const { locale } = props;
  const anatomy = React.useMemo<CollectionAnatomy<CaptureAppLlmCallV1>>(() => {
    const model = (item: CaptureAppLlmCallV1) =>
      item.genAi?.modelId ?? item.genAi?.requestedModel ?? requestLabelOf(item);
    const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    // Line 2 says which request made the call and when, so two calls to one model read as two calls.
    const facts = (item: CaptureAppLlmCallV1) => {
      const tokens = item.genAi?.tokens.total ?? null;
      const route = item.endpointMethod && item.endpointRoute ? `${item.endpointMethod} ${item.endpointRoute}` : null;
      return [
        route,
        time.format(item.at),
        item.serviceName || null,
        item.serviceVersion ?? null,
        item.genAi?.provider ?? null,
        tokens === null
          ? null
          : text('plugins.telemetry.capture.tokens', '{count} tokens', {
              count: formatHappierDataValue(tokens, locale),
            }),
      ]
        .filter((part): part is string => part !== null && part.length > 0)
        .join(' · ');
    };
    return {
      glyph: () => null,
      loadingGlyph: false,
      title: model,
      titleIdentifier: true,
      byline: facts,
      titleMeta: (item) => (
        <CaptureTimeMeta ms={item.durationMs} locale={locale} failed={captureSummaryFailed(item)} />
      ),
      titleMetaAlign: 'row',
      accessibilityLabel: (item) => `${model(item)}, ${facts(item)}`,
      testID: (item) => `telemetry.capture.llmCall.${item.id}`,
      columnTitles: {
        title: text('plugins.telemetry.capture.model', 'Model'),
      },
    };
  }, [locale, text]);
  return (
    <CaptureList
      testID="telemetry.capture.llmCalls"
      label={text('plugins.telemetry.capture.llmCalls', 'LLM calls')}
      items={props.items}
      loading={props.loading}
      keyOf={summaryKey}
      anatomy={anatomy}
      empty={text('plugins.telemetry.capture.noLlmCalls', 'No model calls in this window')}
      onOpen={props.onOpen}
      more={props.more ?? null}
    />
  );
}
