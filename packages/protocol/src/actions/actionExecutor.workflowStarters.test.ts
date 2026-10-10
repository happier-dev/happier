import { describe, expect, it } from 'vitest';

import { createActionExecutor } from './actionExecutor.js';
import { getWorkflowStarterExamplesV1 } from '../workflows/builtins/examples.js';

const listActionId = 'workflow.starters.list';
const resolveActionId = 'workflow.starters.resolve';

describe('workflow authoring starters through Actions', () => {
  it('lists the unsaved catalog and resolves a schedule only with an explicit Session and timezone', async () => {
    const executor = createActionExecutor({});
    const context = { surface: 'mcp' as const };
    const catalog = getWorkflowStarterExamplesV1();
    const before = structuredClone(catalog);
    expect(await executor.execute(listActionId, {}, context)).toEqual({ ok: true, result: { examples: catalog } });
    expect(await executor.execute(resolveActionId, { key: 'daily-summary-in-session' }, context))
      .toEqual({ ok: true, result: { status: 'requires_session' } });
    const session = { sessionId: 'chosen-session', machineId: 'chosen-machine' };
    const resolved = await executor.execute(resolveActionId, { key: 'daily-summary-in-session', session, timezone: 'Europe/Zurich' }, context);
    expect(resolved).toMatchObject({ ok: true, result: { status: 'ready', example: {
      sessionTarget: session,
      trigger: { kind: 'schedule', schedule: { timezone: 'Europe/Zurich' } },
      definition: { defaults: { conversation: { kind: 'existing_session', ...session } },
        blocks: [{ execution: { conversation: { kind: 'existing_session', ...session } } }] },
    } } });
    expect(catalog).toEqual(before);
  });

  it('keeps ordinary starters usable without a Session and binds lifecycle seeds to the selected Session', async () => {
    const executor = createActionExecutor({});
    const context = { surface: 'cli' as const };
    const example = getWorkflowStarterExamplesV1().find(entry => entry.key === 'ask-once');
    expect(await executor.execute(resolveActionId, { key: 'ask-once' }, context))
      .toEqual({ ok: true, result: { status: 'ready', example } });
    const session = { sessionId: 'selected', machineId: 'machine' };
    expect(await executor.execute(resolveActionId, { key: 'notify-when-agent-waits', session }, context))
      .toMatchObject({ ok: true, result: { status: 'ready', example: {
        sessionTarget: session, trigger: { kind: 'sessionLifecycle', sourceSessionId: 'selected', events: ['userActionRequired'] },
      } } });
    expect(await executor.execute(resolveActionId, { key: 'daily-summary-in-session', session, timezone: null }, context))
      .toMatchObject({ ok: true, result: { status: 'ready', example: { trigger: { schedule: { timezone: null } } } } });
  });

  it('rejects unsupported keys and unknown target fields without inventing a runtime workflow reference', async () => {
    const executor = createActionExecutor({});
    const context = { surface: 'agent' as const };
    expect(await executor.execute(resolveActionId, { key: 'missing' }, context)).toMatchObject({ ok: false });
    expect(await executor.execute(resolveActionId, {
      key: 'ask-once', session: { sessionId: 'selected', machineId: 'machine', originSessionId: 'guessed' },
    }, context)).toMatchObject({ ok: false });
  });
});
