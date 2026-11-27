import { describe, expect, it } from 'vitest';
import { describeApprovalActionFields } from '../actionApprovalPresentation.js';
import { buildApprovalPreviewSummary } from '../actionExecutor.js';
import { getActionSpec } from '../actionSpecs.js';

const open = {
  serverId: 'home-1', machineId: 'machine-1', terminalKey: 'workspace:pane:4f8c1e2a-77b0-4c1d-9d0e-1c2f3a4b5c6d',
  cwd: '/home/dev/projects/hello-world', sessionId: 'session-1', cols: 100, rows: 24,
};

describe('machine terminal approval presentation', () => {
  it('describes what will happen in plain words, without Action internals or raw keys', () => {
    const summary = buildApprovalPreviewSummary(getActionSpec('machines.terminal.open'), open);
    expect(summary).toContain('hello-world');
    expect(summary).not.toMatch(/PTY|custody|requester-owned|canonical|workspace:pane/i);
    expect(buildApprovalPreviewSummary(getActionSpec('machines.terminal.close'), { serverId: 'home-1', machineId: 'machine-1', terminalId: 't-1' }))
      .toMatch(/close/i);
  });

  it('names the folder by the readable path the presenting app supplies, and by its last folder name otherwise', () => {
    const toHome = (path: string) => path.replace(/^\/home\/dev(?=\/)/u, '~');
    for (const id of ['machines.terminal.open', 'machines.terminal.restart'] as const) {
      expect(buildApprovalPreviewSummary(getActionSpec(id), open, { formatPath: toHome })).toContain('“~/projects/hello-world”');
      expect(buildApprovalPreviewSummary(getActionSpec(id), open)).toContain('“hello-world”');
    }
  });

  it('names the package script a terminal open or restart will run', () => {
    const script = { ...open, launch: { kind: 'package_script', runTargetId: 'hello-world:dev' } };
    expect(buildApprovalPreviewSummary(getActionSpec('machines.terminal.open'), script))
      .toBe('Open a terminal in “hello-world” and run the package script “hello-world:dev”.');
    expect(buildApprovalPreviewSummary(getActionSpec('machines.terminal.restart'), script))
      .toContain('and run the package script “hello-world:dev”');
    expect(buildApprovalPreviewSummary(getActionSpec('machines.terminal.open'), open)).toBe('Open a terminal in “hello-world”.');
  });

  it('keeps the raw Terminal key out of Details and names the Machine', () => {
    const { rows } = describeApprovalActionFields({ actionId: 'machines.terminal.open', actionArgs: open });
    const key = rows.find((row) => row.path === 'terminalKey');
    expect(key).toMatchObject({ kind: 'value', technical: true });
    // The PTY size is a client detail, not something the person is deciding.
    for (const path of ['cols', 'rows']) expect(rows.find((row) => row.path === path)).toMatchObject({ kind: 'value', technical: true });
    expect(rows.find((row) => row.path === 'machineId')).toMatchObject({ kind: 'value', reference: { kind: 'machine', id: 'machine-1' } });
  });

  it('says what closing a session terminal will do instead of repeating the Action title', () => {
    for (const id of ['session.terminals.close', 'session.terminals.close_tab', 'session.terminals.close_others'] as const) {
      const spec = getActionSpec(id);
      const summary = buildApprovalPreviewSummary(spec, { scopeId: 'home:session', terminalId: 't-1', tabId: 'tab-1' });
      expect(summary.toLowerCase()).not.toBe(`${spec.title.toLowerCase()}.`);
      expect(summary).toMatch(/Anything running/);
    }
  });
});
