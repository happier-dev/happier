import { afterEach, describe, expect, it } from 'vitest';
import { AccountSettingsSchema, encryptSecretStringV1 } from '@happier-dev/protocol';
import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createConfidentialSecretFillExecutor, type ConfidentialSecretFillTarget } from './confidentialSecretFill';

const request = { serverId: 'home', machineId: 'machine', sessionId: 'session', purpose: 'Sign in',
  browserSessionId: 'browser', viewId: 'view', tabId: 'tab', frameId: 'frame', documentId: 'document',
  navigationGeneration: 1, origin: 'https://example.com', field: { fieldId: '17', focusId: '17', locator: '#password' } } as const;
const secret = 'D26-CONSUMER-RECOGNIZABLE';
function snapshot(version: number, value: string = secret) {
  return { source: 'network' as const, scopeKey: 'scope', loadedAtMs: 1, settingsVersion: version,
    settingsSecretsReadKeys: [], settings: AccountSettingsSchema.parse({ secrets: [
      { id: 'personal', name: 'Password', kind: 'password', createdAt: 1, updatedAt: version,
        encryptedValue: { _isSecretValue: true, value } },
    ] }) };
}
function harness() {
  let mode: 'plain' | 'e2ee' = 'plain';
  let current = true;
  let held = false;
  const deliveries: Uint8Array[] = [];
  const effects: string[] = [];
  const target: ConfidentialSecretFillTarget = {
    nativeObservation: 'not_observable',
    recheck: async () => current,
    fill: async (bytes, _signal, beforeDelivery) => { expect(held).toBe(true);
      if (beforeDelivery && !await beforeDelivery()) return { status: 'refused', code: 'approval_changed' };
      deliveries.push(bytes); effects.push(Buffer.from(bytes).toString()); return { status: 'filled', code: 'filled' }; },
    finish: async () => { effects.push('cleanup'); },
  };
  // Mode is read from the authenticated Home; target preparation/fill is the physical OS/CDP boundary.
  const execute = createConfidentialSecretFillExecutor({ expectedScopeKey: 'scope', expectedAccountId: 'owner', serverId: 'home', machineId: 'machine',
    readAccountMode: async () => mode, prepareTarget: async () => { held = true; return target; } });
  const args: Parameters<NonNullable<ActionExecutorDeps['confidentialSecretFill']>>[0] = {
    actionId: 'browser.automation.secret.fill', request, choice: { kind: 'once', value: secret }, submit: false,
    accountEncryptionMode: 'plain', context: { authority: 'present_user', runtimeAccountId: 'owner' }, isCurrent: async () => current,
  };
  return { execute, args, deliveries, effects, target, markHeld: () => { held = true; }, setMode: (value: typeof mode) => { mode = value; }, setCurrent: (value: boolean) => { current = value; } };
}

