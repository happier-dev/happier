import * as React from 'react';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import type { PluginActionResultById } from '@happier-dev/plugin-sdk/actions';
import { useLivePluginResourceProjection, type PluginUiResourceProjection } from '@happier-dev/plugin-ui/hostApi';
import {
  Button,
  Collection,
  EmptyState,
  FreshnessLine,
  Icon,
  ItemGroup,
  Stack,
  Status,
  SurfaceState,
  Text,
  defineUiSurface,
  useHappierCollection,
  usePluginTranslation,
  type TextTone,
} from '@happier-dev/plugin-ui';

import { DOCKER_SANDBOXES_PLUGIN_ID, DOCKER_SANDBOXES_PROVISIONER_ID } from '../machine/provider.js';
import { DOCKER_SANDBOXES_INSTALL_URL } from './installAction.js';
export { activate } from './installAction.js';
import {
  readSandboxAvailability,
  readSandboxCreateRequest,
  readSandboxPageScope,
  selectMachineSandboxes,
  type SandboxAvailability,
  type SandboxPageScope,
  type SandboxRow,
  type SandboxState,
} from './sandboxPageModel.js';

/**
 * Docker Sandboxes on one Machine (plan 30 §3.7, lab `machine/services/plugin`): the sandboxes this Machine runs
 * for agent sessions, composed from the public Collection table. It reads the Account's managed Machines and the
 * provisioner's own check for this controller through host Actions; it owns no service model, and watching or
 * restarting services stays on the Machine's Services.
 */

type Read =
  | Readonly<{ kind: 'loading' }>
  | Readonly<{ kind: 'scopeUnavailable' }>
  | Readonly<{ kind: 'ready'; availability: SandboxAvailability; rows: readonly SandboxRow[]; readAt: number }>
  | Readonly<{ kind: 'failed'; message: string; retained?: Readonly<{ availability: SandboxAvailability; rows: readonly SandboxRow[]; readAt: number }> }>;

const contribution = { pluginId: DOCKER_SANDBOXES_PLUGIN_ID, localId: DOCKER_SANDBOXES_PROVISIONER_ID };
type Inventory = Readonly<{ machines: PluginActionResultById['machines.managed.list']['machines']; readAt: number }>;
const inventoryProjection: PluginUiResourceProjection<Inventory> = {
  decode(content) {
    // This exact host-read serializes the canonical inventory's schema-admitted Action result.
    const list = JSON.parse(new TextDecoder().decode(content.bytes)) as PluginActionResultById['machines.managed.list'];
    return { machines: list.machines, readAt: Date.now() };
  },
};

async function tagged<T>(actionId: string, read: Promise<T>): Promise<T> {
  try { return unwrap<T>(await read); } catch (error) {
    const facts = error && typeof error === 'object' ? error as { code?: unknown; message?: unknown; details?: unknown } : {};
    const detail = [facts.code, facts.message, facts.details === undefined ? undefined : JSON.stringify(facts.details)]
      .filter((part, index, parts): part is string => typeof part === 'string' && part.length > 0 && parts.indexOf(part) === index);
    throw new Error(`${actionId}: ${detail.length > 0 ? detail.join(' · ') : String(error)}`);
  }
}

function unwrap<T>(result: unknown): T {
  // Host Actions answer with their typed result; a refusal arrives as `{ ok: false }` with a code.
  if (result && typeof result === 'object' && (result as { ok?: unknown }).ok === false) {
    const code = (result as { code?: unknown; error?: unknown }).code ?? (result as { error?: unknown }).error;
    throw new Error(typeof code === 'string' ? code : 'action_failed');
  }
  return result as T;
}

const STATE_TONE: Readonly<Record<SandboxState, TextTone>> = {
  running: 'neutral', creating: 'neutral', waiting: 'secondary', mayExist: 'warning', stopped: 'secondary', unknown: 'warning', gone: 'warning',
};

