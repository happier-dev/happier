import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema, AccountSettingsV2UpdateRequestSchema, accountSettingsParse } from '@happier-dev/protocol';
import type { AccountSettingsStoredContentEnvelope } from '@happier-dev/protocol';

import { resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { createCliActionExecutorHarness } from './createCliActionExecutorHarness';

const actionsSettings = ActionsSettingsV1Schema.parse({ v: 1, actions: { 'settings.set': { enabled: true } } });

describe('CLI declared Account settings', () => {
  let content: AccountSettingsStoredContentEnvelope;
  let version: number;
  let conflict: boolean;

  beforeEach(() => {
    resetInMemoryAccountSettingsContextForTests();
    content = { t: 'plain', v: { favoriteMachines: ['neighbor'] } };
    version = 1;
    conflict = false;
    // HTTP is the system boundary. Admission, declarations, validation, encryption-mode
    // checks, sparse mutation and the existing CAS retry owner remain real.
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content, version } };
      throw new Error(`Unexpected HTTP read: ${url}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, raw) => {
      if (!url.endsWith('/v2/account/settings')) throw new Error(`Unexpected HTTP write: ${url}`);
      const request = AccountSettingsV2UpdateRequestSchema.parse(raw);
      if (conflict) {
        conflict = false;
        version += 1;
        content = { t: 'plain', v: { favoriteMachines: ['concurrent'], futureSetting: 'preserved' } };
        return { status: 200, data: { success: false, error: 'version-mismatch', currentVersion: version, currentContent: content } };
      }
      expect(request.expectedVersion).toBe(version);
      if (!request.content) throw new Error('Expected stored settings');
      content = request.content;
      version += 1;
      return { status: 200, data: { success: true, version } };
    });
  });

  afterEach(() => { vi.restoreAllMocks(); resetInMemoryAccountSettingsContextForTests(); });

  function executor() {
    return createCliActionExecutorHarness({
      token: 'settings-parity-test', sessionId: 'settings-parity', mode: 'plain', ctx: null,
      credentials: { token: 'settings-parity-test', encryption: null },
    }).executor;
  }
  const user = { surface: 'cli', authority: 'present_user', actionsSettings,
    presentUserConfirmation: { actionId: 'settings.set' } } as const;

  it('discovers and reads both Delegation declarations without an answering client', async () => {
    const owner = executor();
    expect(await owner.execute('settings.list', { pageId: 'delegation' }, user)).toMatchObject({ ok: true, result: { items: expect.arrayContaining([
      expect.objectContaining({ anchor: 'delegation.workDepthLimit', storageScope: 'account', readable: true, writable: true }),
      expect.objectContaining({ anchor: 'delegation.approvalReviewerEnabled', storageScope: 'account', readable: true, writable: true }),
    ]) } });
    expect(await owner.execute('settings.get', { anchor: 'delegation.workDepthLimit' }, user)).toEqual({ ok: true, result: { anchor: 'delegation.workDepthLimit', value: 4 } });
    expect(await owner.execute('settings.get', { anchor: 'delegation.approvalReviewerEnabled' }, user)).toEqual({ ok: true, result: { anchor: 'delegation.approvalReviewerEnabled', value: false } });
  });

  it('writes through Account CAS, rebases conflicts, and reads back through another CLI owner', async () => {
    conflict = true;
    expect(await executor().execute('settings.set', { anchor: 'delegation.workDepthLimit', value: 8 }, user)).toEqual({ ok: true, result: { anchor: 'delegation.workDepthLimit', value: 8 } });
    expect(await executor().execute('settings.set', { anchor: 'delegation.approvalReviewerEnabled', value: true }, user)).toEqual({ ok: true, result: { anchor: 'delegation.approvalReviewerEnabled', value: true } });
    expect(await executor().execute('settings.get', { anchor: 'delegation.workDepthLimit' }, user)).toEqual({ ok: true, result: { anchor: 'delegation.workDepthLimit', value: 8 } });
    expect(await executor().execute('settings.get', { anchor: 'delegation.approvalReviewerEnabled' }, user)).toEqual({ ok: true, result: { anchor: 'delegation.approvalReviewerEnabled', value: true } });
    expect(content).toEqual({ t: 'plain', v: { favoriteMachines: ['concurrent'], futureSetting: 'preserved', workDepthLimit: 8, approvalReviewerEnabled: true } });
  });

  it('rejects invalid values without falling back to persisted defaults or writing', async () => {
    for (const value of [-1, 1.5, '4']) {
      expect(await executor().execute('settings.set', { anchor: 'delegation.workDepthLimit', value }, user)).toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
    }
    expect(await executor().execute('settings.set', { anchor: 'delegation.approvalReviewerEnabled', value: 'true' }, user)).toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
    expect(version).toBe(1);
  });

  it('refuses device-local reads with the existing no-client result', async () => {
    expect(await executor().execute('settings.get', { anchor: 'appearance.theme' }, user)).toMatchObject({ ok: false, errorCode: 'unavailable', error: 'noClient' });
    expect(version).toBe(1);
  });

  it('does not report defaults as Account values when the Account read is unavailable', async () => {
    vi.mocked(axios.get).mockRejectedValue(new Error('Account unavailable'));
    expect(await executor().execute('settings.get', { anchor: 'delegation.workDepthLimit' }, user))
      .toMatchObject({ ok: false, errorCode: 'account_settings_content_unavailable' });
  });

  it('lets agents read Account defaults but keeps approval-reviewer configuration user-only', async () => {
    const agent = { surface: 'agent', authority: 'account_automation', actionsSettings } as const;
    expect(await executor().execute('settings.get', { anchor: 'delegation.workDepthLimit' }, agent)).toMatchObject({ ok: true, result: { value: 4 } });
    expect(await executor().execute('settings.set', { anchor: 'delegation.approvalReviewerEnabled', value: true }, agent)).toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(accountSettingsParse(content.t === 'plain' ? content.v : {}).approvalReviewerEnabled).toBe(false);
  });
});
