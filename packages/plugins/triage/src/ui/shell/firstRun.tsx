import * as React from 'react';
import {
  BrandMark,
  Card,
  Columns,
  Heading,
  PageHeader,
  Stack,
  Step,
  Text,
  usePluginTranslation,
  useSurfaceContext,
} from '@happier-dev/plugin-ui';

import { TRIAGE_DISPLAY_NAME } from '../../displayName.js';
import type { TriageConfigureSourceOfferV1 } from './configureSources.js';

/**
 * The first run of PRs & Issues (PLAN.md: "First run is the lab's Desk first run"): what the page is for, the
 * sources a reader can connect — each one its own destination, one press from that source's own settings page —
 * and what happens once one is connected. It renders only when at least one source can be offered; with none,
 * the shell keeps its plain "No sources are configured" state, because a tile wall with nothing to press is a
 * promise the page cannot keep.
 */
export function TriageFirstRun(props: Readonly<{
  offers: readonly TriageConfigureSourceOfferV1[];
  onConnect: (offer: TriageConfigureSourceOfferV1) => void;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const { locale } = useSurfaceContext();
  // Not every JavaScript engine the host runs ships `Intl.ListFormat`; a comma list says the same thing.
  const formatKinds = React.useMemo(() => {
    if (typeof Intl.ListFormat !== 'function') return (names: readonly string[]) => names.join(', ');
    const listFormat = new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' });
    return (names: readonly string[]) => listFormat.format(names);
  }, [locale]);
  return (
    <Stack gap="large" style={FIRST_RUN_COLUMN_STYLE_V1} testID="triage-first-run">
      <PageHeader
        title={TRIAGE_DISPLAY_NAME}
        description={text(
          'plugins.triage.surface.firstRun.description',
          'Pull requests, issues and production errors that need you, right next to the agents working on them.',
        )}
        leading={<BrandMark size="large" externallyLabelled />}
      />
      <Stack gap="medium">
        <Stack gap="xsmall">
          <Heading level={2} value={text('plugins.triage.surface.firstRun.connect.title', 'Connect a source')} />
          <Text
            tone="secondary"
            value={text('plugins.triage.surface.firstRun.connect.description', 'Pick where your work lives. You can add more later.')}
          />
        </Stack>
        <Columns minColumnWidth={200} gap="small" rowGap="small">
          {props.offers.map((offer) => (
            <Card
              key={`${offer.destination.pluginId}/${offer.destination.localId}`}
              onPress={() => { props.onConnect(offer); }}
              accessibilityLabel={text('plugins.triage.surface.firstRun.connectNamed', 'Connect {name}', { name: offer.displayName })}
              testID={`triage-first-run-source:${offer.destination.pluginId}`}
            >
              <Stack gap="small">
                <BrandMark pluginId={offer.destination.pluginId} size="medium" externallyLabelled />
                <Stack gap="xsmall">
                  <Text variant="label" value={offer.displayName} numberOfLines={1} />
                  {offer.kindNames.length === 0 ? null : (
                    <Text variant="caption" tone="secondary" value={formatKinds(offer.kindNames)} numberOfLines={1} />
                  )}
                </Stack>
                <Text variant="caption" tone="accent" value={text('plugins.triage.surface.firstRun.connect', 'Connect')} />
              </Stack>
            </Card>
          ))}
        </Columns>
      </Stack>
      <Stack gap="medium">
        <Heading level={2} value={text('plugins.triage.surface.firstRun.next.title', 'What happens next')} />
        <Columns minColumnWidth={180} gap="medium" rowGap="medium">
          {FIRST_RUN_STEPS_V1.map((step, index) => (
            <Step key={step.id} marker={{ kind: 'number', value: index + 1 }} title={text(step.titleKey, step.title)}>
              <Text variant="caption" tone="secondary" value={text(step.bodyKey, step.body)} />
            </Step>
          ))}
        </Columns>
      </Stack>
    </Stack>
  );
}

/** The lab's reading column for a first run: a centred measure, not a full-bleed table width. */
const FIRST_RUN_COLUMN_STYLE_V1 = Object.freeze({ width: '100%' as const, maxWidth: 720, alignSelf: 'center' as const, paddingVertical: 24 });

const FIRST_RUN_STEPS_V1 = Object.freeze([
  {
    id: 'list',
    titleKey: 'plugins.triage.surface.firstRun.next.list.title',
    title: 'Everything that needs you, in one list',
    bodyKey: 'plugins.triage.surface.firstRun.next.list.body',
    body: 'Review requests, failing checks, assigned issues and escalating errors, sectioned by who acts next.',
  },
  {
    id: 'agent',
    titleKey: 'plugins.triage.surface.firstRun.next.agent.title',
    title: 'Hand any entry to an agent',
    bodyKey: 'plugins.triage.surface.firstRun.next.agent.body',
    body: 'Review, fix or investigate on the machine you choose.',
  },
  {
    id: 'done',
    titleKey: 'plugins.triage.surface.firstRun.next.done.title',
    title: 'Follow it to done',
    bodyKey: 'plugins.triage.surface.firstRun.next.done.body',
    body: 'See each agent’s progress on the entry itself, and merge when it’s ready.',
  },
] as const);
