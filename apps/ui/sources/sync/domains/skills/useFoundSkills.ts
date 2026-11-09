import * as React from 'react';
import {
  SKILL_ACTION_OUTPUT_SCHEMAS_V1,
  SkillFoundListResultV1Schema,
  type SkillFoundListResultV1,
} from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import { SkillReadResultV1Schema } from '@happier-dev/protocol/prompts/library/skills/skillReadV1';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { readSkillText } from '@/components/settings/skills/detail/skillFileContent';
import { readSkillActionRefusal } from '@/components/settings/skills/detail/useSkillDetail';
import { acknowledgeSkillCreation, retrySkillInstallRules, type SkillCreationAcknowledgment } from '@/components/settings/skills/add/skillInstall';
import {
  useFoundCacheEntries,
  useFoundMachineScans,
  type FoundMachineFailure,
  type FoundMachineScanOutcome,
  type FoundMachineScanOf,
} from '@/sync/domains/capabilities/found/useFoundMachineScans';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { foundSkillsByName } from './foundSkillInventory';

export type FoundItem = SkillFoundListResultV1['items'][number];
export type { FoundMachineFailure };

/** One machine's Found skills list as the page shows it: the last known result, and what is happening now. */
export type FoundMachineScan = FoundMachineScanOf<SkillFoundListResultV1>;

export type FoundAdoptOutcome = SkillCreationAcknowledgment;

const NOT_AVAILABLE = /RPC_METHOD_(NOT_AVAILABLE|NOT_FOUND)|unsupported_action/;

/**
 * The last known `skills.found.list` result per machine from the device-local warm cache, kept current
 * as any reader writes it (the page's scan, the composer's). It never reads a machine.
 */
export function useFoundSkillsCache(machineIds: readonly string[], requestedScope?: ServerAccountScope | null) {
  return useFoundCacheEntries('skill', machineIds, requestedScope);
}

/** Distinct Found skill names not in the library yet, across the last known results. */
export function useFoundSkillsCount(machineIds: readonly string[]): number {
  const entries = useFoundSkillsCache(machineIds);
  return React.useMemo(() => {
    let count = 0;
    for (const _row of foundSkillsByName(Object.keys(entries), entries, item => item.inLibrary === null)) count += 1;
    return count;
  }, [entries]);
}

/**
 * "Found on your machines" data (P6 C40): `skills.found.list` per machine through the mounted Action
 * executor, whose ingress keeps the last known result per machine in the device-local warm cache. The
 * page reads that cache first, so reopening never flashes empty, then scans every machine that can be
 * reached. Adopt and Compare reuse the same executor: bytes always travel over the machine transfer,
 * never through this cache.
 */
export function useFoundSkills(machineIds: readonly string[]) {
  const scope = useAccountSettingsScope();
  const { execute, ready } = useMountedActionExecution(scope?.serverId ?? null);
  const scanOne = React.useCallback(
    async (machineId: string): Promise<FoundMachineScanOutcome> => {
      const response = await execute('skills.found.list', { machineId });
      if (!response.ok) {
        return NOT_AVAILABLE.test(`${response.errorCode ?? ''} ${response.error ?? ''}`) ? 'older_machine'
          : { failure: 'failed', cause: response.errorCode ?? null };
      }
      // The executor's ingress writes the cache; the page reads it back through `useFoundSkillsCache`.
      return SkillFoundListResultV1Schema.safeParse(response.result).success ? null : 'failed';
    },
    [execute],
  );
  const { scans, scan } = useFoundMachineScans('skill', machineIds, scanOne);

  /** `skills.found.adopt`: one call for every item (bytes over the machine transfer, default reach). */
  const adopt = React.useCallback(
    async (
      machineId: string,
      items: readonly Readonly<{ name: string; path: string }>[],
    ): Promise<FoundAdoptOutcome | null> => {
      const response = await execute('skills.found.adopt', {
        machineId,
        items: items.map(({ name, path }) => ({ name, path })),
      });
      if (readSkillActionRefusal(response) !== null || !response.ok) return null;
      const receipt = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.found.adopt'].parse(
        response.result,
      );
      return acknowledgeSkillCreation(receipt);
    },
    [execute],
  );

  const retryRules = React.useCallback((receipt: FoundAdoptOutcome) => retrySkillInstallRules(execute, receipt), [execute]);

  /** Both sides of a masked name: the library copy and the machine's copy of its SKILL.md. */
  const readBoth = React.useCallback(
    async (
      machineId: string,
      path: string,
      librarySkillId: string,
    ): Promise<Readonly<{ yours: string; theirs: string }> | null> => {
      const [mine, theirs] = await Promise.all([
        execute('skills.read', { skillId: librarySkillId }),
        execute('skills.found.read', { machineId, path }),
      ]);
      if (readSkillActionRefusal(mine) !== null || !mine.ok) return null;
      if (readSkillActionRefusal(theirs) !== null || !theirs.ok) return null;
      const yours = SkillReadResultV1Schema.parse(mine.result).skillMd;
      const bundle = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.found.read'].parse(
        theirs.result,
      );
      const file = bundle.files.find((entry) => entry.path === 'SKILL.md');
      return file ? { yours, theirs: readSkillText(file.contentBase64) } : null;
    },
    [execute],
  );

  return { scans, scan, adopt, retryRules, readBoth, ready, scope };
}
