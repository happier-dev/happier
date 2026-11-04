import React from 'react';
import { ThreadExample } from './threadSurface.js';
import { ReplyQuoteExample } from './replyQuoteSurface.js';
import { ReturnedAnswerQuoteExample } from './returnedAnswerQuoteSurface.js';
import { ExecutableParticipantPickerExample } from './executableParticipantPickerSurface.js';
import {
  Card,
  CollectionToolbar,
  ContextMenu,
  defineUiSurface,
  Dropdown,
  Form,
  ListDetailLayout,
  Menu,
  ModalHeader,
  type ModalHeaderProps,
  Item,
  SheetMenu,
  Popover,
  SessionComposer,
  SessionProvider,
  SessionTranscript,
  Text,
  usePluginHostApi,
  useLivePluginResource,
  usePluginResource,
  usePluginTheme,
} from '@happier-dev/plugin-ui';
import {
  usePluginCollectionQuery,
  usePluginUiDataClient,
} from '@happier-dev/plugin-ui/data';
import {
  StackedSeriesChart, Heatmap, DotGrid, IntervalTimeline, CapacityBar,
  BurnUpChart, RankedRows, CompositionStrip, OutcomeScatter, OutcomeFunnel,
  type StackedSeriesBand,
  ModalHeader as ComponentsModalHeader,
  type ModalHeaderProps as ComponentsModalHeaderProps,
} from '@happier-dev/plugin-ui/components';

const summary = { pluginId: 'example.plugin-ui', localId: 'summary' } as const;

function Summary() {
  const hostApi = usePluginHostApi();
  const { resource } = usePluginResource(summary);
  const { resource: liveResource } = useLivePluginResource(summary);
  usePluginUiDataClient();
  const collectionQuery = usePluginCollectionQuery('tasks', 'open');
  // The host projects the theme from the user's active profile; an author reads
  // it, never authors it.
  const theme = usePluginTheme();

  return (
    <Card>
      <Text variant="title" valueKey="example.pluginUi.summary.title" fallback="Plugin summary" />
      <Text
        variant="title"
        value={resource.pending === 'initial' ? 'loading' : resource.freshness}
      />
      <Text tone="muted" value={hostApi.version().apiVersion} />
      <Text tone="muted" value={liveResource.subscription} />
      <Text tone="muted" value={collectionQuery.status} />
      <Text tone="secondary" value={`v${theme.version}`} />
      <ExternalAuthoringForm />
      <ExternalAuthoringOverlays />
      <NeutralMeasurements />
      <ThreadExample />
      <ReplyQuoteExample />
      <ReturnedAnswerQuoteExample />
      <ExecutableParticipantPickerExample multiple />
    </Card>
  );
}

