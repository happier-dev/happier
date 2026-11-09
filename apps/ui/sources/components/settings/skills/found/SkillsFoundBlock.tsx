import * as React from 'react';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { CapabilityRow } from '@/components/capabilities/row/CapabilityRow';
import { formatAgentNameListFolded } from '@/components/capabilities/identity/agentNameList';
import { useWhereItsOnNames } from '@/components/capabilities/where/useWhereItsOnNames';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Modal } from '@/modal';
import type { ReachMachine } from '@/sync/domains/capabilities/reach/useReachProjection';
import {
  useFoundSkills,
  useFoundSkillsCount,
} from '@/sync/domains/skills/useFoundSkills';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import {
  SKILLS_FOUND_ROUTE,
  foundAgentIds,
  pickFoundHomeRows,
  type FoundHomeRow,
} from './foundSkillsModel';
import { describeSkillInstallIncomplete, type SkillCreationAcknowledgment } from '../add/skillInstall';

const foundKey = (row: FoundHomeRow) => `${row.machineId}:${row.item.path}`;

/** The block shows the thing itself, a few rows (lab hs A2); "See all" opens the rest. */
const HOME_ROOM = 3;
const NO_MACHINES: readonly Readonly<{ machineId: string; name: string }>[] = Object.freeze([]);

/** Opens the Found page: the block's "See all" and the empty homepage's "Review the N found". */
export function useOpenSkillsFound(): () => void {
  const router = useRouter();
  return React.useCallback(() => {
    const result = runGuardedNavigation(() =>
      router.push(SKILLS_FOUND_ROUTE as never),
    );
    if (result !== true)
      fireAndForget(result, { tag: 'SkillsFoundBlock.open' });
  }, [router]);
}

/**
 * "Found on your machines" on the Skills homepage (P6 §4.2, lab hs A2/A3): a few skills the agents
 * already keep in their own folders, from this device's last known scans (opening the homepage reads
 * no machine), each with Add to library. Nothing known, no block.
 */
export const SkillsFoundBlock = React.memo(function SkillsFoundBlock(
  props: Readonly<{
    machines: readonly ReachMachine[];
  }>,
) {
  const machineIds = React.useMemo(
    () => props.machines.map((machine) => machine.machineId),
    [props.machines],
  );
  const found = useFoundSkills(machineIds);
  const total = useFoundSkillsCount(machineIds);
  const openFound = useOpenSkillsFound();
  const [adding, setAdding] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [acknowledged, setAcknowledged] = React.useState<ReadonlyMap<string, Readonly<{ name: string; receipt: SkillCreationAcknowledgment }>>>(() => new Map());
  const { adopt, scan } = found;

  const results = React.useMemo(
    () =>
      Object.fromEntries(
        found.scans.map((entry) => [entry.machineId, entry.result]),
      ),
    [found.scans],
  );
  const rows = React.useMemo(
    () => pickFoundHomeRows(props.machines, results, HOME_ROOM),
    [props.machines, results],
  );
  // Every agent that reads a shown skill, installed on its machine or not, by its name.
  const agentIds = React.useMemo(() => [...new Set(rows.flatMap((row) => foundAgentIds(row.item)))], [rows]);
  const { names } = useWhereItsOnNames({ agentIds, machines: NO_MACHINES });
  const machineById = React.useMemo(
    () =>
      new Map(props.machines.map((machine) => [machine.machineId, machine])),
    [props.machines],
  );

  // Adding keeps the row busy until its machine has been read again; then it leaves (it is in the library).
  const add = React.useCallback(
    async (row: FoundHomeRow) => {
      const key = foundKey(row);
      setAdding((prev) => new Set(prev).add(key));
      try {
        const outcome = await adopt(row.machineId, [row.item]);
        if (outcome === null) {
          Modal.alert(
            t('common.error'),
            t('capabilities.skillsFound.addFailed', { name: row.item.name }),
          );
          return;
        }
        if (outcome.incomplete.length > 0) setAcknowledged(previous => new Map(previous).set(key, { name: row.item.name, receipt: outcome }));
        await scan(row.machineId);
      } finally {
        setAdding((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    },
    [adopt, scan],
  );

  const partials = [...acknowledged].filter(([, { receipt }]) => receipt.incomplete.length > 0);
  if (rows.length === 0 && partials.length === 0) return null;
  return (
    <ItemGroup
      testID="skills.home.found"
      title={t('capabilities.skillsFound.destination')}
      description={t('capabilities.skillsFound.homeBody')}
      action={
        <SectionActionButton
          testID="skills.home.found.seeAll"
          title={t('capabilities.skillsFound.seeAll', {
            count: Math.max(total, rows.length),
          })}
          icon="desktop"
          onPress={openFound}
        />
      }
    >
      {partials.map(([key, { name, receipt }]) => <SurfaceStateCard key={key} testID={`skills.home.found.partial.${key}`} kind="error" size="line"
        title={`${name} · ${describeSkillInstallIncomplete(receipt)}`}
        action={{ label: t('capabilities.skillAdd.partial.tryAgain'), busy: adding.has(key), onPress: async () => {
          if (adding.has(key)) return;
          setAdding(previous => new Set(previous).add(key));
          try {
            const repaired = await found.retryRules(receipt);
            setAcknowledged(previous => {
              const next = new Map(previous);
              if (repaired.incomplete.length > 0) next.set(key, { name, receipt: repaired });
              else next.delete(key);
              return next;
            });
          } finally { setAdding(previous => { const next = new Set(previous); next.delete(key); return next; }); }
        } }} />)}
      {rows.map((row) => {
        const machine = machineById.get(row.machineId);
        const busy = adding.has(foundKey(row));
        const agents = names.agentNames(foundAgentIds(row.item));
        return (
          <CapabilityRow
            key={`${row.machineId}:${row.item.path}`}
            testID={`skills.home.found.${row.item.name}`}
            title={row.item.name}
            description={row.item.description ?? undefined}
            facts={{
              presentation: 'row',
              extra: [
                machine?.name ?? row.machineId,
                ...(agents.length > 0
                  ? [
                      t('capabilities.skillsFound.readBy', {
                        agents: formatAgentNameListFolded(agents),
                        count: agents.length,
                      }),
                    ]
                  : []),
              ],
            }}
            action={
              <RoundButton
                testID={`skills.home.found.add.${row.item.name}`}
                size="small"
                display="secondary"
                title={
                  busy
                    ? t('capabilities.skillsFound.adding')
                    : t('capabilities.skillsFound.add')
                }
                loading={busy}
                disabled={busy || acknowledged.has(foundKey(row)) || machine?.online !== true}
                onPress={() => void add(row)}
              />
            }
            stackActionWhenNarrow
            density="page"
          />
        );
      })}
    </ItemGroup>
  );
});
