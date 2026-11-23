import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { t } from '@/text';

import { WorkflowTriggerBlock } from './WorkflowTriggerBlock';

afterEach(standardCleanup);

const when = {
  kind: 'action',
  phase: 'before',
  actionIds: ['deployments.environment.deploy'],
  mode: 'wait',
  subject: {
    kind: 'environment',
    serverId: 'server-identity',
    environmentId: 'env-production',
  },
} as const;

function block(viewOnlySubject: boolean) {
  return (
    <WorkflowTriggerBlock
      testID="t"
      title="Before Deploy"
      when={when}
      enabled
      incomplete={false}
      startOptions={[]}
      onSelectStart={vi.fn()}
      onChangeWhen={vi.fn()}
      onRemove={vi.fn()}
      machineId={null}
      serverId={null}
      {...(viewOnlySubject ? { viewOnlySubject } : {})}
    />
  );
}

// Plan 05 R22 (QA-UI-R 13:06Z): an author who can only view the subject is told, under it, that the trigger runs on
// their own Actions only; an author whose trigger reaches others keeps the plain field.
it('says a view-only author reaches only their own Actions, under the subject', async () => {
  const viewOnly = await renderScreen(block(true));
  expect(viewOnly.findByTestId('t-subject-reach')).not.toBeNull();
  // The subject's name arrives from its read; until then the note says "it".
  expect(viewOnly.getTextContent()).toContain(t('workflows.triggers.card.viewOnlyReachUnnamed'));
  await viewOnly.unmount();
  const manager = await renderScreen(block(false));
  expect(manager.findByTestId('t-subject-reach')).toBeNull();
  await manager.unmount();
});