/** Public chart inputs are measurements, not Happier Usage identifiers or fetching policy. */
function NeutralMeasurements() {
  const theme = usePluginTheme();
  const series = [{ id: 'temperature', label: 'Temperature', points: [
    { id: 'morning', x: 0, y: 0, label: 'Morning' }, { id: 'noon', x: 6, y: 21, label: 'Noon' },
    { id: 'evening', x: 12, y: null, label: 'Evening', annotation: 'Not measured' },
  ] }];
  const rows = [{ id: 'north', label: 'North greenhouse', value: 21 }, { id: 'south', label: 'South greenhouse', value: null }];
  const bounds = [
    { id: 'low', label: 'Low reading', points: [{ id: 'morning', x: 0, y: 1 }, { id: 'noon', x: 6, y: 17 }] },
    { id: 'high', label: 'High reading', points: [{ id: 'morning', x: 0, y: 3 }, { id: 'noon', x: 6, y: 21 }] },
  ];
  const bands = [{ id: 'readings', lowerSeriesId: 'low', upperSeriesId: 'high' }] satisfies readonly StackedSeriesBand[];
  const grid = { theme, label: 'Plant samples', rows: [{ id: 'plants', label: 'Plants' }],
    columns: [{ id: 'morning', label: 'Morning' }, { id: 'noon', label: 'Noon' }],
    cells: [{ id: 'dry', row: 'plants', column: 'morning', label: 'Morning moisture', value: 0 },
      { id: 'wet', row: 'plants', column: 'noon', label: 'Noon moisture', value: 17 }] };
  return <>
    <StackedSeriesChart theme={theme} label="Greenhouse temperature" series={series} variant="area" size="tile" />
    <BurnUpChart theme={theme} label="Water collected" series={series} size="tile" />
    <BurnUpChart theme={theme} label="Greenhouse reading range" series={bounds} bands={bands} size="tile" />
    <Heatmap {...grid} size="tile" />
    <DotGrid {...grid} size="tile" />
    <IntervalTimeline theme={theme} label="Irrigation" domain={{ start: 0, end: 24 }}
      intervals={[{ id: 'north', label: 'North greenhouse', start: 6, end: 8 }]} basis="Hours" />
    <CapacityBar theme={theme} label="Water tank" value={17} capacity={30} basis="Litres" />
    <RankedRows theme={theme} label="Temperatures" rows={rows} basis="Degrees" size="inline" />
    <CompositionStrip theme={theme} label="Planting area" total={10} variant="waffle" size="tile"
      segments={[{ id: 'tomatoes', label: 'Tomatoes', value: 4 }, { id: 'herbs', label: 'Herbs', value: 6 }]} />
    <OutcomeScatter theme={theme} label="Growth samples" xLabel="Water" yLabel="Height"
      points={[{ id: 'north', label: 'North greenhouse', x: 17, y: 21 }]} />
    <OutcomeFunnel theme={theme} label="Propagation" steps={[{ id: 'seeds', label: 'Seeds', value: 30 },
      { id: 'sprouts', label: 'Sprouts', value: 17 }]} basis="Plants" />
  </>;
}

/**
 * This is an authored public-API consumer, not a host demo: an installed
 * external package owns the draft and its local submit/cancel outcomes while
 * the shared Form root owns only semantic presentation and pending state.
 */
function ExternalAuthoringForm() {
  const [value, setValue] = React.useState<Record<string, unknown>>({ note: '' });
  const [status, setStatus] = React.useState('Ready to save');

  return (
    <>
      <Form
        hints={{
          title: 'Example note',
          submitLabel: 'Save note',
          fields: [
            { path: 'note', title: 'Note', widget: 'text', required: true },
            { path: 'repository', title: 'Repository', widget: 'select',
              inputType: { pluginId: 'example.plugin-ui', localId: 'repository' } },
          ],
        }}
        value={value}
        onChange={setValue}
        onSubmit={(submitted) => {
          setStatus(`Saved ${String(submitted.note ?? '')}`);
        }}
        onCancel={() => {
          setValue({ note: '' });
          setStatus('Editing cancelled');
        }}
        cancelLabel="Discard note"
      />
      <Text tone="muted" value={status} />
    </>
  );
}

/**
 * A real external author retains only domain state: each overlay's visibility
 * and selected semantic action. The host continues to own the portal, anchor
 * measurement, focus return, collision handling, Escape, outside press, and
 * Android Back through the public component contract.
 */
