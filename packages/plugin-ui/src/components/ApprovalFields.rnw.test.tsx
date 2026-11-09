import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import {
  ApprovalFields,
  ApprovalPrompt,
} from '@happier-dev/plugin-ui/components';
import {
  HappierApprovalFields,
  type HappierApprovalFieldResolve,
} from '@happier-dev/plugin-ui/presentation';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import {
  createHostApiStub,
  createSurfaceContext,
} from '../surfaceFixture.testSupport.js';
import { PluginUiProvider } from './PluginUiProvider.js';

function mount(node: ReactNode) {
  const context = createSurfaceContext();
  return mountThroughReactNativeWeb(
    <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      {node}
    </PluginUiProvider>,
  );
}

const rows = [
  {
    kind: 'value',
    key: 'keep',
    label: 'Keep it',
    value: 'Stop after 1 h unused',
  },
  {
    kind: 'entries',
    key: 'wake',
    label: 'Wake',
    entries: [
      { label: 'On', value: null, depth: 0 },
      { label: 'Message', value: 'Yes', depth: 1 },
    ],
  },
  {
    kind: 'answers',
    key: 'answers',
    label: 'Answers',
    answers: [{ question: 'Which region?', values: ['Frankfurt'] }],
  },
  {
    kind: 'notice',
    key: 'secret',
    label: 'Secret',
    title: 'Can’t show this here',
    body: 'Open the request to review it.',
    testID: 'fields.notice',
  },
] as const;

describe('public ApprovalFields', () => {
  it('reads every argument kind as one table row inside an approval prompt, with exact ids folded last', () => {
    const mounted = mount(
      <ApprovalPrompt title="Change when a machine stops">
        <ApprovalFields
          testID="fields"
          rows={rows}
          technicalDetails={[
            { key: 'id', label: 'Machine id', value: 'do-bot-1' },
          ]}
        />
      </ApprovalPrompt>,
    );
    try {
      const table = mounted.container.querySelector('[data-testid="fields"]');
      // Label beside value: one row holds both, in reading order.
      expect(
        mounted.container.querySelector('[data-testid="fields.row:keep"]')
          ?.textContent,
      ).toBe('Keep itStop after 1 h unused');
      expect(
        mounted.container.querySelector('[data-testid="fields.row:wake"]')
          ?.textContent,
      ).toBe('WakeOnMessageYes');
      expect(
        mounted.container.querySelector('[data-testid="fields.row:answers"]')
          ?.textContent,
      ).toBe('AnswersWhich region?Frankfurt');
      expect(
        mounted.container.querySelector('[data-testid="fields.notice"]')
          ?.textContent,
      ).toContain('Can’t show this here');
      // The exact id stays out of the readable rows; Technical details is the table's last line.
      const technical = mounted.container.querySelector(
        '[data-testid="fields.technical-details"]',
      );
      expect(technical?.textContent).toContain('Technical details');
      expect(table?.lastElementChild?.contains(technical ?? null)).toBe(true);
      expect(
        mounted.container.querySelector('[data-testid="fields.row:keep"]')
          ?.textContent,
      ).not.toContain('do-bot-1');
    } finally {
      mounted.unmount();
    }
  });

  it('draws nothing when there is nothing to show', () => {
    const mounted = mount(<ApprovalFields testID="empty" rows={[]} />);
    try {
      expect(
        mounted.container.querySelector('[data-testid="empty"]'),
      ).toBeNull();
    } finally {
      mounted.unmount();
    }
  });

  it('stacks each label over its value in the stack anatomy', () => {
    const mounted = mount(
      <ApprovalFields testID="stack" anatomy="stack" rows={[rows[0]]} />,
    );
    try {
      const row = mounted.container.querySelector(
        '[data-testid="stack.row:keep"]',
      );
      expect(row?.textContent).toBe('Keep itStop after 1 h unused');
      expect(row?.children).toHaveLength(2);
    } finally {
      mounted.unmount();
    }
  });
});

describe('HappierApprovalFields page density', () => {
  it('lays a short facts list on the page: label beside value on the compact key column, without the card inset', () => {
    const mounted = mount(
      <HappierApprovalFields
        testID="facts"
        density="page"
        colors={{ text: 'rgb(1, 1, 1)', secondaryText: 'rgb(2, 2, 2)', mutedText: 'rgb(3, 3, 3)', danger: 'rgb(4, 4, 4)', inset: 'rgb(5, 5, 5)' }}
        rows={[{ kind: 'value', key: 'where', label: 'Where', value: 'worker-target' }]}
      />,
    );
    try {
      const table = mounted.container.querySelector('[data-testid="facts"]') as HTMLElement;
      expect(getComputedStyle(table).backgroundColor).not.toBe('rgb(5, 5, 5)');
      expect(getComputedStyle(table).paddingLeft).toBe('0px');
      const row = mounted.container.querySelector('[data-testid="facts.row:where"]') as HTMLElement;
      expect(row.textContent).toBe('Whereworker-target');
      const key = row.firstElementChild as HTMLElement;
      expect(getComputedStyle(key).width).toBe('56px');
      expect(getComputedStyle(key.firstElementChild as HTMLElement).color).toBe('rgb(3, 3, 3)');
      expect(getComputedStyle(row.lastElementChild!.firstElementChild as HTMLElement).color).toBe('rgb(2, 2, 2)');
    } finally {
      mounted.unmount();
    }
  });
});

describe('HappierApprovalFields host resolution', () => {
  it('reads a sourced value and entry through the host Resolve slot, and others as given', () => {
    const Resolve: HappierApprovalFieldResolve<string> = (props) => (
      <>
        {props.children({
          label: props.label.replace(/ id$/u, ''),
          value: `named:${props.source}`,
        })}
      </>
    );
    const mounted = mount(
      <HappierApprovalFields<string>
        testID="host"
        Resolve={Resolve}
        rows={[
          {
            kind: 'value',
            key: 'session',
            label: 'Session id',
            value: 's-1',
            source: 's-1',
          },
          { kind: 'value', key: 'plain', label: 'Mode', value: 'fast' },
          {
            kind: 'entries',
            key: 'target',
            label: 'Target',
            entries: [
              { label: 'Machine id', value: 'm-1', depth: 0, source: 'm-1' },
            ],
          },
        ]}
      />,
    );
    try {
      expect(
        mounted.container.querySelector('[data-testid="host.row:session"]')
          ?.textContent,
      ).toBe('Sessionnamed:s-1');
      expect(
        mounted.container.querySelector('[data-testid="host.row:plain"]')
          ?.textContent,
      ).toBe('Modefast');
      expect(
        mounted.container.querySelector('[data-testid="host.row:target"]')
          ?.textContent,
      ).toBe('TargetMachinenamed:m-1');
    } finally {
      mounted.unmount();
    }
  });
});
