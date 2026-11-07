import * as React from 'react';
import { useLocalSearchParams } from 'expo-router';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { presentShareSheet } from '@/components/sharing/presentShareSheet';
import { ShareSheet } from '@/components/sharing/ShareSheet';
import { presentSharePrincipal } from '@/components/sharing/sharePrincipalPresentation';
import type {
  ShareCandidateRowModel,
  ShareGrantRowModel,
  ShareSheetActions,
  ShareSheetModel,
} from '@/components/sharing/shareSheetTypes';
import {
  createTaskShareAdapter,
  readTaskShareDisclosure,
  type TaskShareRecipientState,
} from '@/components/sharing/tasks/taskShareAdapter';
import { presentTaskShareFailure } from '@/components/sharing/tasks/useTaskShareController';
import type { CustomModalInjectedProps } from '@/modal/types';
import { t } from '@/text';

/** Dev specimen: every task share state on the real sheet, from fixture rosters (no server). */
const TASK = readTaskShareDisclosure({
  title: 'Fix the Safari login redirect',
  notes:
    'Safari drops the session cookie after the OAuth bounce.\nRepro steps in the trace.',
  links: [
    { url: 'https://github.com/acme/web/pull/412', title: 'PR #412' },
    { url: 'https://docs.acme.dev/auth/cookies' },
  ],
  linkedSessions: {
    a: { title: 'Debug Safari cookie loss', linkedAt: 3 },
    b: { title: 'Review auth middleware', linkedAt: 2 },
  },
  blockedBy: ['task-a', 'task-b'],
});
const maya: PrincipalRefV1 = { kind: 'account', accountId: 'maya' };
const sam: PrincipalRefV1 = { kind: 'account', accountId: 'sam' };
const core: PrincipalRefV1 = { kind: 'team', teamId: 'core' };
const design: PrincipalRefV1 = {
  kind: 'group',
  teamId: 'core',
  groupId: 'design',
};
const viewer = presentSharePrincipal({
  ref: { kind: 'account', accountId: 'me' },
  name: 'Leeroy Brun',
  viewerAccountId: 'me',
});
const grant = (
  ref: PrincipalRefV1,
  name: string,
  level: 'view' | 'edit',
  extra?: Partial<ShareGrantRowModel>,
): ShareGrantRowModel => ({
  grant: ref,
  principal: presentSharePrincipal({
    ref,
    name,
    viewerAccountId: 'me',
    ...(ref.kind === 'group' ? { teamName: 'Core' } : {}),
  }),
  level: { kind: 'editable', value: level, options: ['view', 'edit'] },
  removal: { kind: 'allowed' },
  operation: { kind: 'idle' },
  ...extra,
});
const candidate = (
  ref: PrincipalRefV1,
  name: string,
): ShareCandidateRowModel => ({
  principal: presentSharePrincipal({
    ref,
    name,
    viewerAccountId: 'me',
    ...(ref.kind === 'group' ? { teamName: 'Core' } : {}),
  }),
  addition: { kind: 'allowed' },
  operation: { kind: 'idle' },
});
const directory = (query: string): ShareSheetModel['directory'] => ({
  query,
  sections: [
    {
      kind: 'account',
      title: t('session.access.people'),
      status: 'idle',
      cursor: null,
      hasMore: false,
      loadingMore: false,
      candidates: [
        candidate({ kind: 'account', accountId: 'ana' }, 'Ana Ruiz'),
        candidate({ kind: 'account', accountId: 'jo' }, 'Jo Park'),
      ],
    },
    {
      kind: 'team',
      title: t('session.access.teams'),
      status: 'idle',
      cursor: null,
      hasMore: false,
      loadingMore: false,
      candidates: [candidate({ kind: 'team', teamId: 'platform' }, 'Platform')],
    },
    {
      kind: 'group',
      title: t('session.access.groups'),
      status: 'idle',
      cursor: null,
      hasMore: false,
      loadingMore: false,
      candidates: [candidate(design, 'Design')],
    },
  ],
});