function ExternalAuthoringOverlays() {
  const [popoverOpen, setPopoverOpen] = React.useState(false);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [dropdownOpen, setDropdownOpen] = React.useState(false);
  const [contextMenuOpen, setContextMenuOpen] = React.useState(false);
  const [filtersOpen, setFiltersOpen] = React.useState(false);
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const [openOnly, setOpenOnly] = React.useState(false);
  const [selectedAction, setSelectedAction] = React.useState('No action selected');
  const onSelect = (id: string) => {
    setSelectedAction(`Selected ${id}`);
  };
  const groups = [{ id: 'state', accessibilityLabel: 'State', items: [
    { id: 'open', label: 'Open only', kind: 'checkbox' as const, checked: openOnly },
  ] }];
  const selectFilter = () => setOpenOnly(value => !value);

  return (
    <>
      <CollectionToolbar refine={{ label: 'Filters', activeCount: openOnly ? 1 : 0,
        render: () => <Menu open={filtersOpen} onOpenChange={setFiltersOpen}
          trigger="Filters" triggerAccessibilityLabel="Filter entries" groups={groups} onSelect={selectFilter} />,
        sheet: { groups, onSelect: selectFilter, clear: { label: 'Clear', onPress: () => setOpenOnly(false) },
          showResultsLabel: 'Show results' },
      }} />
      <SheetMenu open={sheetOpen} onOpenChange={setSheetOpen} trigger="Filters"
        triggerAccessibilityLabel="Filter entries" groups={groups} onSelect={selectFilter}
        triggerCount={openOnly ? 1 : 0} sheet={{ title: 'Filters' }} />
      <Item title="workspace/packages/example/src/entry.tsx" titleEllipsizeMode="middle" />
      <Popover
        open={popoverOpen}
        onOpenChange={setPopoverOpen}
        trigger="Show details"
        triggerAccessibilityLabel="Show plugin details"
        contentAccessibilityLabel="Plugin details"
        floatingRole="panel"
      >
        <Text value="This content is positioned and dismissed by the host Popover." />
      </Popover>
      <Menu
        open={menuOpen}
        onOpenChange={setMenuOpen}
        trigger="Actions"
        triggerAccessibilityLabel="Open plugin actions"
        items={[
          { id: 'refresh', label: 'Refresh' },
          { id: 'archive', label: 'Archive', disabled: true },
        ]}
        onSelect={onSelect}
      />
      <Dropdown
        open={dropdownOpen}
        onOpenChange={setDropdownOpen}
        trigger="Sort"
        triggerAccessibilityLabel="Choose sort order"
        items={[
          { id: 'recent', label: 'Most recent' },
          { id: 'name', label: 'Name' },
        ]}
        onSelect={onSelect}
      />
      <ContextMenu
        open={contextMenuOpen}
        onOpenChange={setContextMenuOpen}
        trigger="More options"
        triggerAccessibilityLabel="Open more plugin options"
        items={[{ id: 'copy', label: 'Copy reference' }]}
        onSelect={onSelect}
      />
      <Text tone="muted" value={selectedAction} />
      <ModalHeader {...({ title: 'Plugin details', subtitle: selectedAction,
        compact: true, onClose: () => setPopoverOpen(false) } satisfies ModalHeaderProps)} />
      <ComponentsModalHeader {...({ title: 'Plugin actions', actions: <Text value={selectedAction} />,
        compact: true } satisfies ComponentsModalHeaderProps)} />
    </>
  );
}

/**
 * One live Session arranged by the author: the lead's own facts beside the transcript, the
 * composer under it. Every part is a view of the one host controller `SessionProvider` mounts; the
 * author gets no transcript, draft, callback or approval authority, and hosts that cannot present a
 * Session render the fallback.
 */
function LeadSession() {
  const leadSessionId = 'lead-session-42';
  return (
    <SessionProvider
      sessionId={leadSessionId}
      fallback={<Text tone="muted" value="Open this lead's chat in Happier" />}
    >
      <ListDetailLayout
        resizeKey="lead-session"
        minListWidth={240}
        minDetailWidth={360}
        preferredListRatio={0.35}
        list={(
          <Card>
            <Text variant="title" value="Acme Corp" />
            <Text tone="muted" value="Inbound · Qualified" />
          </Card>
        )}
        detail={(
          <>
            <SessionTranscript />
            <SessionComposer />
          </>
        )}
      />
    </SessionProvider>
  );
}

/**
 * The artifact's bundle-contract export (§3.9).
 *
 * An external author writes NO host wiring: no provider mount, no `hostApi` or
 * `context` threading. The entry wrapper installs the environment from the
 * render context the host already passes, using this bundle's own copy of the
 * provider — the only copy whose React contexts the components above can read.
 */
export const renderSurface = defineUiSurface(Summary);

/** The custom-arrangement Session consumer (plan 05 §4.8). */
export const renderLeadSessionSurface = defineUiSurface(LeadSession);

/** The built-in page pieces one surface composes: header, needs-you highlight, compact approval. */
export { BuiltInParityExample } from './builtInParitySurface.js';
