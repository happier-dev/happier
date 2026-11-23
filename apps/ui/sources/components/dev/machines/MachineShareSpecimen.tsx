import * as React from 'react';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import { presentMachineAuthorityV1 } from '@happier-dev/protocol/machines/machineAuthorityV1';
import { ShareSheet } from '@happier-dev/plugin-ui/components';

import { createMachineMetadataFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { SHARE_SHEET_HOST } from '@/components/sharing/shareSheetHost';
import { presentShareSheet } from '@/components/sharing/presentShareSheet';
import { presentSharePrincipal } from '@/components/sharing/sharePrincipalPresentation';
import type { ShareSheetActions } from '@/components/sharing/shareSheetTypes';
import { createMachineShareAdapter } from '@/components/sharing/machines/machineShareAdapter';
import type {
  MachineShareGrantRow,
  useMachineShareController,
} from '@/components/sharing/machines/useMachineShareController';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import type { CustomModalInjectedProps } from '@/modal/types';
import { t } from '@/text';

type Controller = ReturnType<typeof useMachineShareController>;
type GuestExecution = Controller['guestExecution'];

/** How agents run on the specimen Machine, as its metadata and readiness report say. */
const STATES = {
  // Isolation off: the people the owner adds work as them; Linux offers separate users.
  isolationOff: {
    platform: 'linux',
    policy: { enabled: false },
    isolation: { kind: 'disabled' },
  },
  isolationOffMac: {
    platform: 'darwin',
    policy: { enabled: false },
    isolation: { kind: 'disabled' },
  },
  // Isolation on: nothing about working as the owner.
  isolationOn: {
    platform: 'linux',
    policy: { enabled: true },
    isolation: {
      kind: 'effective',
      platform: 'linux',
      agentUser: 'happier-agent',
    },
  },
  separateUsers: {
    platform: 'linux',
    policy: { enabled: true, memberProvisioning: 'linuxUsersV1' },
    isolation: {
      kind: 'effective',
      platform: 'linux',
      agentUser: 'happier-agent',
    },
  },
} as const;
type StateId = keyof typeof STATES;
const isStateId = (value: string): value is StateId => value in STATES;

const MACHINE = 'Studio Linux';
const UNBOUND = {
  ok: false,
  errorCode: 'action_account_scope_changed',
  error: 'action_account_scope_changed',
} as const;
const noAction = () => Promise.resolve(UNBOUND);
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

function readGuestExecution(id: StateId): GuestExecution {
  const state = STATES[id];
  const metadata = createMachineMetadataFixture({ platform: state.platform });
  const { separateUsers, isolation } = presentMachineAuthorityV1({
    platform: metadata.platform,
    isolationPolicy: state.policy,
    isolation: state.isolation,
  });
  return {
    machineId: 'studio-linux',
    serverId: null,
    placement: separateUsers.placement,
    availability: separateUsers.availability,
    isolation,
    canEnableSeparateUsers: separateUsers.availability.kind === 'can_turn_on',
    runAs:
      separateUsers.availability.kind === 'unavailable'
        ? null
        : separateUsers.placement,
    canChooseRunAs: separateUsers.availability.kind !== 'unavailable',
    previewSeparateUsers: noAction,
    applySeparateUsers: noAction,
    forgetWorkspace: noAction,
  };
}

const grant = (
  ref: PrincipalRefV1,
  name: string,
  level: 'view' | 'admin',
): MachineShareGrantRow => ({
  grant: ref,
  principal: presentSharePrincipal({ ref, name, viewerAccountId: 'me' }),
  level: { kind: 'editable', value: level, options: ['view', 'admin'] },
  removal: { kind: 'allowed' },
  operation: { kind: 'idle' },
  readiness: 'ready',
  audience: [],
  canPrepareKeys: false,
});

/** The owner's view of the Machine's share sheet, from fixtures (no server). */
function readController(id: StateId): Controller {
  return {
    model: {
      revision: 1,
      editable: true,
      stale: false,
      owner: {
        principal: presentSharePrincipal({
          ref: { kind: 'account', accountId: 'me' },
          name: 'Leeroy Brun',
          viewerAccountId: 'me',
        }),
      },
      grants: [
        grant({ kind: 'account', accountId: 'maya' }, 'Maya Chen', 'view'),
        grant({ kind: 'team', teamId: 'core' }, 'Core', 'view'),
      ],
      directory: { query: '', sections: [] },
    },
    actions: ACTIONS,
    response: null,
    guestExecution: readGuestExecution(id),
    viewerRow: null,
    inherited: [],
    canLeave: false,
    loading: false,
    issue: undefined,
    audience: undefined,
    audienceNames: undefined,
    notice: undefined,
    retryContent: async () => {},
    approvalId: null,
    prepareKeys: noop,
  };
}

function SpecimenSheet(
  props: CustomModalInjectedProps & Readonly<{ id: StateId }>,
) {
  const controller = readController(props.id);
  const adapter = createMachineShareAdapter({
    machineName: MACHINE,
    online: true,
    controller,
  });
  return (
    <ShareSheet
      host={SHARE_SHEET_HOST}
      model={controller.model}
      actions={controller.actions}
      adapter={adapter}
      presentation="full"
      onRequestClose={props.onClose}
      testID="machine-share-specimen"
    />
  );
}

function open(id: StateId) {
  presentShareSheet({
    component: SpecimenSheet,
    props: { id },
    testID: 'machine-share-modal',
    title: t('shareSheet.documents.shareTitle', { name: MACHINE }),
  });
}

/** Dev specimen: a Machine's share sheet for each way its agents run. `?state=isolationOff|isolationOffMac|isolationOn|separateUsers`. */
export function MachineShareSpecimen(props: Readonly<{ state?: string }>) {
  React.useEffect(() => {
    if (props.state && isStateId(props.state)) open(props.state);
  }, [props.state]);
  return (
    <ItemList>
      <ItemGroup title="Machine share states">
        {Object.keys(STATES)
          .filter(isStateId)
          .map((id) => (
            <Item
              key={id}
              testID={`machine-share-specimen:${id}`}
              title={id}
              onPress={() => open(id)}
            />
          ))}
      </ItemGroup>
    </ItemList>
  );
}