type Specimen = Readonly<{
  model: ShareSheetModel;
  encrypted: boolean;
  readiness: ReadonlyMap<string, TaskShareRecipientState>;
  readOnly?: boolean;
  issue?: ReturnType<typeof presentTaskShareFailure>;
  disclosure?: null;
}>;
const SPECIMENS: Readonly<Record<string, Specimen>> = {
  owner: {
    encrypted: false,
    readiness: new Map(),
    model: {
      revision: 1,
      editable: true,
      stale: false,
      owner: { principal: viewer },
      grants: [grant(maya, 'Maya Chen', 'edit'), grant(core, 'Core', 'view')],
      directory: directory(''),
    },
  },
  empty: {
    encrypted: false,
    readiness: new Map(),
    model: {
      revision: 1,
      editable: true,
      stale: false,
      owner: { principal: viewer },
      grants: [],
      directory: directory(''),
    },
  },
  encrypted: {
    encrypted: true,
    readiness: new Map<string, TaskShareRecipientState>([
      ['account:sam', { readyCount: 0, pendingCount: 0, unavailableCounts: { plain_account: 1, encryption_setup_required: 0, encryption_inconsistent: 0 } }],
      ['team:core', { readyCount: 0, pendingCount: 2, unavailableCounts: { plain_account: 0, encryption_setup_required: 0, encryption_inconsistent: 0 } }],
    ]),
    model: {
      revision: 1,
      editable: true,
      stale: false,
      owner: { principal: viewer },
      grants: [
        grant(maya, 'Maya Chen', 'edit'),
        grant(sam, 'Sam Okafor', 'view'),
        grant(core, 'Core', 'view'),
      ],
      directory: directory(''),
    },
  },
  removing: {
    encrypted: false,
    readiness: new Map(),
    model: {
      revision: 1,
      editable: true,
      stale: false,
      owner: { principal: viewer },
      grants: [
        grant(maya, 'Maya Chen', 'edit', {
          removal: {
            kind: 'confirming',
            consequences: [
              t('shareSheet.removeLosesPerson', { name: 'Maya Chen' }),
            ],
          },
        }),
        grant(design, 'Design', 'view'),
      ],
      directory: directory(''),
    },
  },
  recipient: {
    encrypted: false,
    readOnly: true,
    readiness: new Map(),
    model: {
      revision: 1,
      editable: false,
      stale: false,
      owner: null,
      grants: [grant(maya, 'Maya Chen', 'edit'), grant(core, 'Core', 'view')],
      directory: { query: '', sections: [] },
    },
  },
  update: {
    encrypted: false,
    disclosure: null,
    issue: presentTaskShareFailure('task_resource_unsupported'),
    readiness: new Map(),
    model: {
      revision: 0,
      editable: false,
      stale: false,
      owner: null,
      grants: [],
      directory: { query: '', sections: [] },
    },
  },
};

const noop = () => {};
const ACTIONS: ShareSheetActions = {
  setQuery: noop,
  retryDirectory: noop,
  loadMore: noop,
  addPrincipal: noop,
  retryMutation: noop,
  setAccessLevel: noop,
  requestRemove: noop,
  confirmRemove: noop,
  cancelRemove: noop,
  explain: noop,
};

function SpecimenSheet(
  props: CustomModalInjectedProps & Readonly<{ id: string }>,
): React.ReactElement {
  const specimen = SPECIMENS[props.id]!;
  const [query, setQuery] = React.useState(specimen.model.directory.query);
  const adapter = createTaskShareAdapter({
    disclosure: specimen.disclosure === null ? null : TASK,
    encrypted: specimen.encrypted,
    readiness: specimen.readiness,
    ...(specimen.readiness.size ? { sendKeys: noop } : {}),
    loading: false,
    readOnly: specimen.readOnly === true,
    retryContent: noop,
    ...(specimen.issue ? { issue: specimen.issue } : {}),
  });
  return (
    <ShareSheet
      model={{
        ...specimen.model,
        directory: { ...specimen.model.directory, query },
      }}
      actions={{ ...ACTIONS, setQuery }}
      adapter={adapter}
      presentation="full"
      onRequestClose={props.onClose}
      testID="task-share-specimen"
    />
  );
}

function open(id: string) {
  presentShareSheet({
    component: SpecimenSheet,
    props: { id },
    testID: 'task-share-modal',
    title: t('shareSheet.tasks.shareTitle', {
      name: 'Fix the Safari login redirect',
    }),
  });
}

export default function TaskShareSpecimenScreen(): React.ReactElement {
  const params = useLocalSearchParams<{ state?: string }>();
  React.useEffect(() => {
    if (params.state && SPECIMENS[params.state]) open(params.state);
  }, [params.state]);
  return (
    <ItemList>
      <ItemGroup title="Task share states">
        {Object.keys(SPECIMENS).map((id) => (
          <Item
            key={id}
            testID={`task-share-specimen:${id}`}
            title={id}
            onPress={() => open(id)}
          />
        ))}
      </ItemGroup>
    </ItemList>
  );
}
