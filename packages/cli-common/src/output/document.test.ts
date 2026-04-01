import chalk from 'chalk';
import { describe, expect, it } from 'vitest';

import { createTerminalPresentation } from './presentation.js';
import { createOutputBuilder, renderOutputItems, type OutputItem } from './document.js';

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-9;]*m/g, '');
}

describe('renderOutputItems', () => {
  it('renders sections, bullets, definition lists, and blank lines with stable structure', () => {
    const noColorChalk = Object.create(chalk) as typeof chalk;
    noColorChalk.level = 0;
    const presentation = createTerminalPresentation(noColorChalk);

    const items: OutputItem[] = [
      { kind: 'line', text: presentation.ok('Ready') },
      { kind: 'blank' },
      {
        kind: 'section',
        title: 'Details',
        body: [
          {
            kind: 'definitionList',
            rows: [
              { label: 'Relay', value: 'https://relay.example.test' },
              { label: 'Machine ID', value: 'machine-123' },
            ],
            options: { indent: '  ' },
          },
          { kind: 'blank' },
          { kind: 'bullets', items: ['One', null, 'Two'] },
        ],
      },
    ];

    const rendered = renderOutputItems(items, { presentation });
    expect(stripAnsi(rendered)).toBe(
      [
        '✓ Ready',
        '',
        'Details',
        '  Relay:      https://relay.example.test',
        '  Machine ID: machine-123',
        '',
        '- One',
        '- Two',
      ].join('\n'),
    );
  });

  it('renders numbered lists with stable numbering and ignores null entries', () => {
    const items: OutputItem[] = [
      { kind: 'numbered', items: ['First', null, 'Second'] },
    ];

    const rendered = renderOutputItems(items);
    expect(stripAnsi(rendered)).toBe(
      [
        '1. First',
        '2. Second',
      ].join('\n'),
    );
  });

  it('renders checklist items using the presentation formatter', () => {
    const noColorChalk = Object.create(chalk) as typeof chalk;
    noColorChalk.level = 0;
    const presentation = createTerminalPresentation(noColorChalk);

    const items: OutputItem[] = [
      {
        kind: 'checklist',
        items: [
          { state: 'success', label: 'Install CLI' },
          { state: 'pending', label: 'Connect to relay' },
          { state: 'warning', label: 'Install Tailscale', details: ['Optional for local-only setups'] },
        ],
      },
    ];

    const rendered = renderOutputItems(items, { presentation });
    expect(stripAnsi(rendered)).toBe(
      [
        '- [✓] Install CLI',
        '- [..] Connect to relay',
        '- [!] Install Tailscale',
        '  Optional for local-only setups',
      ].join('\n'),
    );
  });
});

describe('createOutputBuilder', () => {
  it('builds and renders an output document with sections', () => {
    const noColorChalk = Object.create(chalk) as typeof chalk;
    noColorChalk.level = 0;
    const presentation = createTerminalPresentation(noColorChalk);

    const out = createOutputBuilder({ presentation });
    out.line(presentation.banner('setup', { subtitle: 'Guided setup' }));
    out.blank();
    out.section('Plan', (section) => {
      section.bullets(['Install CLI', 'Authenticate']);
    });

    expect(stripAnsi(out.render())).toBe(
      [
        'setup',
        'Guided setup',
        '',
        'Plan',
        '- Install CLI',
        '- Authenticate',
      ].join('\n'),
    );
  });
});
