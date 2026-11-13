import * as React from 'react';
import {
  MachineAccessGrantsListResponseV1Schema,
  type MachineAccessGrantsListResponseV1,
} from '@happier-dev/protocol/machines/machineAccessV1';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { t } from '@/text';

import { presentSharePrincipal } from '../sharePrincipalPresentation';
import { MachineWorkSummaryReader } from './MachineWorkSummaryReader';

type AudienceRead =
  | Readonly<{ kind: 'loading' }>
  | Readonly<{ kind: 'ready'; response: MachineAccessGrantsListResponseV1 }>
  | Readonly<{ kind: 'unavailable' }>;

const LOADING: AudienceRead = { kind: 'loading' };
const PENDING_ROWS = Object.freeze({ kind: 'loading' } as const);

/**
 * Who a Delete review names (destructive pattern, lab m-life): the people with access, from the Sharing grants
 * list Action, and who is using the Machine now, from the existing "In use by others" reader. Read once while the
 * review is open; it decides nothing and edits nothing, so the Sharing page stays the one editor.
 */
export function MachineDeleteAudience(
  props: Readonly<{
    machineId: string;
    machineName: string;
    scope: ServerAccountScope;
    online: boolean | null;
    testID: string;
  }>,
) {
  const { machineId, scope } = props;
  const [read, setRead] = React.useState<AudienceRead>(LOADING);
  React.useEffect(() => {
    const abort = new AbortController();
    setRead(LOADING);
    const execute = createFrontDoorActionExecute();
    void execute(
      'machines.access.grants.list',
      { serverId: scope.serverId, machineId },
      {
        surface: 'ui',
        authority: 'present_user',
        serverId: scope.serverId,
        expectedAccountId: scope.accountId,
        signal: abort.signal,
      },
    )
      .then((result) => {
        if (abort.signal.aborted) return;
        const parsed = result?.ok
          ? MachineAccessGrantsListResponseV1Schema.safeParse(result.result)
          : null;
        setRead(
          parsed?.success && parsed.data.machineId === machineId
            ? { kind: 'ready', response: parsed.data }
            : { kind: 'unavailable' },
        );
      })
      .catch(() => {
        if (!abort.signal.aborted) setRead({ kind: 'unavailable' });
      });
    return () => abort.abort();
  }, [machineId, scope.serverId, scope.accountId]);

  const grants = read.kind === 'ready' ? read.response.grants : [];
  return (
    <>
      <ItemGroup
        testID={props.testID}
        title={t('managedMachines.dependencies.peopleTitle')}
        description={t('managedMachines.dependencies.peopleHelp')}
      >
        {read.kind === 'loading' ? (
          <ItemLoadStateRows
            state={PENDING_ROWS}
            rows={1}
            testID={`${props.testID}.pending`}
          />
        ) : read.kind === 'unavailable' ? (
          <SurfaceStateCard
            kind="unavailable"
            size="line"
            title={t('machines.sharing.unavailable', {
              machine: props.machineName,
            })}
            testID={`${props.testID}.unavailable`}
          />
        ) : grants.length === 0 ? (
          <Item
            title={t('managedMachines.dependencies.peopleNone')}
            mode="info"
            showChevron={false}
            testID={`${props.testID}.none`}
          />
        ) : (
          grants.map((grant) => {
            const principal = presentSharePrincipal({
              ref: grant.principal,
              name: grant.display.name,
              viewerAccountId: scope.accountId,
            });
            return (
              <Item
                key={principal.key}
                title={principal.displayName}
                mode="info"
                showChevron={false}
                detail={t(
                  grant.level === 'admin'
                    ? 'machines.sharing.manage'
                    : 'machines.sharing.use',
                )}
                testID={`${props.testID}.grant.${principal.key}`}
              />
            );
          })
        )}
      </ItemGroup>
      <MachineWorkSummaryReader
        machineId={machineId}
        machineName={props.machineName}
        scope={scope}
        online={props.online}
      />
    </>
  );
}