afterEach(resetActiveAccountSettingsSnapshotForTests);
describe('trusted confidential material delivery', () => {
  it('reads current Account mode rather than trusting private payload and zeros physical bytes', async () => {
    setActiveAccountSettingsSnapshot(snapshot(1));
    const h = harness();
    h.setMode('e2ee');
    expect(await h.execute(h.args)).toEqual({ status: 'refused', code: 'saved_secret_mode_incompatible' });
    expect(h.effects).toEqual([]);
    h.setMode('plain');
    expect(await h.execute(h.args)).toEqual({ status: 'filled', code: 'filled' });
    expect(h.effects).toEqual([secret, 'cleanup']);
    expect([...h.deliveries[0]!]).toEqual(new Array(Buffer.byteLength(secret)).fill(0));
  });

  it('refuses a rotated saved reference and checks current target before materialization/delivery', async () => {
    const initial = snapshot(1);
    setActiveAccountSettingsSnapshot(initial);
    const h = harness();
    const args = { ...h.args, choice: { kind: 'saved' as const, ref: 'personal', fingerprint: 'personal:personal:1', revision: null } };
    setActiveAccountSettingsSnapshot(snapshot(2, 'ROTATED'));
    expect(await h.execute(args)).toEqual({ status: 'refused', code: 'saved_secret_changed' });
    expect(h.effects).toEqual(['cleanup']);
    h.setCurrent(false);
    expect(await h.execute(h.args)).toEqual({ status: 'refused', code: 'approval_changed' });
    expect(h.deliveries).toHaveLength(0);
  });

  it.each(['plain', 'e2ee'] as const)('consumes the reviewed UI catalog choice in %s mode and rejects a rotated choice', async mode => {
    const key = new Uint8Array(32).fill(7);
    const initial = snapshot(1);
    const settings = AccountSettingsSchema.parse({ secrets: [{ id: 'personal', name: 'Password', kind: 'password',
      createdAt: 1, updatedAt: 1, encryptedValue: mode === 'plain'
        ? { _isSecretValue: true, value: secret }
        : { _isSecretValue: true, encryptedValue: encryptSecretStringV1(secret, key, length => new Uint8Array(length).fill(3)) },
    }] });
    setActiveAccountSettingsSnapshot({ ...initial, settings, settingsSecretsReadKeys: mode === 'e2ee' ? [key] : [] });
    const h = harness();
    h.setMode(mode);
    // The picker projects a value-free catalog revision, not the daemon's private material digest.
    const args = { ...h.args, accountEncryptionMode: mode,
      choice: { kind: 'saved' as const, ref: 'personal', fingerprint: 'personal:personal:1', revision: null } };
    expect(await h.execute(args)).toEqual({ status: 'filled', code: 'filled' });
    expect(h.effects).toEqual([secret, 'cleanup']);
    setActiveAccountSettingsSnapshot({ ...initial, settingsVersion: 2, settings: AccountSettingsSchema.parse({ secrets: [
      { ...settings.secrets[0]!, updatedAt: 2 },
    ] }), settingsSecretsReadKeys: mode === 'e2ee' ? [key] : [] });
    expect(await h.execute(args)).toEqual({ status: 'refused', code: 'saved_secret_changed' });
    expect(h.deliveries).toHaveLength(1);
  });

  it('never resolves another deciding human\'s saved choice from the Machine custodian catalog', async () => {
    setActiveAccountSettingsSnapshot(snapshot(1));
    const h = harness();
    for (const runtimeAccountId of ['foreign-human', undefined]) {
      expect(await h.execute({ ...h.args, context: { authority: 'present_user', runtimeAccountId },
        choice: { kind: 'saved', ref: 'personal', fingerprint: 'personal:personal:1', revision: null } }))
        .toEqual({ status: 'refused', code: 'saved_secret_forbidden' });
    }
    expect(h.deliveries).toHaveLength(0);
    expect(h.effects).toEqual([]);
    // One-time human material does not borrow the custodian's Saved Secret reference.
    expect(await h.execute({ ...h.args, context: { authority: 'present_user', runtimeAccountId: 'foreign-human' } }))
      .toEqual({ status: 'filled', code: 'filled' });
  });

  it('rechecks private material when its catalog revision is unchanged during final delivery preparation', async () => {
    setActiveAccountSettingsSnapshot(snapshot(1));
    const h = harness();
    const attempted: Uint8Array[] = [];
    const execute = createConfidentialSecretFillExecutor({ expectedScopeKey: 'scope', expectedAccountId: 'owner',
      serverId: 'home', machineId: 'machine', readAccountMode: async () => 'plain',
      prepareTarget: async () => {
        h.markHeld();
        return { ...h.target, fill: async (bytes, signal, beforeDelivery) => {
          attempted.push(bytes);
          // The physical target awaits its final identity/focus proof while the
          // current material publication changes without a metadata revision.
          setActiveAccountSettingsSnapshot({ ...snapshot(1, 'ROTATED-WITH-SAME-STAMP'), settingsVersion: 2 });
          return h.target.fill(bytes, signal, beforeDelivery);
        } };
      } });
    expect(await execute({ ...h.args,
      choice: { kind: 'saved', ref: 'personal', fingerprint: 'personal:personal:1', revision: null } }))
      .toEqual({ status: 'refused', code: 'approval_changed' });
    expect(h.deliveries).toHaveLength(0);
    expect(h.effects).toEqual(['cleanup']);
    expect([...attempted[0]!]).toEqual(new Array(Buffer.byteLength(secret)).fill(0));
  });

  it('retains known fill while a separately reviewed submit has uncertain settlement', async () => {
    setActiveAccountSettingsSnapshot(snapshot(1));
    const h = harness();
    const execute = createConfidentialSecretFillExecutor({ expectedScopeKey: 'scope', expectedAccountId: 'owner', serverId: 'home', machineId: 'machine',
      readAccountMode: async () => 'plain', prepareTarget: async () => { h.markHeld(); return { ...h.target,
        submit: async () => { throw new Error(secret); },
      }; } });
    expect(await execute({ ...h.args, request: { ...request, submit: { controlId: 'button', locator: '#submit', label: 'Sign in', consequence: 'Sign in' } }, submit: true }))
      .toEqual({ status: 'filled', code: 'filled', submit: { status: 'unknown', code: 'submit_unknown' } });
  });

  it('binds a portable Home alias to fresh host identity without rewriting the reviewed request', async () => {
    setActiveAccountSettingsSnapshot(snapshot(1));
    const h = harness();
    const execute = createConfidentialSecretFillExecutor({ expectedScopeKey: 'scope', expectedAccountId: 'owner', serverId: 'local-home', machineId: 'machine',
      readHostIdentity: async () => ({ serverIdentityId: 'verified-home', machineId: 'machine' }),
      readAccountMode: async () => 'plain', prepareTarget: async (input) => {
        expect(input.request.serverId).toBe('home'); h.markHeld(); return h.target;
      } });
    expect(await execute({ ...h.args, context: { authority: 'present_user', serverIdentityId: 'verified-home' } }))
      .toEqual({ status: 'filled', code: 'filled' });
    expect(await execute({ ...h.args, context: { authority: 'present_user', serverIdentityId: 'different-home' } }))
      .toEqual({ status: 'refused', code: 'target_changed' });
  });

  it('refuses an unqualified browser producer before material delivery while allowing the qualified producer', async () => {
    setActiveAccountSettingsSnapshot(snapshot(1));
    const h = harness();
    const execute = createConfidentialSecretFillExecutor({ expectedScopeKey: 'scope', expectedAccountId: 'owner', serverId: 'home', machineId: 'machine',
      readAccountMode: async () => 'plain', prepareTarget: async () => {
        h.markHeld();
        const { nativeObservation: _qualification, ...unknownProducer } = h.target;
        return unknownProducer;
      } });
    expect(await execute(h.args)).toEqual({ status: 'refused', code: 'observation_unavailable' });
    expect(h.deliveries).toHaveLength(0);
    expect(await h.execute(h.args)).toEqual({ status: 'filled', code: 'filled' });
  });
});
