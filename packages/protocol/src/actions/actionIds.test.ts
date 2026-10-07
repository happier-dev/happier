import { describe, expect, it } from 'vitest';

import { AccountSettingsStoredContentEnvelopeSchema } from '../account/settings/accountSettingsStoredContentEnvelope.js';

import {
  ACTION_ID_FAMILIES_V1,
  ACTION_IDS,
  ActionIdSchema,
  RuntimeActionIdV1Schema,
  isRuntimeActionIdV1,
} from './actionIds.js';

describe('ActionIdSchema', () => {
  it('publishes controller transitions through the existing browser control Action family', () => {
    for (const id of ['browser.control.takeControl', 'browser.control.handBack']) {
      expect(ActionIdSchema.safeParse(id).success).toBe(true);
      expect(RuntimeActionIdV1Schema.safeParse(id).success).toBe(true);
      expect(ACTION_ID_FAMILIES_V1.browser_control).toContain(id);
    }
  });
  it('initializes Action ids beside Account Settings stored-content schemas without an import cycle', () => {
    expect(ActionIdSchema.parse('secrets.shared.promote')).toBe('secrets.shared.promote');
    expect(AccountSettingsStoredContentEnvelopeSchema.parse({ t: 'plain', v: {} })).toEqual({
      t: 'plain',
      v: {},
    });
  });

  it('publishes the Automation conversation target selector and verifier in the canonical family', () => {
    expect(ACTION_ID_FAMILIES_V1.automation_conversation).toEqual([
      'automation.conversation.targets.list',
      'automation.conversation.target.verify',
      'automation.conversation.admit',
    ]);
  });

  it('does not recognize retired plugin call or trust actions', () => {
    expect(ActionIdSchema.safeParse('plugins.call').success).toBe(false);
    expect(ActionIdSchema.safeParse('plugins.trust').success).toBe(false);
  });

  it('accepts known action ids', () => {
    expect(ActionIdSchema.parse('review.start')).toBe('review.start');
    expect(ActionIdSchema.parse('action.invoke')).toBe('action.invoke');
    expect(ActionIdSchema.parse('ui.current_context.read')).toBe('ui.current_context.read');
    expect(ActionIdSchema.parse('ui.current_context.command.invoke')).toBe('ui.current_context.command.invoke');
    expect(ActionIdSchema.parse('subagents.delegate.start')).toBe('subagents.delegate.start');
    expect(ActionIdSchema.parse('session.open')).toBe('session.open');
    expect(ActionIdSchema.parse('execution.run.start')).toBe('execution.run.start');
    expect(ActionIdSchema.parse('execution.run.ensure')).toBe('execution.run.ensure');
    expect(ActionIdSchema.parse('execution.run.ensure_or_start')).toBe('execution.run.ensure_or_start');
    expect(ActionIdSchema.parse('execution.run.stream.start')).toBe('execution.run.stream.start');
    expect(ActionIdSchema.parse('execution.run.stream.read')).toBe('execution.run.stream.read');
    expect(ActionIdSchema.parse('execution.run.stream.cancel')).toBe('execution.run.stream.cancel');
    expect(ActionIdSchema.parse('execution.run.wait')).toBe('execution.run.wait');
    expect(ActionIdSchema.parse('session.usageLimit.waitResume.enable')).toBe('session.usageLimit.waitResume.enable');
    expect(ActionIdSchema.parse('session.usageLimit.waitResume.cancel')).toBe('session.usageLimit.waitResume.cancel');
    expect(ActionIdSchema.parse('session.usageLimit.checkNow')).toBe('session.usageLimit.checkNow');
    expect(ActionIdSchema.parse('session.usageLimit.consumeResetCredit')).toBe('session.usageLimit.consumeResetCredit');
    expect(ActionIdSchema.parse('session.terminalComposer.clear')).toBe('session.terminalComposer.clear');
    expect(ActionIdSchema.parse('prompt_asset.export')).toBe('prompt_asset.export');
    expect(ActionIdSchema.parse('prompt_registry.install')).toBe('prompt_registry.install');
    expect(ActionIdSchema.parse('daemon.promptAssets.discover')).toBe('daemon.promptAssets.discover');
    expect(ActionIdSchema.parse('bugreport.collectDiagnostics')).toBe('bugreport.collectDiagnostics');
    expect(ActionIdSchema.parse('browser.navigate')).toBe('browser.navigate');
    expect(ActionIdSchema.parse('browser.diagnostics.eval')).toBe('browser.diagnostics.eval');
    expect(ActionIdSchema.parse('browser.automation.click')).toBe('browser.automation.click');
    expect(ActionIdSchema.parse('browser.recording.start')).toBe('browser.recording.start');
    expect(ActionIdSchema.parse('localServices.preview.openOrCreate')).toBe('localServices.preview.openOrCreate');
    expect(ActionIdSchema.parse('localServices.publicPreview.create')).toBe('localServices.publicPreview.create');
    expect(ActionIdSchema.parse('peerMediation.observability.snapshot')).toBe('peerMediation.observability.snapshot');
    expect(ActionIdSchema.parse('devices.simulator.input.tap')).toBe('devices.simulator.input.tap');
  });

  /**
   * Lane 02 registration contract: the Account Security family is the one
   * typed use-case boundary for password/email/security journeys, and the
   * API-token family keeps exactly one create intent. The retired
   * `createEncrypted` id must never re-enter the family or parse again.
   */
  it('registers the Account Security family and the single API-token create intent', () => {
    expect(ACTION_ID_FAMILIES_V1.account_security).toEqual([
      'account.encryption.historicalKey.forget',
      'account.encryption.automationTemplates.recover',
      'account.security.get',
      'account.security.terminalPresentUser.set',
      'account.password.enroll',
      'account.password.change',
      'account.password.remove',
      'account.email.change.request',
    ]);
    expect(ACTION_ID_FAMILIES_V1.account_api_tokens).toEqual([
      'account.apiTokens.create',
      'account.apiTokens.list',
      'account.apiTokens.update',
      'account.apiTokens.revoke',
      'account.apiTokens.revokeAll',
    ]);
    expect(ActionIdSchema.safeParse('account.apiTokens.createEncrypted').success).toBe(false);
  });

  it('does not accept unknown action ids', () => {
    expect(() => ActionIdSchema.parse('account.apiTokens.createEncrypted')).toThrow();
    expect(() => ActionIdSchema.parse('execution.run.stream.pause' as any)).toThrow();
    expect(() => ActionIdSchema.parse('daemon.browser.recording.start' as any)).toThrow();
    expect(() => ActionIdSchema.parse('daemon.devices.simulator.preview.action' as any)).toThrow();
    expect(() => ActionIdSchema.parse('session.spawn_picker')).toThrow();
  });

  /**
   * `ACTION_ID_FAMILIES_V1` is the declaration and `ACTION_IDS` is its
   * projection, so a family that exists in one and not the other is a registry
   * defect rather than a policy choice: its rows load into the catalog while
   * `ActionIdSchema` refuses their ids, which fails far away from the omission.
   * Deriving the expectation from the declaration keeps this from having to be
   * re-listed every time a family is added.
   */
  it('projects every declared family into the canonical action id list', () => {
    const projected = new Set<string>(ACTION_IDS);
    const unprojected = Object.entries(ACTION_ID_FAMILIES_V1)
      .filter(([, ids]) => (ids as readonly string[]).some((id) => !projected.has(id)))
      .map(([family]) => family);

    expect(unprojected).toEqual([]);
  });

  it('exposes runtime-unification action ids as a canonical subset', () => {
    expect(RuntimeActionIdV1Schema.parse('browser.navigate')).toBe('browser.navigate');
    expect(RuntimeActionIdV1Schema.parse('localServices.preview.openOrCreate')).toBe('localServices.preview.openOrCreate');
    expect(RuntimeActionIdV1Schema.parse('devices.simulator.input.tap')).toBe('devices.simulator.input.tap');
    expect(() => RuntimeActionIdV1Schema.parse('session.open' as any)).toThrow();
    expect(() => RuntimeActionIdV1Schema.parse('daemon.devices.simulator.preview.action' as any)).toThrow();

    expect(isRuntimeActionIdV1('browser.automation.click')).toBe(true);
    expect(isRuntimeActionIdV1('peerMediation.observability.snapshot')).toBe(true);
    for (const actionId of ACTION_ID_FAMILIES_V1.ephemeral_runner) {
      expect(RuntimeActionIdV1Schema.safeParse(actionId).success).toBe(false);
      expect(isRuntimeActionIdV1(actionId)).toBe(false);
    }
    expect(isRuntimeActionIdV1('session.open')).toBe(false);
    expect(isRuntimeActionIdV1('daemon.browser.recording.start')).toBe(false);
  });

  it('projects exactly the declared ids without duplicates', () => {
    const declared = Object.values(ACTION_ID_FAMILIES_V1).flat();
    expect([...ACTION_IDS].sort()).toEqual([...declared].sort());
    expect(new Set(ACTION_IDS).size).toBe(ACTION_IDS.length);
  });
});
