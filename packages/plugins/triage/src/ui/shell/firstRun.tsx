import * as React from 'react';
import {
  BrandMark,
  Button,
  Card,
  Column,
  Columns,
  Item,
  ItemGroup,
  PageHeader,
  Row,
  Stack,
  Step,
  Text,
  usePluginTheme,
  usePluginTranslation,
  useSurfaceContext,
} from '@happier-dev/plugin-ui';

import { TRIAGE_DISPLAY_NAME } from '../../displayName.js';
import type { TriageConfigureSourceOfferV1 } from './configureSources.js';
import { createTriageNameListFormatter } from './nameList.js';

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
  const { spacing } = usePluginTheme();
  return (
    <Stack gap="none" style={[FIRST_RUN_COLUMN_STYLE_V1, { paddingVertical: spacing.large + spacing.small }]} testID="triage-first-run">
      <PageHeader
        title={TRIAGE_DISPLAY_NAME}
        description={text(
          'plugins.triage.surface.firstRun.description',
          'Pull requests, issues and production errors that need you, right next to the agents working on them.',
        )}
        leading={<BrandMark size="large" externallyLabelled />}
      />
      {/* Each section is a page section, so its title stands on the page column's edge with its rows (F2). */}
      <Stack gap="medium">
        <TriageConnectTiles
          title={text('plugins.triage.surface.firstRun.connect.title', 'Connect a source')}
          description={text('plugins.triage.surface.firstRun.connect.description', 'Pick where your work lives. You can add more later.')}
          offers={props.offers}
          onConnect={props.onConnect}
        />
        {/* Where the reader's work is read, said before they connect anything (lab Desk first run). Only the true
            half: pins and fix links keep a title in the Account (core/SURFACE.md), so "never copied" is not said. */}
        <Text
          variant="micro"
          tone="secondary"
          value={text(
            'plugins.triage.surface.firstRun.trustLive',
            'Sources are read live on the machine you choose.',
          )}
        />
      </Stack>
      <ItemGroup title={text('plugins.triage.surface.firstRun.next.title', 'What happens next')} surface="none">
        {/* The lab's three steps side by side; each cell is a `Column`, or the grid has no cells to lay out. */}
        <Columns columns={3} minColumnWidth={180} gap="medium" rowGap="medium">
          {FIRST_RUN_STEPS_V1.map((step, index) => (
            <Column key={step.id}>
              <Step marker={{ kind: 'number', value: index + 1 }} title={text(step.titleKey, step.title)}>
                <Text variant="micro" tone="secondary" value={text(step.bodyKey, step.body)} />
              </Step>
            </Column>
          ))}
        </Columns>
      </ItemGroup>
    </Stack>
  );
}

/**
 * The first run of Tasks (lab `tasks-firstrun`): nothing is listed and no tracker is connected. The personal list
 * already exists in the reader's Account, so its one action is **New task**, the page's one primary action. Each tracker
 * that brings tasks is the same Connect tile the PRs & Issues first run offers, one press from its own page; with none
 * installed that section is absent rather than empty.
 */
export function TriageTasksFirstRun(props: Readonly<{
  offers: readonly TriageConfigureSourceOfferV1[];
  onConnect: (offer: TriageConfigureSourceOfferV1) => void;
  onNewTask: () => void;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const { spacing } = usePluginTheme();
  return (
    <Stack gap="none" style={[FIRST_RUN_COLUMN_STYLE_V1, { paddingVertical: spacing.large + spacing.small }]} testID="triage-tasks-first-run">
      <PageHeader
        title={text('plugins.triage.tasks.title', 'Tasks')}
        description={text(
          'plugins.triage.tasks.firstRun.description',
          'Everything you have to do, from your trackers and your own list, next to the agents doing it.',
        )}
        leading={<BrandMark size="large" externallyLabelled />}
      />
      <ItemGroup
        title={text('plugins.triage.tasks.firstRun.own.title', 'Start with your own list')}
        description={text('plugins.triage.tasks.firstRun.own.description', 'Personal tasks live in your Happier Account, and only you see them.')}
        surface="none"
      >
        <Card padding="medium">
          <Row gap="medium" align="center" justify="space-between" wrap>
            <BrandMark size="small" externallyLabelled />
            <Stack gap="xsmall" style={PERSONAL_TASKS_COPY_STYLE_V1}>
              <Text variant="label" value={text('plugins.triage.tasks.firstRun.own.row', 'Personal tasks')} />
              <Text
                variant="micro"
                tone="secondary"
                value={text(
                  'plugins.triage.tasks.firstRun.own.rowDescription',
                  'Link them to Sessions, block them on a pull request, break them into sub-tasks.',
                )}
              />
            </Stack>
            <Button title={text('plugins.triage.tasks.new', 'New task')} variant="primary" onPress={props.onNewTask} />
          </Row>
        </Card>
      </ItemGroup>
      {props.offers.length === 0 ? null : (
        <Stack gap="medium">
          <TriageConnectTiles
            title={text('plugins.triage.tasks.firstRun.trackers.title', 'Bring tasks from a tracker')}
            description={text('plugins.triage.tasks.firstRun.trackers.description', 'They stay in their tracker. Happier reads and edits them there.')}
            offers={props.offers}
            onConnect={props.onConnect}
          />
          <Text
            variant="micro"
            tone="secondary"
            value={text(
              'plugins.triage.tasks.firstRun.trustLive',
              'Trackers are read live on the machine you choose.',
            )}
          />
        </Stack>
      )}
    </Stack>
  );
}

/** One titled page section of rows, one per source, each with its own Connect (lab t1, both first runs). */
function TriageConnectTiles(props: Readonly<{
  title: string;
  description: string;
  offers: readonly TriageConfigureSourceOfferV1[];
  onConnect: (offer: TriageConfigureSourceOfferV1) => void;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const { locale } = useSurfaceContext();
  const formatKinds = React.useMemo(() => createTriageNameListFormatter(locale), [locale]);
  return (
    <ItemGroup title={props.title} description={props.description}>
      {props.offers.map((offer) => (
        <Item
          key={`${offer.destination.pluginId}/${offer.destination.localId}`}
          icon={<BrandMark pluginId={offer.destination.pluginId} size="small" externallyLabelled />}
          title={offer.displayName}
          {...(offer.kindNames.length === 0 ? {} : { subtitle: formatKinds(offer.kindNames) })}
          accessoryOutsidePressable
          accessory={(
            <Button
              title={text('plugins.triage.surface.firstRun.connect', 'Connect')}
              accessibilityLabel={text('plugins.triage.surface.firstRun.connectNamed', 'Connect {name}', { name: offer.displayName })}
              variant="secondary"
              size="small"
              testID={`triage-first-run-source:${offer.destination.pluginId}`}
              onPress={() => { props.onConnect(offer); }}
            />
          )}
        />
      ))}
    </ItemGroup>
  );
}

/** The personal row's words take the room and wrap; New task keeps its own width at the row's end. */
const PERSONAL_TASKS_COPY_STYLE_V1 = Object.freeze({ flexGrow: 1, flexShrink: 1, flexBasis: 200, minWidth: 0 });

/** The lab's reading column for a first run: a centred measure, not a full-bleed table width. */
const FIRST_RUN_COLUMN_STYLE_V1 = Object.freeze({ width: '100%' as const, maxWidth: 720, alignSelf: 'center' as const });

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
