import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { t } from '@/text';

import { WorkflowTriggerSection } from './WorkflowTriggerSection';
import { createWorkflowTriggerIncompleteSeed } from './workflowTriggerStarts';

afterEach(standardCleanup);

const nativeEvent = {
  key: 'presence',
  kind: 'machine',
  machineId: 'event-machine',
  event: 'online',
  sourceRevision: 1,
  occurredAt: 10,
  coverage: 'live',
} as const;

describe('a seeded Machine event whose trigger catalog has not resolved (WF-ACCEPT-1119 fix 5, 1119B fix 5)', () => {
  it.each(['sentence', 'card'] as const)(
    'names the seeded event in the When, never the catalog state; the reason reads once under the clause (%s)',
    async (presentation) => {
      const incomplete = createWorkflowTriggerIncompleteSeed({ nativeEvent })!;
      const screen = await renderScreen(
        <WorkflowTriggerSection
          testIDPrefix="b"
          set={null}
          {...(presentation === 'sentence' ? { presentation } : {})}
          draft={{ adds: [], updates: {}, removes: [] }}
          onChangeDraft={vi.fn()}
          status="ready"
          onRetry={vi.fn()}
          stepsUnsaved
          whereTarget={{ machineId: nativeEvent.machineId, directory: '~' }}
          whereSummary={null}
          inputs={[]}
          incomplete={{ state: incomplete, onChange: vi.fn() }}
        />,
      );
      const clientId = incomplete.pending[0]!.clientId;
      const title =
        presentation === 'sentence'
          ? screen.findAll((node) => node.props.testID === `b-sentence-trigger:new:${clientId}-start` && typeof node.props.label === 'string')[0]?.props.label
          : screen.findByTestId(`b-trigger:new:${clientId}-title`)?.props.children;
      // The When names what was seeded, as the event feed names it.
      expect(String(title).toLowerCase()).toBe(t('workflows.events.machineOnline', { machine: t('workflows.events.someMachine') }).toLowerCase());
      // The Machine has no listed name in this harness; the reason names it as the catalog owner does.
      const machine = t('machine.unnamedMachine');
      const reasons = [
        t('workflows.triggers.card.pluginTriggersLoading', { machine }),
        t('workflows.triggers.card.pluginTriggersUnavailable', { machine }),
        t('workflows.triggers.card.noPluginTriggersOn', { machine }),
      ];
      if (presentation === 'sentence') {
        expect(screen.findByTestId('b-triggers-pending-reason')).not.toBeNull();
        const text = screen.getTextContent();
        const shown = reasons.filter((reason) => text.includes(reason));
        expect(shown).toHaveLength(1);
        expect(text.split(shown[0]!).length - 1).toBe(1);
      }
    },
  );
});

it('keeps an unresolved event starter distinct from a scheduled workflow', async () => {
  const incomplete = createWorkflowTriggerIncompleteSeed({ eventSeed: {
    eventRef: { pluginId: 'happier.scm.forge.github', localId: 'automation/pull-request-checks-failed-v1' },
    setupInput: {},
  } })!;
  const screen = await renderScreen(
    <WorkflowTriggerSection
      testIDPrefix="example"
      set={null}
      draft={{ adds: [], updates: {}, removes: [] }}
      onChangeDraft={vi.fn()}
      status="ready"
      onRetry={vi.fn()}
      stepsUnsaved
      whereTarget={null}
      whereSummary={null}
      inputs={[]}
      incomplete={{ state: incomplete, onChange: vi.fn() }}
    />,
  );
  const clientId = incomplete.pending[0]!.clientId;
  expect(screen.findAllByTestId(`example-trigger:new:${clientId}-starts.trigger`).map(node => node.props.accessibilityLabel))
    .toContain(`${t('workflows.triggers.card.when')}: ${t('automations.form.trigger.chooseEvent')}`);
});