function SandboxesPage({ hostApi, surface }: RenderContext): React.ReactElement {
  const text = usePluginTranslation();
  const addressed = readSandboxPageScope(surface.target);
  const scope = React.useMemo(() => addressed, [addressed?.homeId, addressed?.controller.machineId, addressed?.controller.installationId]);
  const reference = React.useMemo(() => ({ hostRead: 'machines.managed.list' as const, input: { homeId: scope?.homeId ?? '' } }), [scope?.homeId]);
  const inventory = useLivePluginResourceProjection(reference, inventoryProjection, snapshot => snapshot, { enabled: scope !== null });
  const [check, setCheck] = React.useState<Readonly<{ scope: SandboxPageScope; availability: SandboxAvailability }> | null>(null);
  const current = React.useRef(0);

  const loadCheck = React.useCallback(async (pageScope: SandboxPageScope) => {
    const generation = ++current.current;
    // Native prerequisites explain an empty inventory; their refusal never fails the canonical list.
    const availability = await tagged('machines.provisioners.check', hostApi.executeAction('machines.provisioners.check', { homeId: pageScope.homeId, controller: pageScope.controller, contribution }))
      .then(readSandboxAvailability, (error: unknown): SandboxAvailability => ({ kind: 'unavailable', code: error instanceof Error ? error.message : 'action_failed' }));
    if (generation === current.current) setCheck({ scope: pageScope, availability });
  }, [hostApi]);

  React.useEffect(() => {
    if (!scope) return;
    void loadCheck(scope);
    return () => { current.current += 1; };
  }, [loadCheck, scope]);

  const retry = React.useCallback(async () => { await Promise.all([inventory.refresh(), scope ? loadCheck(scope) : undefined]); }, [inventory.refresh, loadCheck, scope]);
  const availability = check?.scope === scope ? check.availability : null;
  const admitted = inventory.value.value;
  const projectedRows = React.useMemo(() => admitted && scope ? selectMachineSandboxes(admitted.machines, scope.controller.machineId) : NO_ROWS,
    [admitted, scope]);
  const retained = admitted && availability ? { availability, rows: projectedRows, readAt: admitted.readAt } : undefined;
  const read: Read = !scope ? { kind: 'scopeUnavailable' }
    : inventory.value.error ? { kind: 'failed', message: inventory.value.error.message, ...(retained ? { retained } : {}) }
      : retained ? { kind: 'ready', ...retained } : { kind: 'loading' };
  const shown = read.kind === 'ready' ? read : read.kind === 'failed' ? read.retained ?? null : null;
  const rows = shown?.rows ?? NO_ROWS;
  const collection = useHappierCollection<SandboxRow>({ items: rows, keyOf: keyOfRow, selection: 'none', openKey: null, onOpenChange: noOpenRow });

  const createRequest = React.useMemo(() => readSandboxCreateRequest(hostApi.version().methods), [hostApi]);
  const [openFailed, setOpenFailed] = React.useState(false);
  const openNew = React.useCallback(async () => {
    if (!createRequest) return;
    setOpenFailed(false);
    try { await hostApi.openManagedMachineConfiguration(createRequest); } catch { setOpenFailed(true); }
  }, [createRequest, hostApi]);
  const lede = (
    <Stack gap="small" testID="docker-sandboxes-lede">
      {/* The lede and its one action share the section header owner: beside the sentence while it fits, beneath it on a phone. */}
      <ItemGroup surface="none"
        description={text('machineDocker.page.lede', 'Isolated machines for agent sessions on this machine, each with its own Docker. From Docker Sandboxes, a Happier plugin.')}
        action={createRequest ? (
          <Button variant="secondary" size="small" testID="docker-sandboxes-new"
            icon={<Icon name="add" size="small" />}
            title={text('machineDocker.page.new', 'New sandbox')} onPress={openNew} />
        ) : null} />
      {openFailed ? (
        <Text variant="meta" tone="warning" testID="docker-sandboxes-new-failed"
          value={text('machineDocker.page.newFailed', 'Couldn’t open New sandbox. Nothing was created; try again in a moment.')} />
      ) : null}
      {read.kind === 'failed' && read.retained ? (
        <FreshnessLine asOf={read.retained.readAt} tone="warning"
          reason={text('machineDocker.page.stale', 'This machine isn’t answering.')}
          action={{ label: text('machineDocker.page.retry', 'Retry'), onPress: () => { void retry(); } }} />
      ) : null}
    </Stack>
  );

  if (read.kind === 'scopeUnavailable') {
    return <SurfaceState kind="unavailable" testID="docker-sandboxes-scope-unavailable"
      title={text('machineDocker.page.scopeUnavailable.title', 'Sandboxes can’t be listed yet')}
      description={text('machineDocker.page.scopeUnavailable.body', 'This machine hasn’t told Happier which installation it runs. Update Happier on it, then come back.')} />;
  }
  if (read.kind === 'failed' && !read.retained) {
    return <SurfaceState kind="error" testID="docker-sandboxes-error"
      title={text('machineDocker.page.error.title', 'Couldn’t read sandboxes')}
      description={text('machineDocker.page.error.body', 'This machine didn’t answer. Sandboxes keep running; nothing changed.')}
      details={read.message}
      action={{ label: text('machineDocker.page.retry', 'Retry'), onPress: retry }} />;
  }
  const shownAvailability = shown?.availability;
  if (shownAvailability && shownAvailability.kind !== 'ready' && rows.length === 0) {
    const copy = shownAvailability.kind === 'notInstalled'
      ? [text('machineDocker.page.notInstalled.title', 'Docker Sandboxes isn’t installed'),
        text('machineDocker.page.notInstalled.body', 'Sandboxes give each agent session its own isolated machine with Docker. Install Docker Sandboxes on this machine to create sandboxes.')]
      : [text('machineDocker.page.unavailable.title', 'Sandboxes aren’t available right now'),
        text('machineDocker.page.unavailable.body', 'Happier couldn’t check Docker Sandboxes on this machine. Nothing changed; try again in a moment.')];
    // A missing sbx is a prerequisite to install, not a connection problem: it says so with its glyph.
    return <SurfaceState kind="unavailable" testID={`docker-sandboxes-${shownAvailability.kind}`} title={copy[0]} description={copy[1]}
      {...(shownAvailability.kind === 'unavailable' ? {} : { icon: 'download' as const,
        action: { label: text('machineDocker.page.getApp', 'Get Docker Sandboxes'),
          onPress: () => hostApi.openExternalLink(DOCKER_SANDBOXES_INSTALL_URL) } })}
      {...(shownAvailability.kind === 'unavailable' ? { action: { label: text('machineDocker.page.retry', 'Retry'), onPress: retry },
        ...(shownAvailability.code ? { details: shownAvailability.code } : {}) } : {})} />;
  }

  return (
    <Collection<SandboxRow>
      testID="docker-sandboxes-page"
      model={collection}
      presentation="table"
      detail="none"
      scroll="page"
      minListWidth={320}
      minDetailWidth={0}
      preferredListRatio={1}
      accessibilityLabel={text('machineDocker.page.title', 'Sandboxes')}
      loading={read.kind === 'loading'}
      loadingRows={3}
      header={lede}
      anatomy={{
        glyph: () => null,
        title: row => row.name,
        where: row => (row.templateId ? text('machineDocker.page.template', '{template} template', { template: row.templateId }) : null),
        accessibilityLabel: row => `${row.name}, ${stateLabel(text, row.state)}`,
        testID: row => `docker-sandbox-${row.managedId}`,
        columnTitles: { title: text('machineDocker.page.column.sandbox', 'Sandbox'), where: text('machineDocker.page.column.template', 'Template') },
        fields: [{
          key: 'state', title: text('machineDocker.page.column.state', 'State'), minWidth: 96, priority: 2, leading: true,
          render: row => <Status tone={STATE_TONE[row.state]} label={stateLabel(text, row.state)} presentation="inline" />,
        }],
      }}
      empty={read.kind === 'ready' ? (
        <EmptyState testID="docker-sandboxes-empty"
          title={text('machineDocker.page.empty.title', 'No sandboxes on this machine yet')}
          description={text('machineDocker.page.empty.body', 'When an agent session runs in a Docker Sandbox here, it shows up in this list.')} />
      ) : null}
      footer={<Text variant="meta" tone="secondary" testID="docker-sandboxes-services-note"
        value={text('machineDocker.page.servicesNote', 'Watching and restarting services lives on Services; this page lists only sandboxes.')} />}
    />
  );
}

const NO_ROWS: readonly SandboxRow[] = [];
const keyOfRow = (row: SandboxRow) => row.managedId;
// Rows open nothing yet: a sandbox's Machine page is reached from the Machines list.
const noOpenRow = () => {};

function stateLabel(text: ReturnType<typeof usePluginTranslation>, state: SandboxState): string {
  switch (state) {
    case 'running': return text('machineDocker.page.state.running', 'Running');
    case 'stopped': return text('machineDocker.page.state.stopped', 'Stopped');
    case 'creating': return text('machineDocker.page.state.creating', 'Creating');
    case 'waiting': return text('machineDocker.page.state.waiting', 'Waiting to create');
    case 'mayExist': return text('machineDocker.page.state.mayExist', 'May already exist');
    case 'gone': return text('machineDocker.page.state.gone', 'Gone from this machine');
    case 'unknown': return text('machineDocker.page.state.unknown', 'Not answering');
  }
}

export const renderSurface = defineUiSurface(SandboxesPage);
