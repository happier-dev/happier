import type { MachinePresetItemV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import type { MachineSetupSourceEntryV1, MachineSetupSourceV1 } from '@happier-dev/protocol/machines/setup/machineSetupSourcesV1';

export type MachineSetupCaptureInclude = 'everything' | 'own';

export type MachineSetupCaptureRow = Readonly<{ key: string; item: MachinePresetItemV1; source: MachineSetupSourceEntryV1 }>;

/**
 * What "Save as preset" copies from a Machine's retained setup sources: the rows to choose from, the source copies the
 * capture writes (unticked items dropped), and the attached presets left out by "Only what no preset added".
 */
export function projectMachineSetupCapture(
  all: MachineSetupSourceV1,
  include: MachineSetupCaptureInclude,
  unticked: ReadonlySet<string>,
): Readonly<{ rows: readonly MachineSetupCaptureRow[]; sources: MachineSetupSourceV1; leftOut: readonly MachineSetupSourceEntryV1[] }> {
  const rows: MachineSetupCaptureRow[] = [];
  const sources: MachineSetupSourceV1 = [];
  const leftOut: MachineSetupSourceEntryV1[] = [];
  all.forEach((source, sourceIndex) => {
    if (include === 'own' && source.kind !== 'direct') {
      leftOut.push(source);
      return;
    }
    const { items, ...rest } = source.setup;
    (items ?? []).forEach((item, itemIndex) => rows.push({ key: `${sourceIndex}.${itemIndex}`, item, source }));
    const kept = (items ?? []).filter((_, itemIndex) => !unticked.has(`${sourceIndex}.${itemIndex}`));
    sources.push({ ...source, setup: kept.length > 0 ? { ...rest, items: kept } : rest });
  });
  return { rows, sources, leftOut };
}
