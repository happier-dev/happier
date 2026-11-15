import { describe, expect, it } from 'vitest';
import {
  createActionExecutor,
  type ActionExecutorDeps,
} from './actionExecutor.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';

// Hosts supply facts (their settings, who owns the Ask, an installed declaration's operation);
// the shared approval router decides. The answering Settings host is the process boundary.
function createSettingsExecutor(facts: Partial<ActionExecutorDeps>) {
  const writes: unknown[] = [];
  const executor = createActionExecutor({
    settingsDeclarationAction: async ({
      input,
    }: Parameters<
      NonNullable<ActionExecutorDeps['settingsDeclarationAction']>
    >[0]) => {
      writes.push(input);
      const anchor = (input as { anchor: string }).anchor;
      return 'value' in (input as object)
        ? { anchor, value: (input as { value: unknown }).value }
        : { anchor, status: 'completed' };
    },
    ...facts,
  } as unknown as ActionExecutorDeps);
  return { executor, writes };
}

const setInput = { anchor: 'transcript.showToolCalls', value: false };

describe('host approval facts reach the shared router', () => {
  it('routes with the host settings read when the invocation carries no settings', async () => {
    const waived = ActionsSettingsV1Schema.parse({
      v: 1,
      approvalWaivedSurfaces: { 'settings.set': ['agent'] },
    });
    const { executor, writes } = createSettingsExecutor({
      readActionsSettings: () => waived,
    });
    expect(
      await executor.execute('settings.set', setInput, { surface: 'agent' }),
    ).toEqual({ ok: true, result: setInput });
    expect(writes).toEqual([setInput]);
  });

  it('creates no local approval when the receiving signed root owns the Ask', async () => {
    const { executor, writes } = createSettingsExecutor({
      readApprovalOwner: () => 'receiver',
    });
    expect(
      await executor.execute('settings.set', setInput, { surface: 'agent' }),
    ).toEqual({ ok: true, result: setInput });
    expect(writes).toEqual([setInput]);
    const local = createSettingsExecutor({ readApprovalOwner: () => 'local' });
    expect(
      await local.executor.execute('settings.set', setInput, {
        surface: 'agent',
      }),
    ).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    expect(local.writes).toEqual([]);
  });

  it.each([
    { requiresApproval: false, asks: false },
    { requiresApproval: true, asks: true },
  ])(
    'resolves an installed declaration operation like the built-ins (requiresApproval $requiresApproval)',
    async ({ requiresApproval, asks }) => {
      const input = { anchor: 'acme.sync/syncNow' };
      const { executor, writes } = createSettingsExecutor({
        readSettingsDeclarationOperation: (anchor) =>
          anchor === input.anchor
            ? { kind: 'invoke', requiresApproval }
            : undefined,
      });
      const result = await executor.execute('settings.invoke', input, {
        surface: 'agent',
      });
      expect(result).toMatchObject(
        asks
          ? { ok: false, errorCode: 'approvals_not_supported' }
          : { ok: true },
      );
      expect(writes).toHaveLength(asks ? 0 : 1);
    },
  );
});
