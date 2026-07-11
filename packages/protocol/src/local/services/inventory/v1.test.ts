import { describe, expect, it } from 'vitest';

import {
  LocalServiceInventoryEntryV1Schema,
  LocalServiceInventoryLabelPatchV1Schema,
  LocalServiceInventorySnapshotV1Schema,
  LocalServiceInventoryUpdateEventV1Schema,
} from './v1.js';

describe('LocalServiceInventoryEntryV1Schema', () => {
  it('separates observed listener facts from label annotations and sanitized provenance', () => {
    const parsed = LocalServiceInventoryEntryV1Schema.parse({
      id: 'machine-a:tcp:127.0.0.1:5173:pid-123',
      machineId: 'machine-a',
      address: { kind: 'loopback', host: '127.0.0.1', family: 'ipv4' },
      port: 5173,
      protocol: 'tcp',
      detectedAt: 1_000,
      lastSeenAt: 2_000,
      state: 'listening',
      source: 'detected',
      provenance: {
        process: {
          pid: 123,
          ppid: 88,
          processStartTimeMs: 1_717_171_717_000,
          lineagePids: [123, 88, 1],
          command: 'npm run dev -- --token=[REDACTED]',
          cwd: '/repo/app',
          redacted: true,
        },
        workspace: {
          id: 'workspace-a',
          path: '/repo',
          association: 'cwd_containment',
        },
      },
      classification: {
        kind: 'vite',
        displayName: 'Vite',
        confidence: 'high',
        signals: ['command:vite'],
      },
      presentation: {
        pageTitle: 'Happier Web',
        pageTitleSource: 'html_title',
        displayName: 'Happier Web',
        folderLabel: 'app',
        addressLabel: 'localhost:5173',
      },
      labels: [{ id: 'label-a', text: 'Main preview', source: 'user', updatedAt: 2_100 }],
      confidence: 'high',
      processOwnershipConfidence: 'high',
      workspaceAssociationConfidence: 'high',
      diagnostics: [],
    });

    expect(parsed.provenance?.process?.redacted).toBe(true);
    expect(parsed.provenance?.process?.processStartTimeMs).toBe(1_717_171_717_000);
    expect(parsed.provenance?.process?.lineagePids).toEqual([123, 88, 1]);
    expect(parsed.labels[0]?.text).toBe('Main preview');
    expect(parsed.presentation?.displayName).toBe('Happier Web');
  });

  it('rejects label patches that try to create authoritative service facts', () => {
    const result = LocalServiceInventoryLabelPatchV1Schema.safeParse({
      inventoryId: 'machine-a:tcp:127.0.0.1:5173',
      label: { text: 'Preview' },
      port: 5173,
      source: 'managed',
    });

    expect(result.success).toBe(false);
  });
});

describe('LocalServiceInventorySnapshotV1Schema', () => {
  it('models stale-while-revalidate snapshots without clearing existing entries', () => {
    const snapshot = LocalServiceInventorySnapshotV1Schema.parse({
      v: 1,
      machineId: 'machine-a',
      generatedAt: 3_000,
      refreshState: 'refreshing',
      entries: [
        {
          id: 'machine-a:tcp:127.0.0.1:5173:pid-123',
          machineId: 'machine-a',
          address: { kind: 'loopback', host: '127.0.0.1', family: 'ipv4' },
          port: 5173,
          protocol: 'tcp',
          detectedAt: 1_000,
          lastSeenAt: 2_000,
          state: 'stale',
          source: 'detected',
          labels: [],
          confidence: 'medium',
          processOwnershipConfidence: 'low',
          workspaceAssociationConfidence: 'medium',
          diagnostics: [],
        },
      ],
      diagnostics: [],
    });

    expect(snapshot.refreshState).toBe('refreshing');
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0]?.state).toBe('stale');
  });

  it('allows incremental entry upsert and removal events only for observed entries', () => {
    const upsert = LocalServiceInventoryUpdateEventV1Schema.parse({
      v: 1,
      kind: 'entry_upserted',
      machineId: 'machine-a',
      generatedAt: 4_000,
      entry: {
        id: 'machine-a:tcp:127.0.0.1:5173:pid-123',
        machineId: 'machine-a',
        address: { kind: 'loopback', host: '127.0.0.1', family: 'ipv4' },
        port: 5173,
        protocol: 'tcp',
        detectedAt: 1_000,
        lastSeenAt: 4_000,
        state: 'listening',
        source: 'detected',
        labels: [],
        confidence: 'high',
        processOwnershipConfidence: 'high',
        workspaceAssociationConfidence: 'high',
        diagnostics: [],
      },
    });

    expect(upsert.kind).toBe('entry_upserted');
  });

  it('rejects stale planned source arms that have no producer', () => {
    for (const source of ['managed', 'registered', 'system']) {
      const result = LocalServiceInventoryEntryV1Schema.safeParse({
        id: `machine-a:tcp:127.0.0.1:5173:${source}`,
        machineId: 'machine-a',
        address: { kind: 'loopback', host: '127.0.0.1', family: 'ipv4' },
        port: 5173,
        protocol: 'tcp',
        detectedAt: 1_000,
        lastSeenAt: 2_000,
        state: 'listening',
        source,
        labels: [],
        confidence: 'high',
        processOwnershipConfidence: 'high',
        workspaceAssociationConfidence: 'high',
        diagnostics: [],
      });

      expect(result.success).toBe(false);
    }
  });
});
