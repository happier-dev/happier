import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateTerminalCleanupSourceTree, validateTerminalCompatibilitySunsetPolicy } from './cleanupFence';

describe('terminal cleanup source-tree fence', () => {
  it('passes the canonical source tree while allowing only the named release-window schema', () => {
    expect(validateTerminalCleanupSourceTree()).toEqual([]);
  });

  it('is wired into the canonical policy lane', () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
    const packageJson = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(packageJson.scripts['test:policy']).toContain('packages/tests/src/testkit/terminal/cleanupFence.ts');
  });

  it('requires a named compatibility release and distinct removal release', () => {
    expect(validateTerminalCompatibilitySunsetPolicy()).toEqual([]);
  });

  it('fails closed when the app reaches the removal release while legacy compatibility remains', () => {
    expect(validateTerminalCompatibilitySunsetPolicy('0.3.0')).toEqual([
      expect.objectContaining({ rule: 'legacy-sunset-policy' }),
    ]);
  });

  it('keeps TERM packet body markers aligned with ledger and manifest status', () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
    const manifest = JSON.parse(readFileSync(resolve(repoRoot, '.project/plans/runtime-unification-v2/execution/packet-manifest.json'), 'utf8')) as {
      packets: Record<string, { status: string; packet_body: string }>;
    };
    const ledgerLines = readFileSync(resolve(repoRoot, '.project/plans/runtime-unification-v2/execution/packet-ledger.tsv'), 'utf8').trim().split('\n');
    const ledger = new Map(ledgerLines.slice(1).map((line) => {
      const columns = line.split('\t');
      return [columns[0], columns[5]] as const;
    }));
    for (const packetId of ['TERM-1', 'TERM-2', 'TERM-3', 'TERM-4', 'TERM-5', 'TERM-6', 'TERM-7a', 'TERM-7b']) {
      const packet = manifest.packets[packetId]!;
      const bodyPath = packet.packet_body.replace('[TARGET]', '');
      const body = readFileSync(resolve(repoRoot, bodyPath), 'utf8');
      const bodyStatus = /^> Status: `([^`]+)`/m.exec(body)?.[1];
      expect(bodyStatus, packetId).toBe(ledger.get(packetId));
      expect(packet.status, packetId).toBe(ledger.get(packetId));
    }
  });
});
