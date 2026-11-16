import { describe, expect, it, vi } from 'vitest';
import {
  createActionExecutor,
  type ActionExecutorDeps,
} from './actionExecutor.js';
import { ActionIdSchema } from './actionIds.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { API_TOKEN_FULL_GRANT_V1 } from '../auth/apiTokenGrant.js';

describe('session.approval_reviewer.set authority', () => {
  it.each([true, false, null])(
    'runs reviewer choice %s for a person and, once Ask is waived, for a host agent; never for a token',
    async (enabled) => {
      const write = vi.fn(async () => ({ updated: true }));
      // Host metadata persistence is the external boundary; Action admission and policy are real.
      const executor = createActionExecutor({
        sessionApprovalReviewerSet: write,
        // The host wires the canonical policy owner against the caller's persisted Settings.
        readActionsSettings: context => context.actionsSettings ?? ActionsSettingsV1Schema.parse({ v: 1 }),
      } as Partial<ActionExecutorDeps> as ActionExecutorDeps);
      const id = ActionIdSchema.parse('session.approval_reviewer.set');
      const input = { sessionId: 'session', enabled };
      const agent = {
        surface: 'agent',
        authority: 'account_automation',
        actionCaller: { kind: 'host' },
        defaultSessionId: 'session',
      } as const;
      // Agents keep a default Ask; the user can change it.
      await expect(
        executor.execute(id, input, {
          ...agent,
          actionsSettings: ActionsSettingsV1Schema.parse({ v: 1 }),
        }),
      ).resolves.not.toMatchObject({ ok: true, result: { updated: true } });
      expect(write).not.toHaveBeenCalled();
      const waived = ActionsSettingsV1Schema.parse({
        v: 1,
        approvalWaivedSurfaces: { [id]: ['agent'] },
      });
      const waivedResult = await executor.execute(id, input, { ...agent, actionsSettings: waived });
      expect(waivedResult, JSON.stringify(waivedResult)).toMatchObject({ ok: true, result: { updated: true } });
      expect(write).toHaveBeenCalledOnce();
      // Scoped credentials are never a person, even with a full grant and a waiver.
      await expect(
        executor.execute(id, input, {
          surface: 'api',
          authority: 'account_automation',
          actionsSettings: waived,
          externalActionCredential: {
            accountId: 'account',
            principalId: 'token',
            credentialId: 'token',
            grant: API_TOKEN_FULL_GRANT_V1,
          },
        }),
      ).resolves.toMatchObject({
        ok: false,
        errorCode: 'present_user_required',
      });
      await expect(
        executor.execute(id, input, {
          surface: 'ui',
          authority: 'present_user',
        }),
      ).resolves.toMatchObject({ ok: true });
      expect(write).toHaveBeenCalledTimes(2);
      expect(write).toHaveBeenLastCalledWith(expect.objectContaining(input));
    },
  );
});
