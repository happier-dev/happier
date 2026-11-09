import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createPersonalFollowOccurrenceDispatcher } from './dispatchPersonalFollowOccurrence';
import { notificationCatalogFixture, notificationSettingsFixture } from './activityNotification.testkit';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindProcessLogger, Logger } from '@/ui/logger';

describe('source personal Follow dispatch', () => {
  it.each(['completed', 'failed'] as const)('delivers a no-native %s Turn once through personal acceptance', async status => {
    const home = 'https://personal-turn-owner.test';
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.fixture`, encryption: null };
    const settings = notificationSettingsFixture({});
    const snapshot = { source: 'network' as const, settings, rawSettings: {}, ...notificationCatalogFixture(settings),
      settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
      scopeKey: runWithServerHttpBaseUrl(home, () => resolveAccountSettingsScopeKey(credentials)) };
    const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, snapshot,
      serverHttpBaseUrl: home, isCurrent: async () => true });
    const sent: unknown[] = [];
    let accepted = false;
    const dispatch = createPersonalFollowOccurrenceDispatcher({ operationContext, isCurrent: async () => true,
      fetchSessionNotificationContext: async () => createSessionNotificationContextFixture('source'),
      pluginNotifications: null, readAccountSessionDeliveryMutedScopes: async () => [],
      expoPushSender: { sendToAllDevicesAsync: async (...args) => {
        expect(accepted).toBe(true); sent.push(args); return true;
      } } });
    const input = { sourceSessionId: 'source', occurrence: { sourceSessionId: 'source', sourceTurn: { id: 'host-turn', status },
      evidence: { v: 1 as const, ownerAccountId: 'owner', facts: { serverId: 'home', kind: 'session' as const },
        event: { kind: status === 'completed' ? 'finished' as const : 'failed_or_stopped' as const } } },
      policies: [{ preset: 'everything' as const }], signal: new AbortController().signal,
      acceptDelivery: async () => { accepted = true; return true; } };
    const directory = await mkdtemp(join(tmpdir(), 'personal-follow-info-receipt-'));
    vi.stubEnv('HAPPIER_LOG_LEVEL', 'info');
    const receiptLogger = new Logger({ logFilePath: join(directory, 'receipt.log'),
      allowDangerousRemoteLogging: false, pruneCurrentProcessLogs: false });
    const restoreLogger = bindProcessLogger(receiptLogger);
    const readOutcomes = async () => {
      receiptLogger.flushSync();
      const marker = '[activityNotifications] Dispatch outcome';
      return (await readFile(receiptLogger.logFilePath, 'utf8')).split('\n').filter(line => line.includes(marker))
        .map(line => JSON.parse(line.slice(line.indexOf(marker) + marker.length)) as unknown);
    };
    try {
      expect(await dispatch(input)).toEqual({ attemptedChannels: 1, deliveredChannels: 1 });
      expect(await readOutcomes()).toEqual([expect.objectContaining({ sourceSessionId: 'source', sourceTurnId: 'host-turn',
        attemptedChannels: 1, deliveredChannels: 1, failedChannels: 0 })]);
      expect(await dispatch({ ...input, acceptDelivery: async () => false })).toEqual({ attemptedChannels: 0, deliveredChannels: 0 });
      // One record for each actual dispatch, not another outward effect on replay.
      expect(await readOutcomes()).toEqual([expect.objectContaining({ deliveredChannels: 1 }),
        expect.objectContaining({ sourceTurnId: 'host-turn', attemptedChannels: 0, deliveredChannels: 0, failedChannels: 0 })]);
      expect(sent).toHaveLength(1);
    } finally {
      receiptLogger.flushSync(); restoreLogger(); vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('composes Run source acceptance and channel dispatch without an Artifact dependency', async () => {
    const home = 'https://personal-run-owner.test';
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.fixture`, encryption: null };
    const settings = notificationSettingsFixture({});
    const snapshot = { source: 'network' as const, settings, rawSettings: {}, ...notificationCatalogFixture(settings),
      settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
      scopeKey: runWithServerHttpBaseUrl(home, () => resolveAccountSettingsScopeKey(credentials)) };
    const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, snapshot,
      serverHttpBaseUrl: home, isCurrent: async () => true });
    const sent: unknown[] = [];
    let accepted = false;
    const post = vi.spyOn(axios, 'post').mockRejectedValue(new Error('Unexpected Artifact write'));
    try {
      const dispatch = createPersonalFollowOccurrenceDispatcher({ operationContext, isCurrent: async () => true,
        pluginNotifications: null, readAccountSessionDeliveryMutedScopes: async () => [],
        expoPushSender: { sendToAllDevicesAsync: async (...args) => {
          expect(accepted).toBe(true);
          sent.push(args);
          return true;
        } } });
      const input = { occurrence: { original: { source: { kind: 'workflow_run' as const, runId: 'followed-run' }, revision: 2 },
        event: { kind: 'update_posted' as const } }, policies: [{ preset: 'everything' as const }],
        signal: new AbortController().signal, acceptDelivery: async () => { accepted = true; return true; } };
      expect(await dispatch(input)).toEqual({ attemptedChannels: 1, deliveredChannels: 1 });
      expect(sent).toHaveLength(1);
      expect(await dispatch({ ...input, acceptDelivery: async () => false }))
        .toEqual({ attemptedChannels: 0, deliveredChannels: 0 });
      expect(sent).toHaveLength(1);
      expect(post).not.toHaveBeenCalled();
    } finally { post.mockRestore(); }
  });

  it.each(['request', 'finished'] as const)('returns an admitted %s to its original notification owner without a second send', async kind => {
    const home = 'https://personal-owner.test';
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.fixture`, encryption: null };
    let current = true;
    const settings = accountSettingsParse({});
    const snapshot = { source: 'network' as const, settings, rawSettings: {}, ...notificationCatalogFixture(settings),
      settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
      scopeKey: runWithServerHttpBaseUrl(home, () => resolveAccountSettingsScopeKey(credentials)) };
    const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, snapshot,
      serverHttpBaseUrl: home, isCurrent: async () => current });
    const source = createSessionNotificationContextFixture('source');
    const sent: unknown[] = [];
    const dispatch = createPersonalFollowOccurrenceDispatcher({ operationContext, isCurrent: async () => current,
      fetchSessionNotificationContext: async () => source, pluginNotifications: null,
      readAccountSessionDeliveryMutedScopes: async () => [],
      expoPushSender: { sendToAllDevicesAsync: async (...args) => { sent.push(args); return true; } } });
    const policies = [{ preset: 'everything' as const }];
    const evidence = { v: 1 as const, ownerAccountId: 'owner', facts: { serverId: 'home', kind: 'session' as const },
      event: kind === 'request' ? { kind: 'needs_you' as const, type: 'approval' as const } : { kind: 'finished' as const } };
    const occurrence = kind === 'request'
      ? { sourceSessionId: source.id, sourceRequests: { agentStateVersion: 4, requests: [{ requestId: 'question', createdAt: 1 }] },
          requestEvidence: [{ requestId: 'question', evidence }] }
      : { sourceSessionId: source.id, sourceMessage: { localId: 'terminal-original', seq: 7 }, evidence };
    const input = { sourceSessionId: source.id, occurrence, policies, signal: new AbortController().signal };
    const result = await dispatch(input);
    expect(result).toEqual({ attemptedChannels: 0, deliveredChannels: 0, personalFollow: { sourceSessionId: source.id,
      ...(kind === 'request' ? { requests: [{ requestId: 'question', policies }] }
        : { sourceMessage: { localId: 'terminal-original', seq: 7, policies } }) } });
    expect(sent).toEqual([]);
    current = false;
    await expect(dispatch(input)).rejects.toThrow('personal_follow_scope_retired');
  });
});
