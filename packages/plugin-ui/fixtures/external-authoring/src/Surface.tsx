import React from 'react';
import {
  Card,
  ContextMenu,
  defineUiSurface,
  Dropdown,
  Form,
  Menu,
  Popover,
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
    </Card>
  );
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
          fields: [{ path: 'note', title: 'Note', widget: 'text', required: true }],
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
  const [selectedAction, setSelectedAction] = React.useState('No action selected');
  const onSelect = (id: string) => {
    setSelectedAction(`Selected ${id}`);
  };

  return (
    <>
      <Popover
        open={popoverOpen}
        onOpenChange={setPopoverOpen}
        trigger="Show details"
        triggerAccessibilityLabel="Show plugin details"
        contentAccessibilityLabel="Plugin details"
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
    </>
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
