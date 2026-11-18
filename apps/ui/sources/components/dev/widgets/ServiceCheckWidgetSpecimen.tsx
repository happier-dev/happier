import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { getWidgetSizeFootprintV1, type WidgetSizeV1 } from '@happier-dev/protocol/widgets';

import { ServiceCheckWidgetView } from '@/components/projects/deployments/ServiceCheckWidget';
import type { ManagedConfiguredCheckRow } from '@/components/store/inventory/managedOperationalInventory';
import { Text } from '@/components/ui/text/Text';
import { WidgetFrame } from '@/components/widgets/frame/WidgetFrame';
import {
  WidgetFrameBodyCaptionContext,
  WidgetFrameBodyIdentityContext,
  WidgetFrameBodyMetaContext,
  type WidgetFrameBodyIdentity,
} from '@/components/widgets/frame/widgetFrameBodyCaption';
import { createKeyFlowFixture, createServiceCheckRowFixture } from '@/dev/testkit/fixtures/serviceCheckRowFixtures';
import { t } from '@/text';

/**
 * Dev-only (lab `p7Surfaces` home / homep): the Check widget on Home over fixture Checks — a failing Key flow
 * ("Checkout"), a Key flow with no traffic ("Assist") and a passing HTTP check — in the Home frame, each card named
 * by what its body lends. `?phone=1` is the one-column phone width.
 */
const MINUTE = 60_000;
const NOW = Math.floor(Date.now() / MINUTE) * MINUTE;

type Card = Readonly<{ id: string; row: ManagedConfiguredCheckRow; environment: string | null; size: WidgetSizeV1 }>;

const CARDS: readonly Card[] = [
  { id: 'checkout', size: 'medium', environment: 'Production', row: createServiceCheckRowFixture({ key: 'checkout', state: 'failing', failingValue: 1420,
    nowMs: NOW, keyFlow: createKeyFlowFixture('Checkout', { limitMs: 800, routes: ['GET /api/cart', 'POST /checkout'] }) }) },
  { id: 'assist', size: 'medium', environment: 'Production', row: createServiceCheckRowFixture({ key: 'assist', state: 'unknown', nowMs: NOW,
    keyFlow: createKeyFlowFixture('Assist', { limitMs: 4000, routes: ['POST /api/assist/summarize'] }) }) },
  { id: 'health', size: 'medium', environment: null, row: createServiceCheckRowFixture({ key: 'health', state: 'passing', nowMs: NOW,
    target: 'billing.acme.dev/health' }) },
  { id: 'n8n', size: 'medium', environment: null, row: createServiceCheckRowFixture({ key: 'n8n', state: 'down', nowMs: NOW,
    target: 'n8n.acme.dev' }) },
];

function CheckCard(props: Readonly<{ card: Card }>) {
  const [caption, setCaption] = React.useState<string | null>(null);
  const [meta, setMeta] = React.useState<React.ReactNode>(null);
  const [identity, setIdentity] = React.useState<WidgetFrameBodyIdentity | null>(null);
  const widgetPresentation = React.useMemo(() => ({ size: props.card.size,
    footprint: getWidgetSizeFootprintV1('home', props.card.size)! }), [props.card.size]);
  const body = React.useMemo(() => ({
    kind: 'content' as const,
    children: (
      <View style={{ flexGrow: 1 }}>
        <WidgetFrameBodyCaptionContext.Provider value={setCaption}>
          <WidgetFrameBodyMetaContext.Provider value={setMeta}>
            <WidgetFrameBodyIdentityContext.Provider value={setIdentity}>
              <ServiceCheckWidgetView row={props.card.row} environmentName={props.card.environment} testID={`check-widget.${props.card.id}.body`} />
            </WidgetFrameBodyIdentityContext.Provider>
          </WidgetFrameBodyMetaContext.Provider>
        </WidgetFrameBodyCaptionContext.Provider>
      </View>
    ),
  }), [props.card]);
  return (
    <WidgetFrame testID={`check-widget.${props.card.id}`} frameStyle="card" placement="home" widgetPresentation={widgetPresentation}
      mark={identity?.mark ?? 'pulse'} title={identity?.title ?? t('projects.deployments.monitoring.widgetTitle')}
      {...(caption ? { source: caption } : {})} meta={meta} body={body} />
  );
}

function pairsOf<T>(items: readonly T[]): T[][] {
  const rows: T[][] = [];
  for (let index = 0; index < items.length; index += 2) rows.push(items.slice(index, index + 2));
  return rows;
}

export function ServiceCheckWidgetSpecimen(props: Readonly<{ phone: boolean }>) {
  return (
    <ScrollView contentContainerStyle={[styles.page, props.phone ? styles.phone : null]} testID="check-widget-specimen">
      <Text variant="title" style={styles.heading}>Good evening</Text>
      {(props.phone ? CARDS.map((card) => [card]) : pairsOf(CARDS)).map((row) => (
        <View key={row.map((card) => card.id).join('+')} style={styles.row}>
          {row.map((card) => <View key={card.id} style={styles.cell}><CheckCard card={card} /></View>)}
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  page: { flexGrow: 1, padding: theme.space.s24, gap: theme.space.s16, backgroundColor: theme.colors.surface.base },
  phone: { maxWidth: 390, padding: theme.space.s16 },
  heading: { color: theme.colors.text.primary },
  row: { flexDirection: 'row', gap: theme.space.s16 },
  cell: { flex: 1, minWidth: 0 },
}));
