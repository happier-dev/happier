import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { t } from '@/text';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { measureMountedCollections } from '@/dev/testkit/render/renderInCollectionLayout';
import {
  createProcessesAnswer,
  PROCESSES_FIXTURE_BYTES,
} from '@/components/machines/processes/testkit/processesAnswerFixture';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PileBar } from '@/components/machines/storage/PileBar';
import { formatMachineBytes } from '@/components/machines/vitals/machineVitalsPresentation';
import { MachineResourcesToolBody } from '@/components/tools/renderers/system/MachineResourcesToolBody';

import { ResourceProposalProcessesContextView } from './ResourceProposalProcessesContext';

const { GB } = PROCESSES_FIXTURE_BYTES;
afterEach(() => standardCleanup());

describe('A3 · what is using memory', () => {
  it('uses the memory byte quantity for a process proposal total, while storage keeps its decimal quantity', async () => {
    const bytes = 1024 ** 2;
    const screen = await renderScreen(<>
      <PileBar testID="process-pile" bar={{ kind: 'ready', count: 1, freesBytes: bytes }}
        quantityKind="memory" note={null} compact={false} placement="card" />
      <PileBar testID="storage-pile" bar={{ kind: 'ready', count: 1, freesBytes: bytes }}
        note={null} compact={false} placement="card" />
    </>);
    expect(screen.findByTestId('process-pile')?.props.accessibilityLabel).toContain(
      t('machineStorage.pile.frees', { amount: formatMachineBytes(bytes, 'memory') }),
    );
    expect(screen.findByTestId('storage-pile')?.props.accessibilityLabel).toContain(
      t('machineStorage.pile.frees', { amount: formatMachineBytes(bytes, 'storage') }),
    );
  });

  it('draws the census as the Processes tab’s own rows, read-only', async () => {
    const answer = createProcessesAnswer();
    const screen = await renderScreen(
      <ItemList>
        <MachineResourcesToolBody
          call={{
            kind: 'processes',
            answer,
            machineId: 'edge-1',
            serverId: 'home-a',
          }}
          serverId="home-a"
        />
      </ItemList>,
    );
    await measureMountedCollections(screen, { width: 1200 });
    const memoryCells = new Set(
      screen
        .findAll(
          (node) =>
            typeof node.props.testID === 'string' &&
            node.props.testID.startsWith('machine-processes-memory-') &&
            typeof node.type === 'string',
        )
        .map((node) => String(node.props.testID)),
    );
    expect(memoryCells.size).toBeGreaterThanOrEqual(answer.owners.length);
    // Read-only: no row menu, no stop control.
    expect(
      screen.findAll((node) =>
        String(node.props.testID ?? '').startsWith('machine-processes-menu-'),
      ),
    ).toHaveLength(0);
  });

  it('lists what the guard keeps with its reason and eases the memory meter by the selected stops', async () => {
    const screen = await renderScreen(
      <ResourceProposalProcessesContextView
        kept={[
          {
            ref: 'session:30:1:',
            processRef: 'MzA6MTo',
            kind: 'session',
            label: 'Upgrade Next to 16',
            reason: 'working',
            footprintBytes: 1.6 * GB,
          },
          { ref: 'session:31:1:', processRef: 'MzE6MTo', kind: 'session', label: null,
            reason: 'unsent_draft', footprintBytes: null },
        ]}
        usedBytes={3.8 * GB}
        totalBytes={4 * GB}
        selectedBytes={1.6 * GB}
      />,
    );
    const text = screen.getTextContent();
    expect(
      screen.findByTestId('resource-proposal-kept-session:30:1:'),
    ).toBeTruthy();
    expect(text).toContain('Upgrade Next to 16');
    expect(text).toContain(t('session.untitled'));
    expect(text).toContain('working');
    // The ghost: what is left once the selected stops give their memory back.
    const meters = screen.findAll(
      (node) => typeof node.props.projected === 'number',
    );
    expect(meters.length).toBeGreaterThan(0);
    expect(meters[0]!.props.projected).toBeCloseTo(2.2 * GB);
    expect(meters[0]!.props.value).toBeCloseTo(3.8 * GB);
  });

  it.each(['machines.storage.trash.move', 'machines.storage.deleteNow'] as const)('frames %s still being written as storage, with reserved rows and no approval', async (actionId) => {
    const screen = await renderScreen(
      <MachineResourcesToolBody
        call={{
          kind: 'proposing',
          actionId,
          proposal: null,
        }}
      />,
    );
    expect(
      screen.findByTestId('machine-resources-tool-analysing'),
    ).toBeTruthy();
    expect(screen.findByTestId('approval-prompt-approve')).toBeNull();
    expect(screen.getTextContent()).toContain(t('resourceProposal.title.storage'));
  });
});
