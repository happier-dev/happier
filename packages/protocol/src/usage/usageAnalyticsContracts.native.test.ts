import { expect, it } from 'vitest';
import { UsageEventIngestRequestSchema } from './usageAnalyticsContracts.js';

it('admits an opaque native subject while rejecting Session ambiguity and private metadata', () => {
  const input = {
    subject: { kind: 'native', machineId: 'machine-1', agent: { pluginId: 'happier.agent.codex', localId: 'codex' }, sourceRootKey: 'opaque-root', nativeSessionKey: ' native/session+1= ' },
    externalKey: 'opaque-inference', observedAt: 10, agentId: 'codex', source: 'codex-native', scope: 'turn_delta', isCumulative: false,
    tokens: { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1 }, cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' },
  };
  expect(UsageEventIngestRequestSchema.parse(input)).toEqual(input);
  expect(UsageEventIngestRequestSchema.safeParse({ ...input, sessionId: 'session-1' }).success).toBe(false);
  expect(UsageEventIngestRequestSchema.safeParse({ ...input, metadata: { path: '/private/project' } }).success).toBe(false);
  expect(UsageEventIngestRequestSchema.safeParse({ ...input, subject: { ...input.subject, accountId: 'forged' } }).success).toBe(false);
  expect(UsageEventIngestRequestSchema.safeParse({ ...input, externalKey: undefined }).success).toBe(false);
  const accounting = { status: 'partial', historyComplete: false, asOfMs: 10, counterEpoch: 'opaque-epoch', inputIncludesCache: true, outputIncludesReasoning: true };
  expect(UsageEventIngestRequestSchema.parse({ ...input, accounting }).accounting).toEqual(accounting);
  expect(UsageEventIngestRequestSchema.safeParse({ ...input, accounting: { ...accounting, path: '/private/project' } }).success).toBe(false);
});
