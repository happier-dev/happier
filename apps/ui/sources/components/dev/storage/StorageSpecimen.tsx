import * as React from 'react';
import type { StorageInventoryItemV1, StorageInventoryV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';

import { AccountStorageBody } from '@/components/storage/account/AccountStorageView';
import {
  projectAccountStorageItems,
  type AccountStorageItemFilter,
} from '@/components/storage/account/accountStorageModel';
import { View } from 'react-native';

import { PaneHeaderSlotProvider, PaneHeaderSlotScope, usePaneHeaderSlotContent } from '@/components/appShell/panes/paneHeaderSlot';
import { RightSidebarPaneHeader } from '@/components/appShell/rightSidebar/RightSidebarPaneHeader';
import { useDetailNavigationItems } from '@/components/appShell/rightSidebar/useDetailNavigationItems';
import { DiscussionStorageView, type DiscussionStorageFile } from '@/components/storage/discussion/DiscussionStorageView';
import { SidePaneBodyProvider } from '@/components/ui/lists/listPresentation';
import { SurfaceStateSizeProvider } from '@/components/ui/surfaces/surfaceStateSize';
import { t } from '@/text';
import { confirmRemoveDiscussionFile, confirmTrimOldVersions } from '@/components/storage/storageConfirmations';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { fireAndForget } from '@/utils/system/fireAndForget';

/**
 * Dev-only specimen of the Account's Storage view (lab `storage-view-1119`) drawn through the real `AccountStorageBody`
 * with the lab's Account (1.84 GB stored), so lab and app compare side by side. States: `settings` (scene 1 A, a 5 GB
 * Artifact limit), `map` (scene 1 Map), `art` (scene 1 opened from Artifacts), `nolimit`, `near`, `over`, `loading`,
 * `empty`, `unknown` (the read failed; one Artifact this device cannot decrypt) — scene 2. `discussionPane` and
 * `discussionPage`: the view scoped to one Discussion (scene 5 A, the Details pane at its width, and the phone's pushed
 * page). `deleteVersions` and `deleteAttachment`: the scene 3 confirmations over the view. Rows carry the server's
 * admission facts (`viewerMayTrim`, `viewerMayRemove`) as the storage read owner reports them.
 */
export const STORAGE_SPECIMEN_STATES = [
  'settings',
  'map',
  'art',
  'nolimit',
  'near',
  'over',
  'loading',
  'empty',
  'unknown',
  'discussionPane',
  'discussionPage',
  'deleteVersions',
  'deleteAttachment',
] as const;
export type StorageSpecimenState = (typeof STORAGE_SPECIMEN_STATES)[number];

const DAY = 86_400_000;
const MB = 1_000_000;

const LAB: StorageInventoryV1 = {
  totalBytes: 1_839_800_000,
  artifactLimitBytes: 5_000_000_000,
  unmeasuredKinds: ['profilePictures'],
  byKind: {
    artifacts: 1_622_000_000,
    pluginArtifacts: 0,
    discussionAttachments: 168_000_000,
    accountPets: 31_600_000,
    pluginCollections: 18_200_000,
  },
};
const EMPTY: StorageInventoryV1 = {
  totalBytes: 0,
  artifactLimitBytes: null,
  unmeasuredKinds: [],
  byKind: {
    artifacts: 0,
    pluginArtifacts: 0,
    discussionAttachments: 0,
    accountPets: 0,
    pluginCollections: 0,
  },
};
const NOOP = () => {};
/** The Details pane's width in the lab's discussion scene (a specimen harness, not a layout). */
const PANE_WIDTH = 372;

function discussionFiles(now: number): readonly DiscussionStorageFile[] {
  const file = (key: string, name: string, author: string, ageDays: number, bytes: number, canRemove: boolean) =>
    ({ key, name, author, at: now - ageDays * DAY, bytes, canRemove });
  return [
    file('f1', 'checkout-bug-repro.mov', 'Mika Tanaka', 8, 64.2 * MB, false),
    file('f2', 'network-trace.har', 'You', 8, 9.8 * MB, true),
    file('f3', 'stripe-webhook-payloads.json', 'Sam Okafor', 7, 3.6 * MB, false),
    file('f4', 'cart-empty.png', 'Mika Tanaka', 8, 2.4 * MB, false),
    file('f5', 'payment-error.png', 'You', 7, 2.1 * MB, true),
    file('f6', 'perf-profile.json', 'Ari Novak', 6, 1.9 * MB, false),
    file('f7', 'safari-console.txt', 'Ari Novak', 6, 1.3 * MB, false),
    file('f8', 'repro-steps.md', 'You', 5, 1.1 * MB, true),
  ];
}

/**
 * The Discussion's Details pane with Storage open in it (scene 5 A): the real pane band reads what the tab publishes
 * through the pane header slot ("‹ Details", "Storage"), as `DiscussionDetailsPanel` publishes it in a live pane.
 */
function DiscussionPaneSpecimen(props: Readonly<{ now: number }>) {
  const items = useDetailNavigationItems({ scope: 'discussion' });
  const tabs = React.useMemo(() => items.filter((item) => item.navigation.kind !== 'page'), [items]);
  return (
    <View style={{ width: PANE_WIDTH, alignSelf: 'flex-end', flex: 1 }}>
      <PaneHeaderSlotProvider>
        <RightSidebarPaneHeader testID="storage-specimen.pane-header" tabs={tabs} activeTabId="discussionDetails" onClose={NOOP} />
        <SurfaceStateSizeProvider size="pane"><SidePaneBodyProvider>
          <PaneHeaderSlotScope slotKey="discussionDetails"><DiscussionPaneStorage now={props.now} /></PaneHeaderSlotScope>
        </SidePaneBodyProvider></SurfaceStateSizeProvider>
      </PaneHeaderSlotProvider>
    </View>
  );
}

function DiscussionPaneStorage(props: Readonly<{ now: number }>) {
  const header = React.useMemo(() => ({ subpage: { title: t('artifacts.browser.storageView.title'), onBack: NOOP } }), []);
  usePaneHeaderSlotContent(header);
  return <DiscussionStorageView totalBytes={86.4 * MB} accountTotalBytes={LAB.totalBytes} files={discussionFiles(props.now)}
    presentation="pane" onShowInMessage={NOOP} onRemove={NOOP} />;
}

/** Opens a scene 3 confirmation over the view once, as a row's "…" would. */
function ConfirmOnMount(props: Readonly<{ open: () => Promise<boolean> }>) {
  const open = props.open;
  React.useEffect(() => { fireAndForget(open()); }, [open]);
  return null;
}

function fixture(id: string, title: string, header: Record<string, unknown>, ageDays: number, bytes: number, now: number,
  decrypted = true): DecryptedArtifact {
  const base = {
    id, headerVersion: 1, bodyVersion: 3, seq: 1, createdAt: now - ageDays * DAY, updatedAt: now - ageDays * DAY,
    access: 'owner' as const, ownerAccountId: 'specimen-owner', storedSizeBytes: bytes, kindHint: 'markdown',
  };
  // A row this device cannot open: the server's size, kind hint and date, and no readable header (lab scene 2).
  return decrypted
    ? { ...base, title, header: { title, ...header }, isDecrypted: true }
    : { ...base, title: null, isDecrypted: false, storageMode: 'e2ee', availability: { kind: 'locked', reason: 'encryption_material_unavailable' } };
}

function labArtifacts(
  now: number,
  unreadable: boolean,
): readonly DecryptedArtifact[] {
  return [
    fixture(
      's1',
      'Onboarding walkthrough.mp4',
      { mime: 'video/mp4' },
      6,
      286 * MB,
      now,
    ),
    fixture('s2', 'Q4 launch plan', {}, 2, 192 * MB, now),
    fixture(
      's3',
      'eval-dataset-november.parquet',
      { mime: 'application/octet-stream' },
      17,
      142 * MB,
      now,
      !unreadable,
    ),
    fixture(
      's4',
      'Design tokens board',
      { kind: 'work-board.v1' },
      22,
      41.2 * MB,
      now,
    ),
    fixture('s5', 'Release 0.3 retrospective', {}, 3, 33.8 * MB, now),
    fixture(
      's6',
      'Checkout flow diagram',
      { mime: 'image/png' },
      9,
      12.4 * MB,
      now,
    ),
    fixture('s7', 'Pricing page copy', {}, 4, 4.2 * MB, now),
    fixture('s8', 'Staging release checklist', {}, 0, 96_000, now),
  ];
}

/** The body with the filter a route would own (the specimen keeps the list as given). */
function SpecimenBody(props: Omit<React.ComponentProps<typeof AccountStorageBody>, 'filter' | 'onFilter' | 'onMore'> & Readonly<{ initialFilter: AccountStorageItemFilter }>) {
  const { initialFilter, ...rest } = props;
  const [filter, setFilter] = React.useState<AccountStorageItemFilter>(initialFilter);
  return <AccountStorageBody {...rest} filter={filter} onFilter={setFilter} onMore={null} />;
}

export function StorageSpecimen(
  props: Readonly<{ state: StorageSpecimenState }>,
): React.ReactElement {
  const [now] = React.useState(() => Date.now());
  const items = React.useMemo(() => {
    const artifacts = labArtifacts(now, props.state === 'unknown');
    // The lab's page as the storage read owner reports it: largest first, an Artifact's old versions and a Discussion file among them.
    const page: StorageInventoryItemV1[] = [
      ...artifacts.map((artifact) => ({ id: artifact.id, kind: 'artifacts' as const, storedSizeBytes: artifact.storedSizeBytes ?? null,
        createdAt: artifact.updatedAt, location: { kind: 'artifact' as const, artifactId: artifact.id } })),
      { id: 's2', kind: 'artifactOldVersions', storedSizeBytes: 186 * MB, createdAt: now - 2 * DAY, viewerMayTrim: true,
        location: { kind: 'artifact', artifactId: 's2' } },
      { id: 'blob-repro', kind: 'discussionAttachments', storedSizeBytes: 64.2 * MB, createdAt: now - 8 * DAY, viewerMayRemove: true,
        location: { kind: 'discussion', discussionId: 'specimen-discussion', messageId: 'specimen-message', attachmentId: 'blob-repro' } },
    ].sort((left, right) => (right.storedSizeBytes ?? -1) - (left.storedSizeBytes ?? -1));
    return projectAccountStorageItems(page, new Map(artifacts.map((artifact) => [artifact.id, artifact])));
  }, [now, props.state]);
  const body = (
    inventory: StorageInventoryV1 | null,
    options: Readonly<{
      filter?: AccountStorageItemFilter;
      shape?: 'map';
      failed?: boolean;
      loading?: boolean;
      empty?: boolean;
    }> = {},
  ) => (
    <SpecimenBody
      initialFilter={options.filter ?? 'all'}
      inventory={inventory}
      status={
        options.failed ? 'failed' : inventory === null ? 'loading' : 'ready'
      }
      onRetry={NOOP}
      items={options.loading || options.empty ? [] : items}
      itemsLoaded={!options.loading}
      {...(options.shape ? { initialShape: options.shape } : {})}
    />
  );
  switch (props.state) {
    case 'settings':
      return body(LAB);
    case 'map':
      return body(LAB, { shape: 'map' });
    case 'art':
      return body(LAB, { filter: 'artifacts' });
    case 'nolimit':
      return body({ ...LAB, artifactLimitBytes: null });
    case 'near':
      return body({ ...LAB, artifactLimitBytes: 1_800_000_000 });
    case 'over':
      return body({ ...LAB, artifactLimitBytes: 1_600_000_000 });
    case 'loading':
      return body(null, { loading: true });
    case 'empty':
      return body(EMPTY, { empty: true });
    case 'unknown':
      return body(null, { failed: true });
    case 'discussionPane':
      return <DiscussionPaneSpecimen now={now} />;
    case 'discussionPage':
      return <DiscussionStorageView totalBytes={86.4 * MB} accountTotalBytes={LAB.totalBytes} files={discussionFiles(now)}
        presentation="page" onShowInMessage={NOOP} onRemove={NOOP} />;
    case 'deleteVersions':
      return <>{body(LAB)}<ConfirmOnMount open={OPEN_TRIM} /></>;
    case 'deleteAttachment':
      return <>{body(LAB)}<ConfirmOnMount open={OPEN_REMOVE} /></>;
  }
}

// The lab's scene 3 numbers, as the trim and removal owners would report them.
const OPEN_TRIM = () => confirmTrimOldVersions({ title: 'Q4 launch plan', freesBytes: 186 * MB,
  limitAfter: { leftBytes: 3_570_000_000, limitBytes: 5_000_000_000 } });
const OPEN_REMOVE = () => confirmRemoveDiscussionFile({ name: 'api-trace-export.har', discussionTitle: 'Release planning', own: true,
  freesBytes: 18.6 * MB });
